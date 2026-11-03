import {registerGoogleDiscovery} from './providers/google-discovery-routes.ts';
import type {GoogleDiscoveryRequests} from './providers/google-discovery-jobs.ts';
import {registerProviderSync} from './providers/sync-routes.ts';
import {registerProviderDelivery} from './providers/delivery-routes.ts';
import {registerProviderConnections} from './providers/connection-routes.ts';
import type {ProviderConnections} from './providers/connections.ts';
import type {GoogleConnect} from './providers/google-connect.ts';
import {registerGoogleConnect} from './providers/google-connect-routes.ts';
import {registerHistoryTransfer} from './history-transfer-routes.ts';
import {registerHistoryRestore} from './history-restore-routes.ts';
import {registerHistoryPreviews} from './history-preview-routes.ts';
import {registerHistory} from './history-routes.ts';
import {registerHistorySettings} from './history-settings-routes.ts';
import {registerOffice,type OfficeOptions} from './office/routes.ts';
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
  googleDiscovery?: GoogleDiscoveryRequests;
  googleConnect?: GoogleConnect;
  providerConnections?: ProviderConnections;
  office?: OfficeOptions;
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
  if(options.googleConnect&&(!options.database||!options.googleConnect.belongsToDatabase(options.database,options.publicUrl??'http://localhost:3100')))throw new Error('Google connect requires matching database and public origin');
  if(options.providerConnections&&(!options.database||!options.providerConnections.belongsToDatabase(options.database)))throw new Error('Provider connections require a matching workspace database');
  if(options.googleDiscovery&&(!options.database||!options.googleDiscovery.belongsToDatabase(options.database)))throw new Error('Discovery requires a matching workspace database');
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
  if(options.database&&options.providerConnections)registerProviderConnections(app,options.database,options.providerConnections);
  if(options.database&&options.googleConnect)registerGoogleConnect(app,options.database,options.googleConnect,options.publicUrl??'http://localhost:3100');
  if (options.database) registerAuth(app, options.database, options.publicUrl ?? 'http://localhost:3100', {googleConnect:!!options.googleConnect,googleDiscovery:!!options.googleDiscovery});
  if (options.database) registerHistorySettings(app,options.database,options.publicUrl??'http://localhost:3100');
  if (options.database) registerChanges(app, options.database, options.publicUrl ?? 'http://localhost:3100', options.changesPollMs);
  if (options.database && options.storage) registerDocuments(app, options.database, options.storage, options.publicUrl ?? 'http://localhost:3100', options.maxFileBytes, !!options.office);
  if(options.database&&options.storage)registerProviderSync(app,options.database,options.storage,options.publicUrl??'http://localhost:3100');
  if(options.database&&options.googleDiscovery)registerGoogleDiscovery(app,options.database,options.googleDiscovery,options.publicUrl??'http://localhost:3100');
  if(options.database&&options.storage)registerProviderDelivery(app,options.database,options.storage,options.publicUrl??'http://localhost:3100');
  if (options.database && options.storage) registerHistory(app,options.database,options.storage);
  if (options.database && options.storage) registerHistoryTransfer(app,options.database,options.storage,options.publicUrl??'http://localhost:3100');
  if (options.database && options.storage) registerHistoryRestore(app,options.database,options.storage,options.publicUrl??'http://localhost:3100',options.maxFileBytes);
  if (options.database && options.storage) registerHistoryPreviews(app,options.database,options.storage,options.publicUrl??'http://localhost:3100');
  if (options.database && options.storage) registerUploads(app, options.database, options.storage, options.publicUrl ?? 'http://localhost:3100', { maxFileBytes: options.maxFileBytes, maxPendingBytes: options.maxPendingUploadBytes, chunkBytes: options.uploadChunkBytes });
  if(options.database&&options.storage&&options.office)registerOffice(app,options.database,options.storage,options.publicUrl??'http://localhost:3100',options.office,{maxFileBytes:options.maxFileBytes,maxPendingBytes:options.maxPendingUploadBytes});
  if (options.webRoot) registerWeb(app, options.webRoot, options.office?.publicUrl);
  app.get('/health/', async () => ({ status: 'ok', service: 'yourwiki' }));
  app.get('/ready/', async (request, reply) => {
    let ready = false;
    try { ready = await options.readiness?.() === true; } catch { /* Safe unavailable below. */ }
    if (!ready) return reply.code(503).send(errorEnvelope('NOT_READY', request.id));
    return { status: 'ready' };
  });
  return app;
}
