import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Readable } from 'node:stream';
import type { Database } from './database.ts';
import { BlobStore, BlobTooLargeError } from './storage/blobs.ts';
import { ResumableUploads, UploadError } from './uploads.ts';
import type { UploadMetadata } from './uploads.ts';
import { DocumentError } from './documents.ts';
import { sessionCookie } from './auth/routes.ts';
import { authenticateSession, validCsrf } from './auth/sessions.ts';
import { errorEnvelope } from './errors.ts';

export function registerUploads(app: FastifyInstance, db: Database, store: BlobStore, publicUrl: string, options: { maxFileBytes?: number; maxPendingBytes?: number; chunkBytes?: number } = {}) {
  const uploads = new ResumableUploads(db, store, options), origin = new URL(publicUrl).origin;
  let cleaning: Promise<void> | null = null;
  const cleanup = () => {
    if (!cleaning) cleaning = uploads.cleanupExpired().catch(() => {}).finally(() => { cleaning = null; });
  };
  const interval = setInterval(cleanup, 60_000); interval.unref();
  app.addHook('onReady', async () => { cleanup(); });
  app.addHook('onClose', async () => { clearInterval(interval); await cleaning; });
  function identity(request: FastifyRequest, reply: FastifyReply) {
    const actor = authenticateSession(db, sessionCookie(request));
    if (!actor) { reply.code(401).send(errorEnvelope('SESSION_REQUIRED', request.id)); return null; }
    if (request.method !== 'GET' && request.method !== 'HEAD' && (request.headers.origin !== origin || typeof request.headers['x-csrf-token'] !== 'string' || !validCsrf(actor, request.headers['x-csrf-token']))) {
      reply.code(403).send(errorEnvelope('CSRF_REJECTED', request.id)); return null;
    }
    return actor;
  }
  async function handle(request: FastifyRequest, reply: FastifyReply, operation: (userId: string, signal: AbortSignal) => unknown | Promise<unknown>, status = 200) {
    const actor = identity(request, reply); if (!actor) return;
    const controller = new AbortController(), abort = () => controller.abort();
    request.raw.once('aborted', abort);
    try { return reply.code(status).send(await operation(actor.userId, controller.signal)); }
    catch (error) {
      if (error instanceof BlobTooLargeError) return reply.code(413).send(errorEnvelope('PAYLOAD_TOO_LARGE', request.id));
      if (!(error instanceof UploadError) && !(error instanceof DocumentError)) throw error;
      const statuses: Record<string, number> = { NOT_FOUND: 404, ACCESS_DENIED: 403, INVALID_REQUEST: 400, EMPTY_CHUNK: 400, CHUNK_SIZE_MISMATCH: 400, TOO_MANY_CHUNKS: 400,
        UPLOAD_INTERRUPTED: 408, UPLOAD_EXPIRED: 410, UPLOAD_CLOSED: 409, UPLOAD_BUSY: 423, OFFSET_MISMATCH: 409, CHUNK_CONFLICT: 409,
        UPLOAD_INCOMPLETE: 409, CONFLICT: 409, OFFICE_ACTIVE: 409, UPLOAD_QUOTA_EXCEEDED: 429, UPLOAD_CORRUPT: 422, UNSUPPORTED_MEDIA_TYPE: 415 };
      const httpStatus = statuses[error.code] ?? 500;
      const value = errorEnvelope(httpStatus === 500 ? 'INTERNAL_ERROR' : error.code, request.id);
      value.operationId = (request.params as { id?: string })?.id ?? null;
      if (httpStatus === 408 || httpStatus === 409 || httpStatus === 423) value.recoveryActions = ['check_upload_status', 'resume_upload'];
      if (error.code === 'CONFLICT') value.recoveryActions = ['copy_changes', 'download_changes', 'reload'];
      if (error.code === 'OFFICE_ACTIVE') value.recoveryActions = ['open_office', 'copy_changes', 'download_changes'];
      if (httpStatus === 429 || httpStatus === 423) reply.header('retry-after', 5);
      return reply.code(httpStatus).send(value);
    } finally { request.raw.removeListener('aborted', abort); }
  }
  app.register(async api => {
    api.addHook('onRequest', async (request, reply) => { identity(request, reply); });
    api.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload));
    const common = { size: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, mode: { type: 'string' } };
    const text = { type: 'string', minLength: 1, maxLength: 128 };
    const params = { type: 'object', required: ['id'], properties: { id: text } };
    api.post<{ Body: UploadMetadata }>('/api/uploads', { schema: { body: { oneOf: [
      { type: 'object', additionalProperties: false, required: ['mode','size','title','format'], properties: { ...common, mode: { const: 'create' },
        title: { type: 'string', minLength: 1, maxLength: 200 }, format: { type: 'string', pattern: '^[a-z0-9][a-z0-9.-]{0,31}$' }, parentId: { anyOf: [text, { type: 'null' }] }, groupId: text } },
      { type: 'object', additionalProperties: false, required: ['mode','size','documentId','baseRevision'], properties: { ...common, mode: { const: 'save' }, documentId: text,
        baseRevision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } } },
    ] } } }, (request, reply) => handle(request, reply, userId => {
      const value = request.body;
      return uploads.create(userId, value.mode === 'create' ? { ...value, parentId: value.parentId ?? null } : value);
    }, 201));
    api.get<{ Params: { id: string } }>('/api/uploads/:id', { schema: { params } }, (request, reply) => handle(request, reply, userId => uploads.status(userId, request.params.id)));
    api.patch<{ Params: { id: string }; Querystring: { offset: number } }>('/api/uploads/:id', { schema: { params, querystring: {
      type: 'object', additionalProperties: false, required: ['offset'], properties: { offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } },
    } } }, (request, reply) => handle(request, reply, (userId, signal) => {
      if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/octet-stream') throw new UploadError('UNSUPPORTED_MEDIA_TYPE');
      return uploads.append(userId, request.params.id, request.query.offset, request.body as Readable, signal);
    }));
    api.post<{ Params: { id: string } }>('/api/uploads/:id/finish', { schema: { params } }, (request, reply) => handle(request, reply, (userId, signal) => uploads.finish(userId, request.params.id, signal)));
    api.delete<{ Params: { id: string } }>('/api/uploads/:id', { schema: { params } }, (request, reply) => handle(request, reply, userId => uploads.cancel(userId, request.params.id), 204));
  });
}
