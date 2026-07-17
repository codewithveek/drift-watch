// NOTE: otel.ts is loaded via `--import`, NOT imported here, so it runs first.
import Fastify from 'fastify';
import { registerRoutes } from './routes/agent.js';
import { assertModelClientIsConfigured } from './agent/model-client.js';
import { modelClient } from './config/model-client.js';

assertModelClientIsConfigured(modelClient);

const fastifyServer = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
  },
  bodyLimit: Number(process.env.BODY_LIMIT ?? 128 * 1024),
  trustProxy: process.env.TRUST_PROXY === '1',
});
await registerRoutes(fastifyServer, { modelClient });

const serverPort = Number(process.env.PORT ?? 3000);
const serverHost = process.env.HOST ?? '0.0.0.0';

try {
  const listeningAddress = await fastifyServer.listen({
    port: serverPort,
    host: serverHost,
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
