import { randomUUID } from 'node:crypto';
import { transaction } from '../database.ts';
import type { Database } from '../database.ts';
import type { BlobStore, BlobRef } from '../storage/blobs.ts';
import { DocumentService, DocumentError } from '../documents.ts';
import { JobQueue } from '../jobs.ts';
import { convert, ConversionError } from './conversion.ts';
import type { ConversionOptions } from './conversion.ts';
import { setTimeout as delay } from 'node:timers/promises';

export interface WorkerOptions extends ConversionOptions { leaseMs?: number }
/** A dedicated process executes one conversion at a time. */
export class PreviewWorker {
  private db: Database; private store: BlobStore; private queue: JobQueue; private documents: DocumentService;
  private options: WorkerOptions; private busy = false;
  constructor(db: Database, store: BlobStore, options: WorkerOptions = {}) {
    this.db = db; this.store = store; this.queue = new JobQueue(db); this.documents = new DocumentService(db, store);
    for (const key of ['textLimit','outputLimit','timeoutMs','leaseMs'] as const) {
      const value = options[key];
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error('Invalid worker option: ' + key);
    }
    if (options.leaseMs !== undefined && (options.leaseMs < 30 || options.leaseMs > 3600_000)) throw new Error('Invalid worker lease');
    this.options = options;
  }
  async runOnce(signal?: AbortSignal): Promise<'idle' | 'published' | 'superseded' | 'failed' | 'interrupted'> {
    if (this.busy) throw new Error('Worker is already running');
    signal?.throwIfAborted();
    const leaseMs = this.options.leaseMs ?? 30_000;
    const slotToken = randomUUID();
    const claim = transaction(this.db, () => {
      const now = Date.now();
      const occupied = this.db.prepare("SELECT 1 FROM worker_slots WHERE name='preview' AND lease_until>?").get(now);
      if (occupied) return null;
      const job = this.queue.claim(now, leaseMs, 'preview.prepare');
      if (!job) return null;
      this.db.prepare("INSERT INTO worker_slots(name,token,lease_until) VALUES('preview',?,?) ON CONFLICT(name) DO UPDATE SET token=excluded.token,lease_until=excluded.lease_until").run(slotToken, now + leaseMs);
      return job;
    });
    if (!claim) return 'idle';
    this.busy = true;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const heartbeat = setInterval(() => {
      try {
        const renewed = transaction(this.db, () => {
          const now = Date.now();
          if (!this.queue.owns(claim, now)) return false;
          const changed = this.db.prepare("UPDATE worker_slots SET lease_until=? WHERE name='preview' AND token=? AND lease_until>?").run(now + leaseMs, slotToken, now).changes;
          return changed === 1 && this.queue.renew(claim, now, leaseMs);
        });
        if (!renewed) abort();
      } catch { abort(); }
    }, Math.floor(leaseMs / 3));
    try {
      const { documentId, revision, converterVersion } = claim.payload;
      if (typeof documentId !== 'string' || !Number.isSafeInteger(revision) || (revision as number) < 1) throw new ConversionError('INVALID_PREVIEW_JOB');
      if (converterVersion !== 'preview-v1') throw new ConversionError('CONVERTER_UNAVAILABLE');
      const row = this.db.prepare(`SELECT v.digest,v.size,d.format,d.local_revision,d.preview_job_id,r.trashed
        FROM documents d JOIN document_versions v ON v.document_id=d.id AND v.revision=? JOIN resources r ON r.id=d.id WHERE d.id=?`).get(revision, documentId) as
        (BlobRef & { format: string; local_revision: number; preview_job_id: string; trashed: number }) | undefined;
      if (!row || row.trashed || row.local_revision !== revision || row.preview_job_id !== claim.id) {
        if (!this.queue.complete(claim)) throw new DocumentError('LEASE_LOST');
        return 'superseded';
      }
      const result = await convert(this.store, row, row.format, controller.signal, this.options);
      controller.signal.throwIfAborted();
      return await this.documents.publish(claim, { schemaVersion: 1, documentId, revision: revision as number, sourceDigest: row.digest, converterVersion, ...result });
    } catch (error) {
      if (controller.signal.aborted) {
        this.queue.fail(claim, 'CONVERSION_INTERRUPTED', Date.now(), 0);
        return 'interrupted';
      }
      if (error instanceof ConversionError && error.terminal) this.queue.reject(claim, error.code);
      else this.queue.fail(claim, error instanceof ConversionError ? error.code : 'CONVERSION_FAILED', Date.now(), Math.min(300_000, 1000 * 2 ** claim.attempts));
      return 'failed';
    } finally {
      clearInterval(heartbeat); signal?.removeEventListener('abort', abort);
      this.db.prepare("DELETE FROM worker_slots WHERE name='preview' AND token=?").run(slotToken);
      this.busy = false;
    }
  }
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const result = await this.runOnce(signal);
      if (result === 'idle') { try { await delay(250, undefined, { signal }); } catch { if (!signal.aborted) throw new Error('Worker polling failed'); } }
    }
  }
}
