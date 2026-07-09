// NOTE: otel.ts is loaded via `--import`, NOT imported here, so it runs first.
import Fastify from 'fastify';
import { registerRoutes } from './routes/agent.js';

const app = Fastify({ logger: true });
await registerRoutes(app);

const port = Number(process.env.PORT ?? 3000);
app
  .listen({ port, host: '0.0.0.0' })
  .then((addr) => app.log.info(`agent-drift-watch on ${addr}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
