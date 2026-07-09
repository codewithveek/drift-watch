import type { FastifyInstance } from 'fastify';
import { runAgent } from '../agent/runner.js';
import { detectDrift } from '../drift/detector.js';

export async function registerRoutes(app: FastifyInstance) {
  // Trigger an agent run. Fastify itself is auto-instrumented, so this HTTP
  // span becomes the root that the agent.run span nests under.
  app.post<{ Body: { prompt: string } }>('/run', async (req, reply) => {
    const { prompt } = req.body;
    if (!prompt) return reply.code(400).send({ error: 'prompt required' });
    const output = await runAgent(prompt);
    return { output };
  });

  // On-demand drift report (also runnable as a cron via `npm run drift`).
  app.get('/drift', async () => {
    return detectDrift();
  });

  app.get('/health', async () => ({ ok: true }));
}
