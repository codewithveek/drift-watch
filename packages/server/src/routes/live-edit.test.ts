import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { DriftWatchConfigSchema, MemoryStateStore, ApprovalService, type ModelClient } from '@driftwatch/sdk';
import { registerRoutes } from './agent.js';
import { registerConsoleRoutes } from './console.js';
import { ServerConfigSchema, type ServerConfig } from '../config/server-config.js';

const runAgentTaskMock = vi.fn();

vi.mock('@driftwatch/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@driftwatch/sdk')>();
  return {
    ...actual,
    runAgentTask: (...args: unknown[]) => runAgentTaskMock(...args),
  };
});

const fakeAgentTaskResult = {
  taskId: 'task-1',
  responseText: 'hello there',
  stepCount: 1,
  skillsUsed: [],
  tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  providerName: 'test-provider',
  modelIdentifier: 'test-model',
};

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  runAgentTaskMock.mockReset();
});

// Proves an agent edited through the control-plane (console) API is picked
// up by its very next run through the enforcement path (agent routes) with
// no restart, no polling, no cache to invalidate — both route sets share one
// StateStore, exactly as they do in the real server.
describe('live edit: PATCH via console routes takes effect on the next /run', () => {
  it('an edited guardrail is enforced on the next agent run without restarting anything', async () => {
    runAgentTaskMock.mockResolvedValue(fakeAgentTaskResult);

    const store = new MemoryStateStore();
    const approvalService = new ApprovalService({
      store,
      notifiers: { list: [] },
      approvalTimeoutMs: 60_000,
      timeoutDecision: 'rejected',
    });
    const serverConfig: ServerConfig = ServerConfigSchema.parse({ agentId: 'default' });
    const driftWatchConfig = DriftWatchConfigSchema.parse({});

    const fastify = Fastify({ logger: false });
    await registerRoutes(fastify, {
      modelClient: 'fake-model' as unknown as ModelClient,
      modelRegistry: {},
      store,
      serverConfig,
      driftWatchConfig,
    });
    await registerConsoleRoutes(fastify, {
      store,
      serverConfig,
      driftWatchConfig,
      approvalService,
    });
    await fastify.ready();
    app = fastify;

    await store.upsertAgent({ id: 'agent-1', name: 'Agent One', createdAt: Date.now() });

    await fastify.inject({
      method: 'POST',
      url: '/agents/agent-1/run',
      payload: { prompt: 'hi' },
    });
    const before = runAgentTaskMock.mock.calls.at(-1)![0];
    expect(before.guardrails.maxTokensPerTask).toBe(driftWatchConfig.agent.maxTokensPerTask);

    const patched = await fastify.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: { guardrails: { maxTokensPerTask: 42 } },
    });
    expect(patched.statusCode).toBe(200);

    await fastify.inject({
      method: 'POST',
      url: '/agents/agent-1/run',
      payload: { prompt: 'hi' },
    });
    const after = runAgentTaskMock.mock.calls.at(-1)![0];
    expect(after.guardrails.maxTokensPerTask).toBe(42);
  });
});
