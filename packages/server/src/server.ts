// NOTE: telemetry-bootstrap.ts is loaded via `--import`, NOT imported here,
// so it (and OTel auto-instrumentation) runs before this module and its
// transitive imports (Fastify, etc.) are required.
import Fastify from 'fastify';
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

const shutDownServer = async (): Promise<void> => {
  fastifyServer.log.info('shutting down');
  try {
    await fastifyServer.close();
  } finally {
    process.exit(0);
  }
};
process.on('SIGTERM', shutDownServer);
process.on('SIGINT', shutDownServer);
