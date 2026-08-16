import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import {
  DriftWatchConfigSchema,
  MemoryStateStore,
  mintApiKey,
  type ModelClient,
} from '@driftwatch/sdk';
import { registerRoutes } from './agent.js';
import { createAuthGate } from './auth.js';
import type { ServerConfig } from '../config/server-config.js';

const runAgentTaskMock = vi.fn();
const detectBehavioralDriftMock = vi.fn();

vi.mock('@driftwatch/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@driftwatch/sdk')>();
  return {
    ...actual,
    runAgentTask: (...args: unknown[]) => runAgentTaskMock(...args),
    detectBehavioralDrift: (...args: unknown[]) => detectBehavioralDriftMock(...args),
  };
});

const fakeAgentTaskResult = {
  taskId: 'task-1',
  responseText: 'hello there',
  stepCount: 1,
  skillsUsed: ['get_weather'],
  tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  providerName: 'test-provider',
  modelIdentifier: 'test-model',
};

const fakeDriftReport = {
  baselineWindowStats: {
    windowLabel: 'baseline',
    totalCalls: 10,
    errorRate: 0,
    p95LatencyMs: 100,
    tokenSpend: 1000,
    toolMix: {},
  },
  currentWindowStats: {
    windowLabel: 'current',
    totalCalls: 10,
    errorRate: 0,
    p95LatencyMs: 100,
    tokenSpend: 1000,
    toolMix: {},
  },
  verdict: { drift: false, severity: 'none', reasons: [], recommended_action: '' },
  judgeTokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  providerName: 'test-provider',
  modelIdentifier: 'test-model',
};

function buildServerConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    port: 4300,
    host: '0.0.0.0',
    logLevel: 'silent',
    bodyLimitBytes: 131072,
    trustProxy: false,
    maxPromptBytes: 8192,
    driftDryRun: false,
    rateLimitMax: 100,
    rateLimitWindowMs: 60_000,
    agentId: 'default',
    agentName: '',
    ...overrides,
  };
}

let currentServer: FastifyInstance | undefined;
let currentStore: MemoryStateStore | undefined;

async function buildTestServer(
  serverConfigOverrides: Partial<ServerConfig> = {},
  modelRegistry: Record<string, ModelClient> = {},
): Promise<FastifyInstance> {
  const serverConfig = buildServerConfig(serverConfigOverrides);
  const store = new MemoryStateStore();
  // Mirrors createAutopilot's boot-time auto-registration, so /run and
  // /drift's bare aliases (which resolve to serverConfig.agentId) have a
  // real agent to look up.
  await store.upsertAgent({ id: serverConfig.agentId, name: 'Default Agent', createdAt: Date.now() });
  currentStore = store;

  const fastifyServer = Fastify({ logger: false });
  await fastifyServer.register(rateLimit, {
    global: false,
    max: serverConfig.rateLimitMax,
    timeWindow: serverConfig.rateLimitWindowMs,
  });
  await registerRoutes(fastifyServer, {
    modelClient: 'fake-model' as unknown as ModelClient,
    modelRegistry,
    store,
    serverConfig,
    driftWatchConfig: DriftWatchConfigSchema.parse({}),
    notifiers: { list: [] },
    toolCallApprovalTimeoutMs: 300,
    toolCallApprovalTimeoutDecision: 'rejected',
    // No `auth` (tests have no database), so loopback callers resolve to the
    // `local` development principal and a bearer must be a real minted key.
    authorize: createAuthGate({ store }),
  });
  await fastifyServer.ready();
  currentServer = fastifyServer;
  return fastifyServer;
}

beforeEach(() => {
  runAgentTaskMock.mockReset().mockResolvedValue(fakeAgentTaskResult);
  detectBehavioralDriftMock.mockReset().mockResolvedValue(fakeDriftReport);
});

afterEach(async () => {
  await currentServer?.close();
  currentServer = undefined;
});

describe('GET /health', () => {
  it('requires no authorization', async () => {
    const server = await buildTestServer();
    const response = await server.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });
});

describe('authorization gate (shared by /run and /drift)', () => {
  /*
   * AUTH_TOKEN is gone. With no database there is no login either, so the only
   * two ways through are a minted API key or the local-network development
   * path. These tests pin exactly where that line falls.
   */
  it('rejects a remote client with no credential', async () => {
    const server = await buildTestServer();
    const response = await server.inject({
      method: 'POST',
      url: '/run',
      remoteAddress: '203.0.113.5',
      payload: { prompt: 'hi' },
    });
    expect(response.statusCode).toBe(401);
    expect(runAgentTaskMock).not.toHaveBeenCalled();
  });

  it('allows loopback when the deployment has no login configured', async () => {
    const server = await buildTestServer();
    const response = await server.inject({
      method: 'POST',
      url: '/run',
      remoteAddress: '127.0.0.1',
      payload: { prompt: 'hi' },
    });
    expect(response.statusCode).toBe(200);
  });

  it('allows the RFC 1918 172.16.0.0/12 range', async () => {
    const server = await buildTestServer();
    const response = await server.inject({
      method: 'POST',
      url: '/run',
      remoteAddress: '172.20.0.5',
      payload: { prompt: 'hi' },
    });
    expect(response.statusCode).toBe(200);
  });

  it('rejects 172.x addresses outside the private /12 range (regression: not just a "172." prefix match)', async () => {
    const server = await buildTestServer();
    const response = await server.inject({
      method: 'POST',
      url: '/run',
      remoteAddress: '172.32.0.5',
      payload: { prompt: 'hi' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects an unrecognised bearer EVEN from loopback', async () => {
    const server = await buildTestServer();
    const response = await server.inject({
      method: 'POST',
      url: '/run',
      remoteAddress: '127.0.0.1',
      headers: { authorization: 'Bearer not-a-real-key' },
      payload: { prompt: 'hi' },
    });
    // Downgrading a bad credential to local trust would make a stale token look
    // like it was working while actually being ignored.
    expect(response.statusCode).toBe(401);
    expect(runAgentTaskMock).not.toHaveBeenCalled();
  });

  it('accepts a minted API key from a remote address', async () => {
    const server = await buildTestServer();
    const minted = mintApiKey({ name: 'ci', scopes: ['agent:run'], createdBy: 'test' });
    await currentStore!.createApiKey(minted.record);

    const response = await server.inject({
      method: 'POST',
      url: '/run',
      remoteAddress: '203.0.113.5',
      headers: { authorization: `Bearer ${minted.token}` },
      payload: { prompt: 'hi' },
    });
    expect(response.statusCode).toBe(200);
  });

  it('rejects a revoked key', async () => {
    const server = await buildTestServer();
    const minted = mintApiKey({ name: 'ci', scopes: ['agent:run'], createdBy: 'test' });
    await currentStore!.createApiKey(minted.record);
    await currentStore!.revokeApiKey(minted.record.id, 'test');

    const response = await server.inject({
      method: 'POST',
      url: '/run',
      remoteAddress: '203.0.113.5',
      headers: { authorization: `Bearer ${minted.token}` },
      payload: { prompt: 'hi' },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('POST /run', () => {
  it('rejects a missing prompt with 400', async () => {
    const server = await buildTestServer();
    const response = await server.inject({
      method: 'POST',
      url: '/run',
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect(runAgentTaskMock).not.toHaveBeenCalled();
  });

  it('rejects a prompt over maxPromptBytes with 413', async () => {
    const server = await buildTestServer({ maxPromptBytes: 8 });
    const response = await server.inject({
      method: 'POST',
      url: '/run',
      payload: { prompt: 'way more than eight bytes' },
    });
    expect(response.statusCode).toBe(413);
    expect(runAgentTaskMock).not.toHaveBeenCalled();
  });

  it('returns the agent task result on success', async () => {
    const server = await buildTestServer();
    const response = await server.inject({
      method: 'POST',
      url: '/run',
      payload: { prompt: 'weather in Lagos' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      output: fakeAgentTaskResult.responseText,
      usage: fakeAgentTaskResult,
    });
  });

  it('returns 500 when the agent task throws', async () => {
    runAgentTaskMock.mockRejectedValueOnce(new Error('model unavailable'));
    const server = await buildTestServer();
    const response = await server.inject({
      method: 'POST',
      url: '/run',
      payload: { prompt: 'hi' },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'model unavailable' });
  });
});

describe('GET /drift', () => {
  it('rejects an unauthorized request', async () => {
    const server = await buildTestServer();
    // Remote, because loopback resolves to the `local` development principal
    // when no login is configured — which is exactly what these tests run as.
    const response = await server.inject({
      method: 'GET',
      url: '/drift',
      remoteAddress: '203.0.113.5',
    });
    expect(response.statusCode).toBe(401);
    expect(detectBehavioralDriftMock).not.toHaveBeenCalled();
  });

  it('returns the drift report on success', async () => {
    const server = await buildTestServer();
    const response = await server.inject({
      method: 'GET',
      url: '/drift',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(fakeDriftReport);
  });
});

describe('rate limiting', () => {
  it('returns 429 once a client exceeds rateLimitMax within the window', async () => {
    const server = await buildTestServer({
      rateLimitMax: 1,
      rateLimitWindowMs: 60_000,
    });
    const first = await server.inject({
      method: 'POST',
      url: '/run',
      payload: { prompt: 'hi' },
    });
    expect(first.statusCode).toBe(200);

    const second = await server.inject({
      method: 'POST',
      url: '/run',
      payload: { prompt: 'hi' },
    });
    expect(second.statusCode).toBe(429);
  });
});

describe('agent-scoped /run and /drift', () => {
  it('bare /run resolves to the auto-registered default agent (picks up its activeModel)', async () => {
    const switchedModel = 'switched-model-client' as unknown as ModelClient;
    const server = await buildTestServer({}, { switched: switchedModel });
    await currentStore!.setAgentState('default', {
      status: 'running',
      activeModel: 'switched',
      activeVersion: 1,
      updatedAt: Date.now(),
    });

    const response = await server.inject({
      method: 'POST',
      url: '/run',
      payload: { prompt: 'hi' },
    });
    expect(response.statusCode).toBe(200);
    expect(runAgentTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({ modelClient: switchedModel }),
    );
  });

  it('/agents/:agentId/run is scoped independently from the default agent and from other agents', async () => {
    const defaultModel = 'default-switched' as unknown as ModelClient;
    const otherModel = 'other-switched' as unknown as ModelClient;
    const server = await buildTestServer(
      {},
      { 'default-model-id': defaultModel, 'other-model-id': otherModel },
    );
    await currentStore!.upsertAgent({ id: 'agent-2', name: 'Agent Two', createdAt: Date.now() });
    await currentStore!.setAgentState('default', {
      status: 'running',
      activeModel: 'default-model-id',
      activeVersion: 1,
      updatedAt: Date.now(),
    });
    await currentStore!.setAgentState('agent-2', {
      status: 'running',
      activeModel: 'other-model-id',
      activeVersion: 1,
      updatedAt: Date.now(),
    });

    await server.inject({
      method: 'POST',
      url: '/agents/agent-2/run',
      payload: { prompt: 'hi' },
    });
    expect(runAgentTaskMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ modelClient: otherModel }),
    );

    await server.inject({
      method: 'POST',
      url: '/run',
      payload: { prompt: 'hi' },
    });
    expect(runAgentTaskMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ modelClient: defaultModel }),
    );
  });

  it('both /agents/:agentId/drift and the bare /drift alias are reachable', async () => {
    const server = await buildTestServer();

    const scoped = await server.inject({
      method: 'GET',
      url: '/agents/default/drift',
    });
    expect(scoped.statusCode).toBe(200);
    expect(scoped.json()).toEqual(fakeDriftReport);

    const bare = await server.inject({
      method: 'GET',
      url: '/drift',
    });
    expect(bare.statusCode).toBe(200);
  });

  it('/agents/:agentId/run 404s for an unregistered agent (does not silently run with no scoping)', async () => {
    const server = await buildTestServer();
    const response = await server.inject({
      method: 'POST',
      url: '/agents/never-registered/run',
      payload: { prompt: 'hi' },
    });
    expect(response.statusCode).toBe(404);
    expect(runAgentTaskMock).not.toHaveBeenCalled();
  });

  it('/agents/:agentId/drift 404s for an unregistered agent', async () => {
    const server = await buildTestServer();
    const response = await server.inject({
      method: 'GET',
      url: '/agents/never-registered/drift',
    });
    expect(response.statusCode).toBe(404);
    expect(detectBehavioralDriftMock).not.toHaveBeenCalled();
  });

  it('resolves each agent\'s own tools/guardrails/agentId, not the global default, per request', async () => {
    const server = await buildTestServer();
    await currentStore!.upsertAgent({
      id: 'restricted-agent',
      name: 'Restricted Agent',
      toolNames: ['get_weather'],
      guardrails: { maxTokensPerTask: 42 },
      createdAt: Date.now(),
    });

    await server.inject({
      method: 'POST',
      url: '/agents/restricted-agent/run',
      payload: { prompt: 'hi' },
    });

    const call = runAgentTaskMock.mock.calls.at(-1)![0];
    expect(call.agentId).toBe('restricted-agent');
    expect(Object.keys(call.tools)).toEqual(['get_weather']);
    expect(call.guardrails.maxTokensPerTask).toBe(42);

    // The default agent (no overrides) still gets the global defaults and every tool.
    await server.inject({
      method: 'POST',
      url: '/run',
      payload: { prompt: 'hi' },
    });
    const defaultCall = runAgentTaskMock.mock.calls.at(-1)![0];
    expect(defaultCall.agentId).toBe('default');
    expect(Object.keys(defaultCall.tools).sort()).toEqual(['get_weather', 'search_docs']);
    expect(defaultCall.guardrails.maxTokensPerTask).toBe(0);
  });

  it('a deny toolPolicies rule makes the built tool throw ToolCallDeniedError instead of executing (the model would see this as a tool error, not a 500)', async () => {
    const server = await buildTestServer();
    await currentStore!.upsertAgent({
      id: 'gated-agent',
      name: 'Gated Agent',
      toolPolicies: [
        { tool: 'get_weather', condition: {}, action: 'deny', severity: 'medium', reason: 'demo deny' },
      ],
      createdAt: Date.now(),
    });

    await server.inject({
      method: 'POST',
      url: '/agents/gated-agent/run',
      payload: { prompt: 'hi' },
    });

    const call = runAgentTaskMock.mock.calls.at(-1)![0];
    expect(call.agentId).toBe('gated-agent');
    // The real buildAgentTools-constructed tool is what generateText would
    // call — since runAgentTask itself is mocked here, exercise it directly.
    await expect(call.tools.get_weather.execute({ city: 'Lagos' }, {})).rejects.toThrow('demo deny');
  });

  it('an agent with no toolPolicies configured gets tools with no policyGate at all (zero overhead, unchanged behavior)', async () => {
    const server = await buildTestServer();
    await server.inject({
      method: 'POST',
      url: '/run',
      payload: { prompt: 'hi' },
    });
    const call = runAgentTaskMock.mock.calls.at(-1)![0];
    const result = await call.tools.get_weather.execute({ city: 'Lagos' }, {});
    expect(result.city).toBe('Lagos');
  });
});
