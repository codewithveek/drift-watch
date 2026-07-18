// NOTE: telemetry-bootstrap.ts is loaded via `--import`, NOT imported here,
// so it (and OTel auto-instrumentation) runs before this module and its
// transitive imports (Fastify, etc.) are required.
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { assertModelClientIsConfigured, loadAgentPulseConfigFromEnv } from '@agentpulse/sdk';
import { registerRoutes } from './routes/agent.js';
import { loadServerConfigFromEnv } from './config/server-config.js';
import { modelClient } from './config/model-client.js';
import { tools } from './tools.js';

assertModelClientIsConfigured(modelClient);

const serverConfig = loadServerConfigFromEnv();
const agentPulseConfig = loadAgentPulseConfigFromEnv();

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
await registerRoutes(fastifyServer, {
  modelClient,
  tools,
  serverConfig,
  agentPulseConfig,
});

try {
  const listeningAddress = await fastifyServer.listen({
    port: serverConfig.port,
    host: serverConfig.host,
  });
  fastifyServer.log.info(`AgentPulse listening on ${listeningAddress}`);
} catch (error) {
  fastifyServer.log.error(error);
  process.exit(1);
}

/**
 * Ordered shutdown: drain/close the HTTP server first, then flush telemetry,
 * then exit — a single place calling `process.exit`. `telemetry-bootstrap.js`
 * is loaded via `--import` before this module even starts, so this dynamic
 * import resolves to that already-running instance (Node's module cache
 * keys on resolved URL) rather than re-running bootstrap; it's dynamic
 * rather than a static top-level import solely so this file's own load
 * order — Fastify et al. importing before telemetry could patch them — is
 * never at risk if someone runs server.js without the `--import` preload.
 */
const shutDownServer = async (): Promise<void> => {
  fastifyServer.log.info('shutting down');
  try {
    await fastifyServer.close();
    const { telemetrySdk } = await import('./telemetry-bootstrap.js');
    await telemetrySdk.shutdown();
  } finally {
    process.exit(0);
  }
};
process.on('SIGTERM', shutDownServer);
process.on('SIGINT', shutDownServer);
