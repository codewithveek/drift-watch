import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { DriftWatchConfigSchema, MemoryStateStore, type ModelClient } from '@driftwatch/sdk';
import { registerRoutes } from './agent.js';
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
    port: 3000,
    host: '0.0.0.0',
    logLevel: 'silent',
    bodyLimitBytes: 131072,
    trustProxy: false,
    authToken: '',
    maxPromptBytes: 8192,
    driftDryRun: false,
    rateLimitMax: 100,
    rateLimitWindowMs: 60_000,
    ...overrides,
  };
}

let currentServer: FastifyInstance | undefined;

async function buildTestServer(
  serverConfigOverrides: Partial<ServerConfig> = {},
): Promise<FastifyInstance> {
  const serverConfig = buildServerConfig(serverConfigOverrides);
  const fastifyServer = Fastify({ logger: false });
  await fastifyServer.register(rateLimit, {
    global: false,
    max: serverConfig.rateLimitMax,
    timeWindow: serverConfig.rateLimitWindowMs,
  });
  await registerRoutes(fastifyServer, {
    modelClient: 'fake-model' as unknown as ModelClient,
    modelRegistry: {},
    store: new MemoryStateStore(),
    tools: {},
    serverConfig,
    driftWatchConfig: DriftWatchConfigSchema.parse({}),
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
  it('rejects a remote client when AUTH_TOKEN is unset', async () => {
    const server = await buildTestServer({ authToken: '' });
    const response = await server.inject({
      method: 'POST',
      url: '/run',
      remoteAddress: '203.0.113.5',
      payload: { prompt: 'hi' },
    });
    expect(response.statusCode).toBe(401);
    expect(runAgentTaskMock).not.toHaveBeenCalled();
  });

  it('allows loopback when AUTH_TOKEN is unset', async () => {
    const server = await buildTestServer({ authToken: '' });
    const response = await server.inject({
      method: 'POST',
      url: '/run',
      remoteAddress: '127.0.0.1',
      payload: { prompt: 'hi' },
    });
    expect(response.statusCode).toBe(200);
  });

  it('allows the RFC 1918 172.16.0.0/12 range when AUTH_TOKEN is unset', async () => {
    const server = await buildTestServer({ authToken: '' });
    const response = await server.inject({
      method: 'POST',
      url: '/run',
      remoteAddress: '172.20.0.5',
      payload: { prompt: 'hi' },
    });
    expect(response.statusCode).toBe(200);
  });

  it('rejects 172.x addresses outside the private /12 range (regression: not just a "172." prefix match)', async () => {
    const server = await buildTestServer({ authToken: '' });
    const response = await server.inject({
      method: 'POST',
      url: '/run',
      remoteAddress: '172.32.0.5',
      payload: { prompt: 'hi' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a missing/wrong bearer token when AUTH_TOKEN is set', async () => {
    const server = await buildTestServer({ authToken: 'correct-secret' });
    const wrongToken = await server.inject({
      method: 'POST',
      url: '/run',
      remoteAddress: '203.0.113.5',
      headers: { authorization: 'Bearer wrong-secret' },
      payload: { prompt: 'hi' },
    });
    expect(wrongToken.statusCode).toBe(401);

    const noHeader = await server.inject({
      method: 'POST',
      url: '/run',
      remoteAddress: '203.0.113.5',
      payload: { prompt: 'hi' },
    });
    expect(noHeader.statusCode).toBe(401);
    expect(runAgentTaskMock).not.toHaveBeenCalled();
  });

  it('accepts a correct bearer token from a non-local address', async () => {
    const server = await buildTestServer({ authToken: 'correct-secret' });
    const response = await server.inject({
      method: 'POST',
      url: '/run',
      remoteAddress: '203.0.113.5',
      headers: { authorization: 'Bearer correct-secret' },
      payload: { prompt: 'hi' },
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('POST /run', () => {
  it('rejects a missing prompt with 400', async () => {
    const server = await buildTestServer({ authToken: 'secret' });
    const response = await server.inject({
      method: 'POST',
      url: '/run',
      headers: { authorization: 'Bearer secret' },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect(runAgentTaskMock).not.toHaveBeenCalled();
  });

  it('rejects a prompt over maxPromptBytes with 413', async () => {
    const server = await buildTestServer({ authToken: 'secret', maxPromptBytes: 8 });
    const response = await server.inject({
      method: 'POST',
      url: '/run',
      headers: { authorization: 'Bearer secret' },
      payload: { prompt: 'way more than eight bytes' },
    });
    expect(response.statusCode).toBe(413);
    expect(runAgentTaskMock).not.toHaveBeenCalled();
  });

  it('returns the agent task result on success', async () => {
    const server = await buildTestServer({ authToken: 'secret' });
    const response = await server.inject({
      method: 'POST',
      url: '/run',
      headers: { authorization: 'Bearer secret' },
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
    const server = await buildTestServer({ authToken: 'secret' });
    const response = await server.inject({
      method: 'POST',
      url: '/run',
      headers: { authorization: 'Bearer secret' },
      payload: { prompt: 'hi' },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'model unavailable' });
  });
});

describe('GET /drift', () => {
  it('rejects an unauthorized request', async () => {
    const server = await buildTestServer({ authToken: 'secret' });
    const response = await server.inject({ method: 'GET', url: '/drift' });
    expect(response.statusCode).toBe(401);
    expect(detectBehavioralDriftMock).not.toHaveBeenCalled();
  });

  it('returns the drift report on success', async () => {
    const server = await buildTestServer({ authToken: 'secret' });
    const response = await server.inject({
      method: 'GET',
      url: '/drift',
      headers: { authorization: 'Bearer secret' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(fakeDriftReport);
  });
});

describe('rate limiting', () => {
  it('returns 429 once a client exceeds rateLimitMax within the window', async () => {
    const server = await buildTestServer({
      authToken: 'secret',
      rateLimitMax: 1,
      rateLimitWindowMs: 60_000,
    });
    const first = await server.inject({
      method: 'POST',
      url: '/run',
      headers: { authorization: 'Bearer secret' },
      payload: { prompt: 'hi' },
    });
    expect(first.statusCode).toBe(200);

    const second = await server.inject({
      method: 'POST',
      url: '/run',
      headers: { authorization: 'Bearer secret' },
      payload: { prompt: 'hi' },
    });
    expect(second.statusCode).toBe(429);
  });
});
