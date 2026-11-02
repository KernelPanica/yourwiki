import { buildApp } from './app.ts';

// Opt-in development runtime. Production Django/Compose is not switched.
const app = buildApp();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().catch(() => { process.exitCode = 1; });
  });
}
try {
  await app.listen({ host: '127.0.0.1', port: 3100 });
  console.info('Yourwiki development backend: http://127.0.0.1:3100 (workspace not ready)');
} catch {
  console.error('Yourwiki development backend could not start.');
  process.exitCode = 1;
}
