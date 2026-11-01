import {requestSourceDelivery,assertSourceDeliveryWritable} from './providers/delivery-requests.ts';
import {DocumentError} from './document-errors.ts';
import {captureSourceHistory} from './history-capture.ts';
import {officeWriteAllowed} from './office/fence.ts';
import { randomUUID } from 'node:crypto';
import { AccessService } from './access.ts';
import { transaction } from './database.ts';
import type { Database } from './database.ts';
import { JobQueue } from './jobs.ts';
import type { ClaimedJob } from './jobs.ts';
import type { BlobRef, BlobStore } from './storage/blobs.ts';

export interface PreviewArtifact extends BlobRef { name: string; mimeType: string }
export interface PreviewManifest {
  schemaVersion: 1; documentId: string; revision: number; sourceDigest: string;
  converterVersion: string; kind: 'document' | 'table' | 'presentation' | 'pdf' | 'canvas' | 'drawio' | 'file';
  primary: string; artifacts: PreviewArtifact[];
}
export {DocumentError} from './document-errors.ts';
type Doc = { id: string; title: string; format: string; local_revision: number; published_revision: number | null; provider_revision: number | null };
type Actor = { active: number; admin_role: string };
type CreateInput = { userId: string; parentId: string | null; groupId?: string; title: string; format: string; signal?: AbortSignal };
type SaveInput = { officeSessionId?: string; userId: string; documentId: string; baseRevision: number; signal?: AbortSignal };

export class DocumentService {
  private db: Database; private store: BlobStore; private queue: JobQueue; private access: AccessService;
  private clock: () => number; private maxBytes: number; private converterVersion: string;
  constructor(db: Database, store: BlobStore, options: { clock?: () => number; maxBytes?: number; converterVersion?: string } = {}) {
    this.db = db; this.store = store; this.clock = options.clock ?? Date.now;
    this.maxBytes = options.maxBytes ?? 4 * 1024 ** 3;
    this.converterVersion = options.converterVersion ?? 'preview-v2';
    if (!this.converterVersion || this.converterVersion.length > 128) throw new Error('Invalid converter version');
    this.queue = new JobQueue(db); this.access = new AccessService(db);
  }

  private actor(userId: string): Actor {
    const actor = this.db.prepare('SELECT active,admin_role FROM users WHERE id=?').get(userId) as Actor | undefined;
    if (!actor?.active) throw new DocumentError('ACCESS_DENIED');
    return actor;
  }
  private destination(input: CreateInput): string {
    const actor = this.actor(input.userId);
    if (input.parentId !== null) {
      const parent = this.db.prepare('SELECT kind,group_id FROM resources WHERE id=?').get(input.parentId) as { kind: string; group_id: string } | undefined;
      if (!parent || parent.kind !== 'folder' || !this.access.allows(input.userId, input.parentId, 'read')) throw new DocumentError('NOT_FOUND');
      if (!this.access.allows(input.userId, input.parentId, 'write')) throw new DocumentError('ACCESS_DENIED');
      return parent.group_id;
    }
    if (!input.groupId || !this.db.prepare('SELECT id FROM groups WHERE id=?').get(input.groupId)) throw new DocumentError('ACCESS_DENIED');
    if (actor.admin_role === 'member' && !this.db.prepare('SELECT user_id FROM memberships WHERE user_id=? AND group_id=?').get(input.userId, input.groupId)) throw new DocumentError('ACCESS_DENIED');
    return input.groupId;
  }
  private draftVisible(userId: string, documentId: string, published: number | null): boolean {
    if (published !== null) return true;
    const owner = this.db.prepare('SELECT owner_id FROM resources WHERE id=?').get(documentId) as { owner_id: string } | undefined;
    return owner?.owner_id === userId || this.actor(userId).admin_role !== 'member';
  }
  private writable(input: SaveInput): Doc {
    const doc = this.db.prepare('SELECT * FROM documents WHERE id=?').get(input.documentId) as Doc | undefined;
    if (!doc || !this.access.allows(input.userId, input.documentId, 'read') || !this.draftVisible(input.userId, doc.id, doc.published_revision)) throw new DocumentError('NOT_FOUND');
    if (!this.access.allows(input.userId, input.documentId, 'write')) throw new DocumentError('ACCESS_DENIED');
    if (doc.local_revision !== input.baseRevision) throw new DocumentError('CONFLICT');
    assertSourceDeliveryWritable(this.db,doc.id,this.clock());
    if (!officeWriteAllowed(this.db,doc.id,input.officeSessionId,this.clock())) throw new DocumentError('OFFICE_ACTIVE');
    return doc;
  }
  private stageVersion(id: string, revision: number, userId: string, blob: BlobRef): string {
    // Collabora uses LastModifiedTime as a save precondition. Keep it unique
    // even when saves share one millisecond or the system clock moves back.
    const previous = this.db.prepare('SELECT created_at FROM document_versions WHERE document_id=? ORDER BY revision DESC LIMIT 1').get(id) as {created_at:number} | undefined;
    const now = previous ? Math.max(this.clock(), previous.created_at + 1) : this.clock();
    captureSourceHistory(this.db,id,userId,blob.digest,now);
    this.db.prepare('INSERT INTO document_versions(document_id,revision,digest,size,author_id,created_at) VALUES(?,?,?,?,?,?)')
      .run(id, revision, blob.digest, blob.size, userId, now);
    this.db.prepare('UPDATE documents SET local_revision=? WHERE id=?').run(revision, id);
    requestSourceDelivery(this.db,id,revision,now);
    return this.stagePreview(id, revision);
  }
  private stagePreview(id: string, revision: number): string {
    this.db.prepare('UPDATE documents SET preview_generation=preview_generation+1 WHERE id=?').run(id);
    const row = this.db.prepare('SELECT preview_generation FROM documents WHERE id=?').get(id) as { preview_generation: number };
    const jobId = this.queue.enqueue({ kind: 'preview.prepare', key: `${id}:${revision}:${row.preview_generation}`,
      payload: { documentId: id, revision, converterVersion: this.converterVersion } }, this.clock());
    this.db.prepare('UPDATE documents SET preview_job_id=? WHERE id=?').run(jobId, id);
    return jobId;
  }

  requestPreview(userId: string, documentId: string): { jobId: string } {
    return transaction(this.db, () => {
      const row = this.db.prepare('SELECT local_revision,published_revision FROM documents WHERE id=?').get(documentId) as { local_revision: number; published_revision: number | null } | undefined;
      if (!row || !this.access.allows(userId, documentId, 'read') || !this.draftVisible(userId, documentId, row.published_revision)) throw new DocumentError('NOT_FOUND');
      if (!this.access.allows(userId, documentId, 'write')) throw new DocumentError('ACCESS_DENIED');
      return { jobId: this.stagePreview(documentId, row.local_revision) };
    });
  }
  private retain(id: string, userId: string, blob: BlobRef, error: unknown): never {
    const recoveryId = randomUUID();
    const reason = error instanceof DocumentError ? error.code : 'SAVE_FAILED';
    const existing = this.db.prepare('SELECT id FROM documents WHERE id=?').get(id);
    const author = this.db.prepare('SELECT id FROM users WHERE id=?').get(userId);
    this.db.prepare('INSERT INTO recovery_copies(id,document_id,intended_document_id,author_id,digest,size,reason,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(recoveryId, existing ? id : null, id, author ? userId : null, blob.digest, blob.size, reason, this.clock());
    throw new DocumentError(reason, recoveryId);
  }

  checkCreate(input: CreateInput): void {
    const title = input.title.trim();
    if (!title || title.length > 200 || /[\x00-\x1f]/.test(title) || !/^[a-z0-9][a-z0-9.-]{0,31}$/.test(input.format)) throw new DocumentError('INVALID_REQUEST');
    this.destination(input);
  }
  checkSave(input: SaveInput): void {
    if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0) throw new DocumentError('INVALID_REQUEST');
    this.writable(input);
  }
  private prepared(blob: BlobRef): void {
    if (!/^[a-f0-9]{64}$/.test(blob.digest) || !Number.isSafeInteger(blob.size) || blob.size < 0 || blob.size > this.maxBytes) throw new DocumentError('INVALID_REQUEST');
  }
  /** Internal commit API: caller must have durably stored/verified this BlobRef. */
  commitPreparedCreate(input: CreateInput, blob: BlobRef, id = randomUUID()) {
    return transaction(this.db, () => {
      this.prepared(blob); this.checkCreate(input); input.signal?.throwIfAborted();
      const group = this.destination(input);
      this.db.prepare("INSERT INTO resources(id,kind,parent_id,owner_id,group_id) VALUES(?,'document',?,?,?)").run(id, input.parentId, input.userId, group);
      this.db.prepare('INSERT INTO documents(id,title,format,created_at) VALUES(?,?,?,?)').run(id, input.title.trim(), input.format, this.clock());
      const jobId = this.stageVersion(id, 1, input.userId, blob);
      return { documentId: id, revision: 1, jobId, blob };
    });
  }
  /** Internal commit API: caller must have durably stored/verified this BlobRef. */
  commitPreparedSave(input: SaveInput, blob: BlobRef) {
    return transaction(this.db, () => {
      this.prepared(blob); this.checkSave(input); input.signal?.throwIfAborted();
      const doc = this.writable(input), revision = doc.local_revision + 1;
      const jobId = this.stageVersion(doc.id, revision, input.userId, blob);
      return { documentId: doc.id, revision, jobId, blob };
    });
  }

  async create(input: CreateInput, source: AsyncIterable<Uint8Array>) {
    this.checkCreate(input);
    const id = randomUUID();
    const blob = await this.store.put(source, { maxBytes: this.maxBytes, signal: input.signal });
    try { return this.commitPreparedCreate(input, blob, id); }
    catch (error) { return this.retain(id, input.userId, blob, error); }
  }

  async save(input: SaveInput, source: AsyncIterable<Uint8Array>) {
    this.checkSave(input);
    const blob = await this.store.put(source, { maxBytes: this.maxBytes, signal: input.signal });
    try { return this.commitPreparedSave(input, blob); }
    catch (error) { return this.retain(input.documentId, input.userId, blob, error); }
  }

  getPublished(userId: string, documentId: string) {
    if (!this.access.allows(userId, documentId, 'read')) return null;
    return this.db.prepare(`SELECT d.id,d.title,d.format,p.revision,p.manifest_digest AS manifestDigest,p.converter_version AS converterVersion,
      d.local_revision AS localRevision,d.provider_revision AS providerRevision
      FROM documents d JOIN previews p ON p.document_id=d.id AND p.revision=d.published_revision WHERE d.id=?`).get(documentId) as
      { id: string; title: string; format: string; revision: number; manifestDigest: string; converterVersion: string; localRevision: number; providerRevision: number | null } | undefined ?? null;
  }

  processingStatus(userId: string, documentId: string) {
    if (!this.access.allows(userId, documentId, 'read')) return null;
    const row = this.db.prepare(`SELECT d.*,r.owner_id,u.admin_role FROM documents d JOIN resources r ON r.id=d.id
      JOIN users u ON u.id=? WHERE d.id=?`).get(userId, documentId) as (Doc & { owner_id: string; admin_role: string }) | undefined;
    if (!row || (row.published_revision === null && row.owner_id !== userId && row.admin_role === 'member')) return null;
    const job = this.db.prepare('SELECT state,error_code FROM jobs WHERE id=(SELECT preview_job_id FROM documents WHERE id=?)').get(documentId) as { state: string; error_code: string | null } | undefined;
    const state = row.published_revision === row.local_revision && job?.state === 'succeeded' ? 'ready' : job?.state === 'failed' ? 'failed' : job?.state === 'running' ? 'preparing' : 'queued';
    return { documentId, localRevision: row.local_revision, publishedRevision: row.published_revision, state, errorCode: job?.error_code ?? null };
  }

  async publish(claim: ClaimedJob, value: PreviewManifest): Promise<'published' | 'superseded'> {
    // Snapshot the manifest before async verification; caller mutation cannot
    // swap the references that were verified for different published references.
    let manifest: PreviewManifest;
    try {
      const encoded = JSON.stringify(value);
      if (Buffer.byteLength(encoded) > 1024 * 1024) throw new Error();
      manifest = JSON.parse(encoded);
    } catch { throw new DocumentError('INVALID_PREVIEW'); }
    this.validateManifest(manifest);
    this.assertClaim(claim, manifest);
    const source = this.db.prepare('SELECT digest,size FROM document_versions WHERE document_id=? AND revision=?')
      .get(manifest.documentId, manifest.revision) as BlobRef | undefined;
    if (!source || source.digest !== manifest.sourceDigest || !await this.store.verify(source)) throw new DocumentError('INVALID_PREVIEW');
    for (const asset of manifest.artifacts) if (!await this.store.verify(asset)) throw new DocumentError('INVALID_PREVIEW');
    const encoded = Buffer.from(JSON.stringify(manifest));
    const ref = await this.store.put((async function* () { yield encoded; })(), { maxBytes: 1024 * 1024 });
    return transaction(this.db, () => {
      this.assertClaim(claim, manifest);
      const doc = this.db.prepare('SELECT d.local_revision,d.preview_job_id,r.trashed FROM documents d JOIN resources r ON r.id=d.id WHERE d.id=?').get(manifest.documentId) as { local_revision: number; preview_job_id: string; trashed: number } | undefined;
      if (!doc || doc.trashed || doc.local_revision !== manifest.revision || doc.preview_job_id !== claim.id) {
        if (!this.queue.complete(claim, this.clock())) throw new DocumentError('LEASE_LOST');
        return 'superseded';
      }
      this.db.prepare('INSERT OR IGNORE INTO preview_manifests(manifest_digest,document_id,revision,converter_version,created_at) VALUES(?,?,?,?,?)')
        .run(ref.digest, manifest.documentId, manifest.revision, manifest.converterVersion, this.clock());
      this.db.prepare(`INSERT INTO previews(document_id,revision,manifest_digest,converter_version,created_at) VALUES(?,?,?,?,?)
        ON CONFLICT(document_id,revision) DO UPDATE SET manifest_digest=excluded.manifest_digest,converter_version=excluded.converter_version,created_at=excluded.created_at`)
        .run(manifest.documentId, manifest.revision, ref.digest, manifest.converterVersion, this.clock());
      this.db.prepare('UPDATE documents SET published_revision=? WHERE id=?').run(manifest.revision, manifest.documentId);
      this.db.prepare("INSERT INTO events(kind,document_id,payload,created_at) VALUES('preview.published',?,?,?)")
        .run(manifest.documentId, JSON.stringify({ documentId: manifest.documentId, revision: manifest.revision, manifestDigest: ref.digest, converterVersion: manifest.converterVersion }), this.clock());
      if (!this.queue.complete(claim, this.clock())) throw new DocumentError('LEASE_LOST');
      return 'published';
    });
  }

  private assertClaim(claim: ClaimedJob, manifest: PreviewManifest): void {
    if (!this.queue.owns(claim, this.clock())) throw new DocumentError('LEASE_LOST');
    const job = this.queue.status(claim.id)!;
    if (job.kind !== 'preview.prepare' || job.payload.documentId !== manifest.documentId || job.payload.revision !== manifest.revision || job.payload.converterVersion !== manifest.converterVersion) throw new DocumentError('INVALID_PREVIEW');
  }
  private validateManifest(value: PreviewManifest): void {
    if (!value || value.schemaVersion !== 1 || typeof value.documentId !== 'string' || !Number.isSafeInteger(value.revision) || value.revision < 1
      || !/^[a-f0-9]{64}$/.test(value.sourceDigest) || typeof value.converterVersion !== 'string' || !value.converterVersion || value.converterVersion.length > 128
      || !['document','table','presentation','pdf','canvas','drawio','file'].includes(value.kind) || !Array.isArray(value.artifacts) || !value.artifacts.length || value.artifacts.length > 10000) throw new DocumentError('INVALID_PREVIEW');
    const names = new Set<string>();
    for (const asset of value.artifacts) {
      if (!asset || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(asset.name) || names.has(asset.name) || !/^[a-f0-9]{64}$/.test(asset.digest)
        || !Number.isSafeInteger(asset.size) || asset.size < 0 || typeof asset.mimeType !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(asset.mimeType)) throw new DocumentError('INVALID_PREVIEW');
      names.add(asset.name);
    }
    if (!names.has(value.primary)) throw new DocumentError('INVALID_PREVIEW');
  }
}
