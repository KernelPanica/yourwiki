import { createHash, randomUUID } from 'node:crypto';
import type { Database } from './database.ts';
import { transaction } from './database.ts';
import type { BlobStore, BlobRef } from './storage/blobs.ts';
import { BlobTooLargeError } from './storage/blobs.ts';
import { DocumentService } from './documents.ts';

export type UploadMetadata = { size: number } & (
  { mode: 'create'; title: string; format: string; parentId: string | null; groupId?: string } |
  { mode: 'save'; documentId: string; baseRevision: number }
);
export type UploadResult = { documentId: string; revision: number; jobId: string };
type Row = { id: string; owner_id: string; metadata: string; size: number; chunk_bytes: number; offset: number; state: string; expires_at: number; result: string | null };
export class UploadError extends Error { code: string; constructor(code: string) { super(code); this.code = code; } }
interface Options { maxFileBytes?: number; maxPendingBytes?: number; chunkBytes?: number; ttlMs?: number; clock?: () => number }

export class ResumableUploads {
  private db: Database; private store: BlobStore; private documents: DocumentService;
  private maxFile: number; private maxPending: number; private chunkBytes: number; private ttl: number; private clock: () => number;
  constructor(db: Database, store: BlobStore, options: Options = {}) {
    this.db = db; this.store = store; this.maxFile = options.maxFileBytes ?? 4 * 1024 ** 3;
    this.maxPending = options.maxPendingBytes ?? 8 * 1024 ** 3; this.chunkBytes = options.chunkBytes ?? 8 * 1024 ** 2;
    this.ttl = options.ttlMs ?? 24 * 3600_000; this.clock = options.clock ?? Date.now;
    for (const value of [this.maxFile, this.maxPending, this.chunkBytes, this.ttl]) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid upload limit');
    this.documents = new DocumentService(db, store, { maxBytes: this.maxFile, clock: this.clock });
  }
  private actor(userId: string): void {
    if (!this.db.prepare('SELECT 1 FROM users WHERE id=? AND active=1').get(userId)) throw new UploadError('ACCESS_DENIED');
  }
  private check(userId: string, metadata: UploadMetadata): void {
    this.actor(userId);
    if (metadata.mode === 'create') this.documents.checkCreate({ ...metadata, userId });
    else if (metadata.mode === 'save') this.documents.checkSave({ ...metadata, userId });
    else throw new UploadError('INVALID_REQUEST');
  }
  private row(userId: string, id: string, active = false): Row {
    this.actor(userId);
    const row = this.db.prepare('SELECT * FROM uploads WHERE id=? AND owner_id=?').get(id, userId) as Row | undefined;
    if (!row) throw new UploadError('NOT_FOUND');
    if (active) {
      if (row.state === 'expired' || row.expires_at <= this.clock()) throw new UploadError('UPLOAD_EXPIRED');
      if (row.state !== 'active') throw new UploadError('UPLOAD_CLOSED');
      this.check(userId, JSON.parse(row.metadata));
    }
    return row;
  }
  private view(row: Row) {
    return { id: row.id, size: row.size, offset: row.offset, state: row.state, expiresAt: row.expires_at, chunkBytes: row.chunk_bytes,
      result: row.result ? JSON.parse(row.result) as UploadResult : null };
  }
  create(userId: string, value: UploadMetadata) {
    // Snapshot caller data before any transaction can retain mutable references.
    const copied = JSON.parse(JSON.stringify(value)) as UploadMetadata;
    const metadata:UploadMetadata = copied.mode==='save'?{mode:'save',size:copied.size,documentId:copied.documentId,baseRevision:copied.baseRevision}:copied.mode==='create'?{mode:'create',size:copied.size,title:copied.title,format:copied.format,parentId:copied.parentId,groupId:copied.groupId}:copied;
    if (!Number.isSafeInteger(metadata.size) || metadata.size < 0) throw new UploadError('INVALID_REQUEST');
    if (metadata.size > Math.min(this.maxFile,(this.db.prepare('SELECT document_limit_bytes FROM administration_state WHERE id=1').get() as {document_limit_bytes:number}).document_limit_bytes)) throw new BlobTooLargeError();
    if (Math.ceil(metadata.size / this.chunkBytes) > 4096) throw new UploadError('TOO_MANY_CHUNKS');
    return transaction(this.db, () => {
      this.check(userId, metadata);
      const now = this.clock();
      const reserved = this.db.prepare("SELECT COALESCE(SUM(size),0) AS bytes,COUNT(*) AS n FROM uploads WHERE cleanup_at IS NULL").get() as { bytes: number; n: number };
      const own = this.db.prepare("SELECT COUNT(*) AS n FROM uploads WHERE owner_id=? AND state='active' AND expires_at>?").get(userId, now) as { n: number };
      if (metadata.size > this.maxPending - reserved.bytes || own.n >= 3 || reserved.n >= 45) throw new UploadError('UPLOAD_QUOTA_EXCEEDED');
      const id = randomUUID();
      this.db.prepare('INSERT INTO uploads(id,owner_id,metadata,size,chunk_bytes,expires_at,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(id, userId, JSON.stringify(metadata), metadata.size, this.chunkBytes, now + this.ttl, now);
      return this.status(userId, id);
    });
  }
  status(userId: string, id: string) { return this.view(this.row(userId, id)); }

  async append(userId: string, id: string, offset: number, source: AsyncIterable<Uint8Array>, signal?: AbortSignal) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new UploadError('INVALID_REQUEST');
    const token = randomUUID(), leaseMs = 30_000;
    const initial = transaction(this.db, () => {
      const row = this.row(userId, id, true);
      const previous = this.db.prepare('SELECT digest,size FROM upload_chunks WHERE upload_id=? AND offset=?').get(id, offset) as BlobRef | undefined;
      if (offset > row.offset || (offset < row.offset && !previous)) throw new UploadError('OFFSET_MISMATCH');
      if (offset === row.size) throw new UploadError('UPLOAD_INCOMPLETE');
      const lease = this.db.prepare('UPDATE uploads SET lease_token=?,lease_until=? WHERE id=? AND (lease_token IS NULL OR lease_until<=?)')
        .run(token, this.clock() + leaseMs, id, this.clock());
      if (lease.changes !== 1) throw new UploadError('UPLOAD_BUSY');
      return row;
    });
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const heartbeat = setInterval(() => {
      try {
        const now = this.clock();
        if (this.db.prepare("UPDATE uploads SET lease_until=? WHERE id=? AND lease_token=? AND lease_until>? AND state='active' AND expires_at>?")
          .run(now + leaseMs, id, token, now, now).changes !== 1) controller.abort();
      } catch { controller.abort(); }
    }, leaseMs / 3);
    const deadline = setTimeout(() => controller.abort(), 5 * 60_000);
    let temporary: BlobStore | undefined, retained = false;
    try {
      temporary = await this.store.uploadStore(id);
      const chunks = await temporary.uploadStore(token);
      const blob = await chunks.put(source, { maxBytes: Math.min(initial.chunk_bytes, initial.size - offset), signal: combined });
      if (blob.size === 0) throw new UploadError('EMPTY_CHUNK');
      if (blob.size !== Math.min(initial.chunk_bytes, initial.size - offset)) throw new UploadError('CHUNK_SIZE_MISMATCH');
      return transaction(this.db, () => {
        combined.throwIfAborted();
        const current = this.row(userId, id, true);
        if (!this.db.prepare('SELECT 1 FROM uploads WHERE id=? AND lease_token=? AND lease_until>?').get(id, token, this.clock())) throw new UploadError('UPLOAD_BUSY');
        const existing = this.db.prepare('SELECT digest,size FROM upload_chunks WHERE upload_id=? AND offset=?').get(id, offset) as BlobRef | undefined;
        if (existing) {
          if (existing.digest !== blob.digest || existing.size !== blob.size) throw new UploadError('CHUNK_CONFLICT');
          return this.view(current);
        }
        if (current.offset !== offset) throw new UploadError('OFFSET_MISMATCH');
        this.db.prepare('INSERT INTO upload_chunks(upload_id,offset,digest,size,storage_id) VALUES(?,?,?,?,?)').run(id, offset, blob.digest, blob.size, token);
        this.db.prepare('UPDATE uploads SET offset=offset+? WHERE id=?').run(blob.size, id);
        retained = true;
        return this.status(userId, id);
      });
    } catch (error) {
      if (combined.aborted) throw new UploadError('UPLOAD_INTERRUPTED');
      throw error;
    } finally {
      clearInterval(heartbeat); clearTimeout(deadline);
      this.db.prepare('UPDATE uploads SET lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?').run(id, token);
      if (!retained && temporary) await temporary.removeUpload(token);
    }
  }

  async finish(userId: string, id: string, signal?: AbortSignal): Promise<UploadResult> {
    const token = randomUUID(), leaseMs = 30_000;
    const acquired = transaction(this.db, () => {
      const row = this.row(userId, id);
      if (row.state === 'completed') return { result: JSON.parse(row.result!) as UploadResult };
      this.row(userId, id, true);
      if (row.offset !== row.size) throw new UploadError('UPLOAD_INCOMPLETE');
      if (this.db.prepare('UPDATE uploads SET lease_token=?,lease_until=? WHERE id=? AND (lease_token IS NULL OR lease_until<=?)')
        .run(token, this.clock() + leaseMs, id, this.clock()).changes !== 1) throw new UploadError('UPLOAD_BUSY');
      return { row };
    });
    if (acquired.result) return acquired.result;
    const row = acquired.row!;
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const heartbeat = setInterval(() => {
      try {
        const now = this.clock();
        if (this.db.prepare("UPDATE uploads SET lease_until=? WHERE id=? AND lease_token=? AND lease_until>? AND state='active' AND expires_at>?")
          .run(now + leaseMs, id, token, now, now).changes !== 1) controller.abort();
      } catch { controller.abort(); }
    }, leaseMs / 3);
    const deadline = setTimeout(() => controller.abort(), 3600_000);
    try {
      const receipts = this.db.prepare('SELECT offset,digest,size,storage_id FROM upload_chunks WHERE upload_id=? ORDER BY offset').all(id) as (BlobRef & { offset: number; storage_id: string })[];
      let expected = 0;
      for (const chunk of receipts) { if (chunk.offset !== expected) throw new UploadError('UPLOAD_INCOMPLETE'); expected += chunk.size; }
      if (expected !== row.size) throw new UploadError('UPLOAD_INCOMPLETE');
      const temporary = await this.store.uploadStore(id);
      async function* assembled() {
        for (const chunk of receipts) {
          const part = await temporary.uploadStore(chunk.storage_id), hash = createHash('sha256');
          let size = 0;
          for await (const bytes of await part.read(chunk.digest)) { size += bytes.length; hash.update(bytes); yield bytes; }
          if (size !== chunk.size || hash.digest('hex') !== chunk.digest) throw new UploadError('UPLOAD_CORRUPT');
        }
      }
      let blob: BlobRef;
      try { blob = await this.store.put(assembled(), { maxBytes: row.size, signal: combined }); }
      catch (error) {
        const latest = this.row(userId, id);
        if (latest.state === 'completed') return JSON.parse(latest.result!);
        throw error;
      }
      if (blob.size !== row.size) throw new UploadError('UPLOAD_INCOMPLETE');
      // All filesystem work happens before this short atomic commit. A repeated
      // finish observes the receipt even if its HTTP acknowledgement was lost.
      return transaction(this.db, () => {
        const fresh = this.row(userId, id);
        if (fresh.state === 'completed') return JSON.parse(fresh.result!) as UploadResult;
        this.row(userId, id, true); combined.throwIfAborted();
        if (!this.db.prepare('SELECT 1 FROM uploads WHERE id=? AND lease_token=? AND lease_until>?').get(id, token, this.clock())) throw new UploadError('UPLOAD_BUSY');
        const metadata = JSON.parse(fresh.metadata) as UploadMetadata;
        const committed = metadata.mode === 'create'
          ? this.documents.commitPreparedCreate({ ...metadata, userId, signal: combined }, blob)
          : this.documents.commitPreparedSave({ ...metadata, userId, signal: combined }, blob);
        const result = { documentId: committed.documentId, revision: committed.revision, jobId: committed.jobId };
        this.db.prepare("UPDATE uploads SET state='completed',result=? WHERE id=?").run(JSON.stringify(result), id);
        return result;
      });
    } catch (error) {
      if (combined.aborted) throw new UploadError('UPLOAD_INTERRUPTED');
      throw error;
    } finally {
      clearInterval(heartbeat); clearTimeout(deadline);
      this.db.prepare('UPDATE uploads SET lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?').run(id, token);
    }
  }

  async cancel(userId: string, id: string): Promise<void> {
    transaction(this.db, () => {
      const row = this.row(userId, id);
      if (row.state === 'completed') throw new UploadError('UPLOAD_CLOSED');
      this.db.prepare("UPDATE uploads SET state='cancelled' WHERE id=?").run(id);
    });
    await this.store.removeUpload(id);
    this.db.prepare('DELETE FROM upload_chunks WHERE upload_id=?').run(id);
    this.db.prepare('UPDATE uploads SET cleanup_at=? WHERE id=? AND lease_token IS NULL').run(this.clock(), id);
  }
  async cleanupExpired(): Promise<void> {
    this.db.prepare("UPDATE uploads SET state='expired' WHERE state='active' AND expires_at<=?").run(this.clock());
    const rows = this.db.prepare("SELECT id FROM uploads WHERE state IN ('cancelled','expired','completed') AND cleanup_at IS NULL AND (lease_token IS NULL OR lease_until<=?)").all(this.clock()) as { id: string }[];
    for (const { id } of rows) {
      await this.store.removeUpload(id);
      this.db.prepare('DELETE FROM upload_chunks WHERE upload_id=?').run(id);
      this.db.prepare('UPDATE uploads SET cleanup_at=? WHERE id=?').run(this.clock(), id);
    }
  }
}
