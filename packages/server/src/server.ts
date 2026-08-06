// NOTE: telemetry-bootstrap.ts is loaded via `--import`, NOT imported here,
// so it (and OTel auto-instrumentation) runs before this module and its
// transitive imports (Fastify, etc.) are required.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import 'dotenv/config';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { assertModelClientIsConfigured, loadDriftWatchConfigFromEnv } from '@driftwatch/sdk';
import { registerRoutes } from './routes/agent.js';
import { registerConsoleRoutes } from './routes/console.js';
import { registerIntegrationRoutes } from './routes/integrations.js';
import { loadServerConfigFromEnv } from './config/server-config.js';
import { modelClient, modelRegistry } from './config/model-client.js';
import { tools } from './tools.js';
import { createAutopilot } from './autopilot/index.js';

assertModelClientIsConfigured(modelClient);

const serverConfig = loadServerConfigFromEnv();
const driftWatchConfig = loadDriftWatchConfigFromEnv();

const fastifyServer = Fastify({
  logger: {
    level: serverConfig.logLevel,
  },
  bodyLimit: serverConfig.bodyLimitBytes,
  trustProxy: serverConfig.trustProxy,
});
await fastifyServer.register(rateLimit, {
  global: false,
  max: serverConfig.rateLimitMax,
  timeWindow: serverConfig.rateLimitWindowMs,
});

// --- Autopilot (Loop 2) composition ---------------------------------------
const autopilot = createAutopilot({
  serverConfig,
  driftWatchConfig,
  modelClient,
  logger: fastifyServer.log,
});

await registerRoutes(fastifyServer, {
  modelClient,
  modelRegistry,
  store: autopilot.store,
  tools,
  serverConfig,
  driftWatchConfig,
});
await registerConsoleRoutes(fastifyServer, {
  store: autopilot.store,
  serverConfig,
  driftWatchConfig,
  approvalService: autopilot.approvalService,
  scheduler: autopilot.scheduler,
});
await registerIntegrationRoutes(fastifyServer, {
  approvalService: autopilot.approvalService,
  serverConfig,
});

// Serve the built React console (packages/console/dist) at /console, if present.
const consoleDistDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../console/dist',
);
if (existsSync(consoleDistDir)) {
  await fastifyServer.register(fastifyStatic, {
    root: consoleDistDir,
  prefix: '/console',
    redirect: true,
  });
}

try {
  const listeningAddress = await fastifyServer.listen({
    port: serverConfig.port,
    host: serverConfig.host,
  });
  fastifyServer.log.info(`DriftWatch listening on ${listeningAddress}`);
  autopilot.scheduler?.start();
} catch (error) {
  fastifyServer.log.error(error);
  process.exit(1);
}

/**
 * Ordered shutdown: drain/close the HTTP server first, then stop the autopilot
 * (timers + state store), then flush telemetry, then exit — a single place
 * calling `process.exit`. `telemetry-bootstrap.js` is loaded via `--import`
 * before this module even starts, so this dynamic import resolves to that
 * already-running instance (Node's module cache keys on resolved URL) rather
 * than re-running bootstrap; it's dynamic rather than a static top-level
 * import solely so this file's own load order — Fastify et al. importing
 * before telemetry could patch them — is never at risk if someone runs
 * server.js without the `--import` preload.
 */
const shutDownServer = async (): Promise<void> => {
  fastifyServer.log.info('shutting down');
  try {
    await fastifyServer.close();
    await autopilot.shutdown();
    const { telemetrySdk } = await import('./telemetry-bootstrap.js');
    await telemetrySdk.shutdown();
  } finally {
    process.exit(0);
  }
};
process.on('SIGTERM', shutDownServer);
process.on('SIGINT', shutDownServer);
