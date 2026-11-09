import {registerPlugins} from './plugins/routes.ts';
import {registerMonitoring} from './monitoring/routes.ts';
import {GoogleRegistration} from './auth/google-registration.ts';
import {registerGoogleRegistration} from './auth/google-registration-routes.ts';
import {registerGoogleWatch} from './providers/google-watch.ts';
import {registerStorageRoutes} from './providers/storage-routes.ts';
import {registerBackupRoutes} from './backups/routes.ts';
import {registerOfficeFonts} from './office/fonts.ts';
import {registerTextDocuments} from './text/routes.ts';
import {registerPresence} from './presence/routes.ts';
import {registerMigrationRecovery} from './release/recovery-routes.ts';
import {registerContentParity} from './content-parity/routes.ts';
import type {SecretConfigs} from './providers/secret-config.ts';
import {registerAdministration} from './administration/routes.ts';
import type {GoogleLifecycle} from './providers/google-lifecycle.ts';
import {registerGoogleLifecycle} from './providers/google-lifecycle-routes.ts';
import type {GoogleIdentities} from './providers/google-identities.ts';
import {registerGoogleAccess} from './providers/google-access-routes.ts';
import {GoogleTrashRequests} from './providers/google-trash-jobs.ts';
import {registerGoogleTrash} from './providers/google-trash-routes.ts';
import {registerGoogleImports} from './providers/google-import-routes.ts';
import type {GoogleImportRequests} from './providers/google-import-jobs.ts';
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
  officeFontsRoot?: string;
  contentSecrets?: SecretConfigs;
  drawioRoot?: string;
  googleLifecycle?: GoogleLifecycle;
  googleIdentities?: GoogleIdentities;
  googleRegistration?:GoogleRegistration;
  googleImports?: GoogleImportRequests;
  googleTrash?: GoogleTrashRequests;
  googleDiscovery?: GoogleDiscoveryRequests;
  googleConnect?: GoogleConnect;
  providerConnections?: ProviderConnections;
  workspacePath?: string;
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
  if(options.googleTrash&&(!options.database||!options.googleTrash.belongsToDatabase(options.database)))throw new Error('Google trash requires a matching workspace database');
  if(options.googleImports&&(!options.database||!options.googleImports.belongsToDatabase(options.database)))throw new Error('Google imports require a matching workspace database');
  if(options.googleIdentities&&(!options.database||!options.googleIdentities.belongsToDatabase(options.database)))throw new Error('Google identities require matching database');
  if(options.googleLifecycle&&(!options.database||!options.googleLifecycle.belongsToDatabase(options.database)))throw new Error('Google lifecycle requires matching database');
  const app = Fastify({
    logger: false,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    // Upload streams will have a separate route-specific policy.
    bodyLimit: 1024 * 1024,
    trustProxy: false,
  });
  if(options.database){registerMonitoring(app,options.database,options.workspacePath);registerPlugins(app,options.database,options.contentSecrets,options.publicUrl??'http://localhost:3100');}
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
  if(options.googleRegistration&&(!options.googleIdentities||!options.database||!options.googleRegistration.belongsToDatabase(options.database,options.publicUrl??'http://localhost:3100')))throw new Error('Registration requires matching database and public origin');
  const registration=options.googleRegistration??(options.database&&options.contentSecrets&&options.googleIdentities?new GoogleRegistration(options.database,options.contentSecrets,options.publicUrl??'http://localhost:3100'):undefined);
  if(options.database)registerGoogleRegistration(app,options.database,new URL(options.publicUrl??'http://localhost:3100').origin,registration);
  if(options.database&&options.storage&&options.contentSecrets&&options.providerConnections){registerStorageRoutes(app,options.database,options.storage,options.contentSecrets,options.publicUrl??'http://localhost:3100');if(options.workspacePath)registerBackupRoutes(app,options.database,options.contentSecrets,options.workspacePath,options.publicUrl??'http://localhost:3100');}
  if(options.database&&options.providerConnections)registerProviderConnections(app,options.database,options.providerConnections);
  if(options.database&&options.googleConnect)registerGoogleConnect(app,options.database,options.googleConnect,options.publicUrl??'http://localhost:3100');
  if (options.database) registerAuth(app, options.database, options.publicUrl ?? 'http://localhost:3100', {providerStorage:!!(options.contentSecrets&&options.providerConnections&&options.storage),providerBackups:!!(options.contentSecrets&&options.providerConnections&&options.storage&&options.workspacePath),googleConnect:!!options.googleConnect,googleDiscovery:!!options.googleDiscovery,googleImport:!!options.googleImports,googleTrash:!!options.googleTrash,googleIdentity:!!options.googleIdentities,googleLifecycle:!!options.googleLifecycle});
  if(options.database&&options.storage)registerMigrationRecovery(app,options.database,options.storage);
  if(options.database&&options.storage)registerTextDocuments(app,options.database,options.storage,options.publicUrl??'http://localhost:3100');
  if(options.database&&options.storage)registerContentParity(app,options.database,options.storage,options.publicUrl??'http://localhost:3100',{secrets:options.contentSecrets,drawioRoot:options.drawioRoot});
  if(options.database)registerGoogleWatch(app,options.database);
  if(options.database)registerPresence(app,options.database,options.publicUrl??'http://localhost:3100');
  if (options.database) registerAdministration(app,options.database,options.publicUrl??'http://localhost:3100',{fileDashboard:!!options.storage,googleTrash:options.googleTrash});
  if (options.database) registerHistorySettings(app,options.database,options.publicUrl??'http://localhost:3100');
  if (options.database) registerChanges(app, options.database, options.publicUrl ?? 'http://localhost:3100', options.changesPollMs);
  if (options.database && options.storage) registerDocuments(app, options.database, options.storage, options.publicUrl ?? 'http://localhost:3100', options.maxFileBytes, !!options.office, !!options.googleTrash, !!options.googleIdentities);
  if(options.database&&options.storage)registerProviderSync(app,options.database,options.storage,options.publicUrl??'http://localhost:3100');
  if(options.database&&options.googleLifecycle)registerGoogleLifecycle(app,options.database,options.googleLifecycle,options.publicUrl??'http://localhost:3100');
  if(options.database&&options.googleIdentities)registerGoogleAccess(app,options.database,options.googleIdentities,options.publicUrl??'http://localhost:3100',registration);
  if(options.database&&options.googleTrash)registerGoogleTrash(app,options.database,options.googleTrash,options.publicUrl??'http://localhost:3100');
  if(options.database&&options.googleImports)registerGoogleImports(app,options.database,options.googleImports,options.publicUrl??'http://localhost:3100');
  if(options.database&&options.googleDiscovery)registerGoogleDiscovery(app,options.database,options.googleDiscovery,options.publicUrl??'http://localhost:3100');
  if(options.database&&options.storage)registerProviderDelivery(app,options.database,options.storage,options.publicUrl??'http://localhost:3100');
  if (options.database && options.storage) registerHistory(app,options.database,options.storage);
  if (options.database && options.storage) registerHistoryTransfer(app,options.database,options.storage,options.publicUrl??'http://localhost:3100');
  if (options.database && options.storage) registerHistoryRestore(app,options.database,options.storage,options.publicUrl??'http://localhost:3100',options.maxFileBytes);
  if (options.database && options.storage) registerHistoryPreviews(app,options.database,options.storage,options.publicUrl??'http://localhost:3100');
  if (options.database && options.storage) registerUploads(app, options.database, options.storage, options.publicUrl ?? 'http://localhost:3100', { maxFileBytes: options.maxFileBytes, maxPendingBytes: options.maxPendingUploadBytes, chunkBytes: options.uploadChunkBytes });
  if(options.database&&options.storage&&options.office)registerOffice(app,options.database,options.storage,options.publicUrl??'http://localhost:3100',options.office,{maxFileBytes:options.maxFileBytes,maxPendingBytes:options.maxPendingUploadBytes});
  registerOfficeFonts(app,options.publicUrl??'http://localhost:3100',options.officeFontsRoot);
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
