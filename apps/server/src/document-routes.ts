import {officeFormats} from './office/formats.ts';
import {byteRange} from './http/byte-range.ts';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import type { Database } from './database.ts';
import { PdfLayerService } from './pdf-layers.ts';
import { AccessService } from './access.ts';
import { DocumentService, DocumentError } from './documents.ts';
import type { PreviewManifest } from './documents.ts';
import { BlobStore, BlobTooLargeError } from './storage/blobs.ts';
import { sessionCookie } from './auth/routes.ts';
import { authenticateSession, validCsrf } from './auth/sessions.ts';
import { errorEnvelope } from './errors.ts';

const previewCsp = "sandbox allow-same-origin; default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
const idSchema = { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 128 } } };


export function registerDocuments(app: FastifyInstance, db: Database, store: BlobStore, publicUrl: string, maxBytes = 4 * 1024 ** 3, officeConfigured = false): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid file size limit');
  const service = new DocumentService(db, store, { maxBytes });
  const access = new AccessService(db);
  const pdfLayers = new PdfLayerService(db, store, { maxBytes });
  const origin = new URL(publicUrl).origin;
  function identity(request: FastifyRequest, reply: FastifyReply, mutation = false) {
    const session = authenticateSession(db, sessionCookie(request));
    if (!session) { reply.code(401).send(errorEnvelope('SESSION_REQUIRED', request.id)); return null; }
    if (mutation && (request.headers.origin !== origin || typeof request.headers['x-csrf-token'] !== 'string' || !validCsrf(session, request.headers['x-csrf-token']))) {
      reply.code(403).send(errorEnvelope('CSRF_REJECTED', request.id)); return null;
    }
    return session;
  }
  const notFound = (request: FastifyRequest, reply: FastifyReply) => reply.code(404).send(errorEnvelope('NOT_FOUND', request.id));
  const fail = (error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof BlobTooLargeError) return reply.code(413).send(errorEnvelope('PAYLOAD_TOO_LARGE', request.id));
    if (!(error instanceof DocumentError)) throw error;
    const status = ({ NOT_FOUND: 404, ACCESS_DENIED: 403, CONFLICT: 409, OFFICE_ACTIVE: 409, INVALID_REQUEST: 400 } as Record<string, number>)[error.code] ?? 500;
    const body = errorEnvelope(status === 500 ? 'INTERNAL_ERROR' : error.code, request.id);
    body.operationId = error.recoveryId;
    if (error.code === 'CONFLICT') body.recoveryActions = ['copy_changes', 'download_changes', 'reload'];
    if (error.code === 'OFFICE_ACTIVE') body.recoveryActions = ['open_office', 'copy_changes', 'download_changes'];
    return reply.code(status).send(body);
  };

  function visible(userId: string, id: string) {
    const document = service.getPublished(userId, id);
    return document ? { ...document, capabilities: { office: officeConfigured && officeFormats.has(document.format), write: access.allows(userId, id, 'write'), export: access.allows(userId, id, 'export') } } : null;
  }
  app.get<{ Querystring: { after?: string; limit?: number } }>('/api/documents', { schema: { querystring: {
    type: 'object', additionalProperties: false, properties: { after: { type: 'string', maxLength: 128 }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
  } } }, async (request, reply) => {
    const actor = identity(request, reply); if (!actor) return;
    const candidates = db.prepare('SELECT id FROM documents WHERE published_revision IS NOT NULL AND id>? ORDER BY id LIMIT 201').all(request.query.after ?? '') as { id: string }[];
    const items = [];
    let scanned = 0, last: string | null = null;
    for (const row of candidates.slice(0,200)) {
      last = row.id; scanned++;
      const document = visible(actor.userId, row.id);
      if (document) items.push(document);
      if (items.length >= (request.query.limit ?? 50)) break;
    }
    return { items, nextCursor: scanned < candidates.length ? last : null };
  });

  app.get<{ Params: { id: string } }>('/api/documents/:id', { schema: { params: idSchema } }, async (request, reply) => {
    const actor = identity(request, reply); if (!actor) return;
    return visible(actor.userId, request.params.id) ?? notFound(request, reply);
  });
  app.get<{ Params: { id: string } }>('/api/documents/:id/processing', { schema: { params: idSchema } }, async (request, reply) => {
    const actor = identity(request, reply); if (!actor) return;
    return service.processingStatus(actor.userId, request.params.id) ?? notFound(request, reply);
  });

  // A manifest receipt, not a caller-supplied digest, authorizes asset lookup.
  async function manifest(request: FastifyRequest, reply: FastifyReply, id: string, digest: string) {
    const actor = identity(request, reply); if (!actor) return null;
    if (!/^[a-f0-9]{64}$/.test(digest) || !service.getPublished(actor.userId, id)
      || !db.prepare('SELECT 1 FROM preview_manifests WHERE document_id=? AND manifest_digest=?').get(id, digest)) {
      notFound(request, reply); return null;
    }
    const info = await store.stat(digest);
    if (info.size > 1024 * 1024) throw new Error('Invalid stored manifest size');
    return JSON.parse((await buffer(await store.read(digest))).toString()) as PreviewManifest;
  }
  app.get<{ Params: { id: string } }>('/api/documents/:id/view', { schema: { params: idSchema } }, async (request, reply) => {
    const actor = identity(request, reply); if (!actor) return;
    const document = visible(actor.userId, request.params.id);
    if (!document) return notFound(request, reply);
    const value = await manifest(request, reply, document.id, document.manifestDigest);
    if (!value) return;
    let presentation = null;
    if (value.kind === 'presentation') {
      const primary = value.artifacts.find(item => item.name === value.primary);
      if (!primary || primary.mimeType !== 'application/json' || primary.size > 1024 * 1024) throw new Error('Invalid presentation index');
      presentation = JSON.parse((await buffer(await store.read(primary.digest))).toString());
    }
    return { document, manifest: value, presentation };
  });
  app.get<{ Params: { id: string; digest: string } }>('/api/documents/:id/previews/:digest', async (request, reply) => {
    const value = await manifest(request, reply, request.params.id, request.params.digest);
    if (!value) return;
    return value;
  });
  app.get<{ Params: { id: string; digest: string; name: string } }>('/api/documents/:id/previews/:digest/assets/:name', async (request, reply) => {
    const value = await manifest(request, reply, request.params.id, request.params.digest);
    if (!value) return;
    const asset = value.artifacts.find(item => item.name === request.params.name);
    if (!asset) return notFound(request, reply);
    reply.header('content-security-policy', previewCsp);
    reply.header('cross-origin-resource-policy', 'same-origin');
    const range = byteRange(request.headers.range, asset.size);
    reply.header('accept-ranges', 'bytes');
    if (range === null) return reply.code(416).header('content-range', `bytes */${asset.size}`).send(errorEnvelope('INVALID_RANGE', request.id));
    reply.type(asset.mimeType).header('content-length', range ? range.end - range.start + 1 : asset.size);
    if (range) reply.code(206).header('content-range', `bytes ${range.start}-${range.end}/${asset.size}`);
    return reply.send(await store.read(asset.digest, range));
  });
  app.get<{ Params: { id: string } }>('/api/documents/:id/content', { schema: { params: idSchema } }, async (request, reply) => {
    const actor = identity(request, reply); if (!actor) return;
    const published = service.getPublished(actor.userId, request.params.id);
    if (!published) return notFound(request, reply);
    if (!access.allows(actor.userId, published.id, 'export')) return reply.code(403).send(errorEnvelope('ACCESS_DENIED', request.id));
    const source = db.prepare('SELECT digest,size FROM document_versions WHERE document_id=? AND revision=?').get(published.id, published.revision) as { digest: string; size: number };
    const range = byteRange(request.headers.range, source.size);
    reply.header('accept-ranges', 'bytes');
    if (range === null) return reply.code(416).header('content-range', `bytes */${source.size}`).send(errorEnvelope('INVALID_RANGE', request.id));
    reply.type('application/octet-stream').header('content-disposition', `attachment; filename="document.${published.format}"`);
    reply.header('content-length', range ? range.end - range.start + 1 : source.size);
    if (range) reply.code(206).header('content-range', `bytes ${range.start}-${range.end}/${source.size}`);
    return reply.send(await store.read(source.digest, range));
  });

  // Layer revisions and recovery IDs authorize lookup; raw blob digests never do.
  app.get<{ Params: { id: string } }>('/api/documents/:id/pdf', { schema: { params: idSchema } }, async (request, reply) => {
    const actor = identity(request, reply); if (!actor) return;
    return pdfLayers.state(actor.userId, request.params.id) ?? notFound(request, reply);
  });
  async function pdfBytes(request: FastifyRequest, reply: FastifyReply, recovery: boolean) {
    const actor = identity(request, reply); if (!actor) return;
    const params = request.params as { id: string; revision?: number; recoveryId?: string };
    if (!pdfLayers.state(actor.userId, params.id)) return notFound(request, reply);
    const blob = (recovery
      ? db.prepare('SELECT digest,size FROM recovery_copies WHERE id=? AND document_id=? AND author_id=?').get(params.recoveryId, params.id, actor.userId)
      : db.prepare('SELECT digest,size FROM pdf_layer_versions WHERE document_id=? AND revision=?').get(params.id, params.revision)) as { digest: string; size: number } | undefined;
    if (!blob) return notFound(request, reply);
    if (recovery && !access.allows(actor.userId, params.id, 'export')) return reply.code(403).send(errorEnvelope('ACCESS_DENIED', request.id));
    const range = byteRange(request.headers.range, blob.size);
    reply.header('accept-ranges', 'bytes').header('cross-origin-resource-policy', 'same-origin');
    reply.header('content-security-policy', previewCsp);
    if (range === null) return reply.code(416).header('content-range', `bytes */${blob.size}`).send(errorEnvelope('INVALID_RANGE', request.id));
    reply.type('application/pdf').header('content-length', range ? range.end - range.start + 1 : blob.size);
    if (recovery) reply.header('content-disposition', 'attachment; filename="recovered.pdf"');
    if (range) reply.code(206).header('content-range', `bytes ${range.start}-${range.end}/${blob.size}`);
    return reply.send(await store.read(blob.digest, range));
  }
  app.get('/api/documents/:id/pdf/layers/:revision', { schema: { params: {
    type: 'object', required: ['id','revision'], properties: { id: { type: 'string', minLength: 1, maxLength: 128 }, revision: { type: 'integer', minimum: 1 } },
  } } }, (request, reply) => pdfBytes(request, reply, false));
  app.get('/api/documents/:id/pdf/recovery/:recoveryId', { schema: { params: {
    type: 'object', required: ['id','recoveryId'], properties: { id: { type: 'string', minLength: 1, maxLength: 128 }, recoveryId: { type: 'string', format: 'uuid' } },
  } } }, (request, reply) => pdfBytes(request, reply, true));

  // Encapsulation limits the unbuffered parser to file mutation routes.
  app.register(async upload => {
    upload.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload));
    upload.addHook('onRequest', async (request, reply) => { identity(request, reply, true); });
    const query = { type: 'object', additionalProperties: false, required: ['title', 'format'], properties: {
      title: { type: 'string', minLength: 1, maxLength: 200 }, format: { type: 'string', pattern: '^[a-z0-9][a-z0-9.-]{0,31}$' },
      parentId: { type: 'string', minLength: 1, maxLength: 128 }, groupId: { type: 'string', minLength: 1, maxLength: 128 },
    } };
    async function receive(request: FastifyRequest, reply: FastifyReply, save: boolean) {
      const actor = identity(request, reply, true); if (!actor) return;
      if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/octet-stream') return reply.code(415).send(errorEnvelope('UNSUPPORTED_MEDIA_TYPE', request.id));
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.raw.once('aborted', abort);
      try {
        const q = request.query as { title: string; format: string; parentId?: string; groupId?: string; baseRevision?: number };
        const source = request.body as Readable;
        const result = save
          ? await service.save({ userId: actor.userId, documentId: (request.params as { id: string }).id, baseRevision: q.baseRevision!, signal: controller.signal }, source)
          : await service.create({ userId: actor.userId, title: q.title, format: q.format, parentId: q.parentId ?? null, groupId: q.groupId, signal: controller.signal }, source);
        return reply.code(save ? 202 : 201).send({ documentId: result.documentId, revision: result.revision, jobId: result.jobId, state: 'queued' });
      } catch (error) { return fail(error, request, reply); }
      finally { request.raw.removeListener('aborted', abort); }
    }
    upload.put<{ Params: { id: string }; Querystring: { baseRevision: number; layerRevision: number; replaceStaleLayer?: boolean } }>('/api/documents/:id/pdf/layer', { schema: { params: idSchema, querystring: {
      type: 'object', additionalProperties: false, required: ['baseRevision','layerRevision'], properties: {
        baseRevision: { type: 'integer', minimum: 1 }, layerRevision: { type: 'integer', minimum: 0 }, replaceStaleLayer: { type: 'boolean', default: false },
      },
    } } }, async (request, reply) => {
      const actor = identity(request, reply, true); if (!actor) return;
      if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/octet-stream') return reply.code(415).send(errorEnvelope('UNSUPPORTED_MEDIA_TYPE', request.id));
      const controller = new AbortController(), abort = () => controller.abort();
      request.raw.once('aborted', abort);
      try {
        const saved = await pdfLayers.save({ userId: actor.userId, documentId: request.params.id, ...request.query, signal: controller.signal }, request.body as Readable);
        return { baseRevision: saved.baseRevision, layerRevision: saved.layerRevision, state: 'saved' };
      } catch (error) { return fail(error, request, reply); }
      finally { request.raw.removeListener('aborted', abort); }
    });
    upload.post('/api/documents', { schema: { querystring: query } }, (request, reply) => receive(request, reply, false));
    upload.put('/api/documents/:id/content', { schema: { params: idSchema, querystring: {
      type: 'object', additionalProperties: false, required: ['baseRevision'], properties: { baseRevision: { type: 'integer', minimum: 0 } },
    } } }, (request, reply) => receive(request, reply, true));
  });
}
