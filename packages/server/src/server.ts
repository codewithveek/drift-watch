// NOTE: telemetry-bootstrap.ts is loaded via `--import`, NOT imported here,
// so it (and OTel auto-instrumentation) runs before this module and its
// transitive imports (Fastify, etc.) are required.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import 'dotenv/config';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { assertModelClientIsConfigured, loadDriftWatchConfigFromEnv } from '@driftwatch/sdk';
import { registerRoutes } from './routes/agent.js';
import { registerConsoleRoutes } from './routes/console.js';
import { registerApiKeyRoutes } from './routes/api-keys.js';
import { registerSdkRoutes } from './routes/sdk.js';
import { registerIntegrationRoutes } from './routes/integrations.js';
import { registerConsoleStatic } from './routes/static-console.js';
import { createAuthGate } from './routes/auth.js';
import { registerAuthRoutes } from './routes/auth-routes.js';
import { setupAuth } from './auth/index.js';
import { createAuditRecorder } from './routes/audit.js';
import { loadServerConfigFromEnv } from './config/server-config.js';
import { modelClient, modelRegistry } from './config/model-client.js';
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
const autopilot = await createAutopilot({
  serverConfig,
  driftWatchConfig,
  modelClient,
  logger: fastifyServer.log,
});

// --- built-in auth ---------------------------------------------------------
// Undefined when the deployment has no database: better-auth stores users and
// sessions as rows, so a memory/Redis deployment keeps the AUTH_TOKEN path
// instead of getting a login screen whose sessions vanish on restart.
const auth = await setupAuth({
  serverConfig,
  ...(autopilot.db ? { db: autopilot.db } : {}),
  logger: {
    info: (message) => fastifyServer.log.info(message),
    warn: (message) => fastifyServer.log.warn(message),
  },
});
if (auth) await registerAuthRoutes(fastifyServer, { auth });

// One gate and one audit recorder shared by every route module, so scope
// enforcement and attribution can't diverge between them.
const authorize = createAuthGate({
  store: autopilot.store,
  authToken: serverConfig.authToken,
  ...(auth ? { auth } : {}),
});
const recordAudit = createAuditRecorder(autopilot.store);

/*
 * Liveness probe, pinned at the ROOT and outside the versioned API.
 *
 * Orchestrators (the Dockerfile's HEALTHCHECK, k8s probes, load balancers) are
 * configured with a URL that must not move when the API version does — a
 * versioned health endpoint means a v2 rollout silently fails every probe. The
 * same handler is also reachable at /api/v1/health, since registerRoutes
 * defines it too and gets mounted under the prefix below.
 */
fastifyServer.get('/health', async () => ({ ok: true }));

/*
 * Every DriftWatch API route lives under /api/v1.
 *
 * This became necessary the moment the console moved from /console to the root:
 * the console has PAGE routes at /agents and /audit, and the API has RESOURCE
 * routes at the same paths. Previously the /console prefix disambiguated them.
 * Serving the SPA at / makes `GET /agents` ambiguous — a browser navigation
 * wants HTML, the SDK wants JSON — and content negotiation cannot resolve it
 * because both send `Accept: *​/*`.
 *
 * Versioning is worth having independently: the SDK is published separately and
 * now consumes this surface as a public contract, so it needs a way to pin.
 *
 * Registered as an encapsulated plugin so the prefix is declared once rather
 * than threaded through every route module.
 */
const API_PREFIX = '/api/v1';
await fastifyServer.register(
  async (api) => {
    await registerRoutes(api, {
      modelClient,
      modelRegistry,
      store: autopilot.store,
      serverConfig,
      driftWatchConfig,
      notifiers: autopilot.notifiers,
      toolCallApprovalTimeoutMs: serverConfig.toolCallApprovalTimeoutMs,
      toolCallApprovalTimeoutDecision: serverConfig.toolCallApprovalTimeoutDecision,
      authorize,
    });
    await registerConsoleRoutes(api, {
      store: autopilot.store,
      serverConfig,
      driftWatchConfig,
      approvalService: autopilot.approvalService,
      scheduler: autopilot.scheduler,
      authorize,
      recordAudit,
    });
    await registerApiKeyRoutes(api, { store: autopilot.store, authorize, recordAudit });
    // The SDK-facing surface: sync, and the tool-call approval lifecycle an
    // embedded agent needs now that it no longer shares this server's database.
    await registerSdkRoutes(api, {
      store: autopilot.store,
      serverConfig,
      driftWatchConfig,
      authorize,
      recordAudit,
    });
  },
  { prefix: API_PREFIX },
);

/*
 * Inbound webhooks stay UNVERSIONED at /integrations.
 *
 * These URLs are configured inside Slack and Telegram by whoever set the
 * integration up. Moving them under a versioned prefix would silently break
 * every existing installation's approve/reject buttons, and they are third-party
 * callback endpoints rather than part of DriftWatch's own API contract.
 */
await registerIntegrationRoutes(fastifyServer, {
  approvalService: autopilot.approvalService,
  store: autopilot.store,
  serverConfig,
});

// Serve the built React console (packages/console/dist) at the ROOT, if present.
const consoleDistDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../console/dist',
);
if (existsSync(consoleDistDir)) {
  await registerConsoleStatic(fastifyServer, { consoleDistDir });
}

try {
  const listeningAddress = await fastifyServer.listen({
    port: serverConfig.port,
    host: serverConfig.host,
  });
  fastifyServer.log.info(`DriftWatch listening on ${listeningAddress}`);
  // Only the PERIODIC scan loop is gated on the flag — the scheduler itself is
  // always constructed so /drift/scan works either way.
  if (serverConfig.autopilotEnabled) autopilot.scheduler.start();
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
