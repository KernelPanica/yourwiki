import {capturePdfHistory} from './history-capture.ts';
import { randomUUID } from 'node:crypto';
import { AccessService } from './access.ts';
import { transaction, type Database } from './database.ts';
import { DocumentService, DocumentError } from './documents.ts';
import type { BlobStore } from './storage/blobs.ts';

type Layer = { revision: number; base_revision: number; digest: string; size: number };
type Input = { userId: string; documentId: string; baseRevision: number; layerRevision: number; replaceStaleLayer?: boolean; signal?: AbortSignal };
/** Derived PDFs retain PDF.js forms and annotations; original blobs are never replaced. */
export class PdfLayerService {
  private access: AccessService;
  private documents: DocumentService;
  private maxBytes: number;
  private db: Database;
  private store: BlobStore;
  constructor(db: Database, store: BlobStore, options: { maxBytes?: number } = {}) {
    this.db = db; this.store = store;
    this.access = new AccessService(db);
    this.documents = new DocumentService(db, store);
    this.maxBytes = options.maxBytes ?? 4 * 1024 ** 3;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) throw new Error('Invalid file size limit');
  }
  state(userId: string, documentId: string) {
    if (!this.documents.processingStatus(userId, documentId)) return null;
    const doc = this.db.prepare('SELECT format,local_revision FROM documents WHERE id=?').get(documentId) as { format: string; local_revision: number };
    if (doc.format !== 'pdf') return null;
    const layer = this.db.prepare('SELECT revision,base_revision,digest,size FROM pdf_layer_versions WHERE document_id=? ORDER BY revision DESC LIMIT 1').get(documentId) as Layer | undefined;
    return { baseRevision: doc.local_revision, layerRevision: layer?.revision ?? 0,
      state: layer && layer.base_revision !== doc.local_revision ? 'conflict' as const : 'saved' as const,
      layer: layer ? { digest: layer.digest, size: layer.size, baseRevision: layer.base_revision } : null };
  }
  private writable(input: Input) {
    const state = this.state(input.userId, input.documentId);
    if (!state) throw new DocumentError('NOT_FOUND');
    if (!this.access.allows(input.userId, input.documentId, 'write')) throw new DocumentError('ACCESS_DENIED');
    return state;
  }
  async save(input: Input, source: AsyncIterable<Uint8Array>) {
    input = { ...input }; // Pin identity and optimistic revisions across streamed I/O.
    if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 1 || !Number.isSafeInteger(input.layerRevision) || input.layerRevision < 0) throw new DocumentError('INVALID_REQUEST');
    this.writable(input);
    // Keep fully received conflict copies, even when the client's version was stale before upload.
    const blob = await this.store.put(source, { maxBytes: this.maxBytes, signal: input.signal });
    try {
      return transaction(this.db, () => {
        input.signal?.throwIfAborted();
        const state = this.writable(input);
        if (state.baseRevision !== input.baseRevision || state.layerRevision !== input.layerRevision || (state.state === 'conflict' && !input.replaceStaleLayer)) throw new DocumentError('CONFLICT');
        const layerRevision = state.layerRevision + 1;
        capturePdfHistory(this.db,input.documentId,input.userId,blob.digest,Date.now());
        this.db.prepare('INSERT INTO pdf_layer_versions(document_id,revision,base_revision,digest,size,author_id,created_at) VALUES(?,?,?,?,?,?,?)')
          .run(input.documentId, layerRevision, input.baseRevision, blob.digest, blob.size, input.userId, Date.now());
        this.db.prepare('INSERT INTO events(kind,document_id,payload,created_at) VALUES(?,?,?,?)')
          .run('pdf.layer.saved', input.documentId, JSON.stringify({ baseRevision: input.baseRevision, layerRevision }), Date.now());
        return { ...blob, baseRevision: input.baseRevision, layerRevision };
      });
    } catch (error) {
      const recoveryId = randomUUID(), reason = error instanceof DocumentError ? error.code : 'SAVE_FAILED';
      this.db.prepare('INSERT INTO recovery_copies(id,document_id,intended_document_id,author_id,digest,size,reason,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(recoveryId, input.documentId, input.documentId, input.userId, blob.digest, blob.size, reason, Date.now());
      throw new DocumentError(reason, recoveryId);
    }
  }
}
