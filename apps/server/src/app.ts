import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { errorEnvelope } from './errors.ts';
import type { Database } from './database.ts';
import { registerChanges } from './change-routes.ts';
import { registerWeb } from './web-routes.ts';
import { registerUploads } from './upload-routes.ts';
import { registerDocuments } from './document-routes.ts';
import type { BlobStore } from './storage/blobs.ts';
import { registerAuth } from './auth/routes.ts';

export interface AppOptions {
  database?: Database;
  publicUrl?: string;
  webRoot?: string;
  changesPollMs?: number;
  storage?: BlobStore;
  maxFileBytes?: number;
  maxPendingUploadBytes?: number;
  uploadChunkBytes?: number;
  /** Local migrations/storage readiness only; never call cloud APIs here. */
  readiness?: () => Promise<boolean>;
}

export function buildApp(options: AppOptions = {}) {
  const app = Fastify({
    logger: false,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    // Upload streams will have a separate route-specific policy.
    bodyLimit: 1024 * 1024,
    trustProxy: false,
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
  });
  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send(errorEnvelope('NOT_FOUND', request.id));
  });
  app.setErrorHandler((error, request, reply) => {
    // Do not echo exception messages, request URLs, parser inputs or credentials.
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send(errorEnvelope('PAYLOAD_TOO_LARGE', request.id));
    }
    if (code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return reply.code(415).send(errorEnvelope('UNSUPPORTED_MEDIA_TYPE', request.id));
    }
    if (code === 'FST_ERR_VALIDATION' || code === 'FST_ERR_CTP_INVALID_JSON_BODY' || code === 'FST_ERR_CTP_EMPTY_JSON_BODY') {
      return reply.code(400).send(errorEnvelope('INVALID_REQUEST', request.id));
    }
    return reply.code(500).send(errorEnvelope('INTERNAL_ERROR', request.id));
  });
  if (options.database) registerAuth(app, options.database, options.publicUrl ?? 'http://localhost:3100');
  if (options.database) registerChanges(app, options.database, options.publicUrl ?? 'http://localhost:3100', options.changesPollMs);
  if (options.database && options.storage) registerDocuments(app, options.database, options.storage, options.publicUrl ?? 'http://localhost:3100', options.maxFileBytes);
  if (options.database && options.storage) registerUploads(app, options.database, options.storage, options.publicUrl ?? 'http://localhost:3100', { maxFileBytes: options.maxFileBytes, maxPendingBytes: options.maxPendingUploadBytes, chunkBytes: options.uploadChunkBytes });
  if (options.webRoot) registerWeb(app, options.webRoot);
  app.get('/health/', async () => ({ status: 'ok', service: 'yourwiki' }));
  app.get('/ready/', async (request, reply) => {
    let ready = false;
    try { ready = await options.readiness?.() === true; } catch { /* Safe unavailable below. */ }
    if (!ready) return reply.code(503).send(errorEnvelope('NOT_READY', request.id));
    return { status: 'ready' };
  });
  return app;
}
