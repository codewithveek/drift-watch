import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { DriftWatchConfigSchema, MemoryStateStore, ApprovalService } from '@driftwatch/sdk';
import { registerConsoleRoutes } from './console.js';
import { ServerConfigSchema, type ServerConfig } from '../config/server-config.js';

let app: FastifyInstance | undefined;

function buildServerConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return ServerConfigSchema.parse({ ...overrides });
}

async function buildApp(config: ServerConfig = buildServerConfig()) {
  const store = new MemoryStateStore();
  const approvalService = new ApprovalService({
    store,
    notifiers: { list: [] },
    approvalTimeoutMs: 60_000,
    timeoutDecision: 'rejected',
  });
  const fastify = Fastify({ logger: false });
  await registerConsoleRoutes(fastify, {
    store,
    serverConfig: config,
    driftWatchConfig: DriftWatchConfigSchema.parse({}),
    approvalService,
  });
  await fastify.ready();
  app = fastify;
  return { fastify, store, approvalService };
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET/POST /agents', () => {
  it('starts empty and lists agents after registering them', async () => {
    const { fastify } = await buildApp();

    const empty = await fastify.inject({ method: 'GET', url: '/agents' });
    expect(empty.json()).toEqual({ agents: [] });

    const created = await fastify.inject({
      method: 'POST',
      url: '/agents',
      payload: { name: 'Finance Agent', owner: 'finance-ops', serviceName: 'finance-svc' },
    });
    expect(created.statusCode).toBe(201);
    const { agent } = created.json();
    expect(agent.name).toBe('Finance Agent');
    expect(agent.id).toMatch(/^[a-zA-Z0-9_-]+$/); // auto-generated

    const listed = await fastify.inject({ method: 'GET', url: '/agents' });
    expect(listed.json().agents).toHaveLength(1);
  });

  it('rejects registration with no name', async () => {
    const { fastify } = await buildApp();
    const response = await fastify.inject({ method: 'POST', url: '/agents', payload: {} });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a custom id that does not match the safe pattern', async () => {
    const { fastify } = await buildApp();
    const response = await fastify.inject({
      method: 'POST',
      url: '/agents',
      payload: { id: 'has a space', name: 'Bad Id' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('accepts a valid custom id', async () => {
    const { fastify } = await buildApp();
    const response = await fastify.inject({
      method: 'POST',
      url: '/agents',
      payload: { id: 'finance-agent-prod', name: 'Finance Agent' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().agent.id).toBe('finance-agent-prod');
  });
});

describe('per-agent routes 404 on an unknown agentId', () => {
  it.each([
    ['GET', '/agents/unknown/state'],
    ['GET', '/agents/unknown/drift/history'],
    ['GET', '/agents/unknown/approvals'],
    ['GET', '/agents/unknown/actions/log'],
    ['POST', '/agents/unknown/control/pause'],
  ] as const)('%s %s -> 404', async (method, url) => {
    const { fastify } = await buildApp();
    const response = await fastify.inject({ method, url });
    expect(response.statusCode).toBe(404);
  });
});

describe('cross-agent isolation', () => {
  it('pausing one agent leaves another agent untouched', async () => {
    const { fastify, store } = await buildApp();
    await store.upsertAgent({ id: 'agent-1', name: 'Agent One', createdAt: 1 });
    await store.upsertAgent({ id: 'agent-2', name: 'Agent Two', createdAt: 2 });

    const pause = await fastify.inject({ method: 'POST', url: '/agents/agent-1/control/pause' });
    expect(pause.statusCode).toBe(200);
    expect(pause.json().state.status).toBe('paused');

    const stateOne = await fastify.inject({ method: 'GET', url: '/agents/agent-1/state' });
    expect(stateOne.json().agent.status).toBe('paused');

    const stateTwo = await fastify.inject({ method: 'GET', url: '/agents/agent-2/state' });
    expect(stateTwo.json().agent.status).toBe('running'); // untouched
  });

  it('keeps drift history and action log isolated between agents', async () => {
    const { fastify, store } = await buildApp();
    await store.upsertAgent({ id: 'agent-1', name: 'Agent One', createdAt: 1 });
    await store.upsertAgent({ id: 'agent-2', name: 'Agent Two', createdAt: 2 });

    await store.recordDriftVerdict('agent-1', {
      id: 'd1',
      at: 1,
      drift: true,
      severity: 'high',
      reasons: [],
      recommendedAction: '',
      baselineTokenSpend: 0,
      currentTokenSpend: 0,
    });

    const historyOne = await fastify.inject({ method: 'GET', url: '/agents/agent-1/drift/history' });
    expect(historyOne.json().history).toHaveLength(1);

    const historyTwo = await fastify.inject({ method: 'GET', url: '/agents/agent-2/drift/history' });
    expect(historyTwo.json().history).toHaveLength(0);

    // action log: control/pause on agent-1 writes one entry there only.
    await fastify.inject({ method: 'POST', url: '/agents/agent-1/control/pause' });
    const logOne = await fastify.inject({ method: 'GET', url: '/agents/agent-1/actions/log' });
    expect(logOne.json().log).toHaveLength(1);
    const logTwo = await fastify.inject({ method: 'GET', url: '/agents/agent-2/actions/log' });
    expect(logTwo.json().log).toHaveLength(0);
  });

  it('lists and resolves approvals scoped to the correct agent', async () => {
    const { fastify, store, approvalService } = await buildApp();
    await store.upsertAgent({ id: 'agent-1', name: 'Agent One', createdAt: 1 });
    await store.upsertAgent({ id: 'agent-2', name: 'Agent Two', createdAt: 2 });

    const approvalOne = await approvalService.requestApproval('agent-1', {
      type: 'pause_agent',
      category: 'control',
      severity: 'high',
      reason: 'spike',
    });
    const approvalTwo = await approvalService.requestApproval('agent-2', {
      type: 'pause_agent',
      category: 'control',
      severity: 'high',
      reason: 'spike',
    });

    const pendingOne = await fastify.inject({ method: 'GET', url: '/agents/agent-1/approvals' });
    expect(pendingOne.json().approvals.map((a: { id: string }) => a.id)).toEqual([approvalOne.id]);

    // Resolving agent-2's approval via agent-1's path must 404, not silently
    // resolve the wrong agent's approval.
    const mismatched = await fastify.inject({
      method: 'POST',
      url: `/agents/agent-1/approvals/${approvalTwo.id}/resolve`,
      payload: { decision: 'approved' },
    });
    expect(mismatched.statusCode).toBe(404);

    const stillPendingTwo = await fastify.inject({ method: 'GET', url: '/agents/agent-2/approvals' });
    expect(stillPendingTwo.json().approvals).toHaveLength(1); // untouched by the mismatched attempt

    const resolved = await fastify.inject({
      method: 'POST',
      url: `/agents/agent-2/approvals/${approvalTwo.id}/resolve`,
      payload: { decision: 'approved' },
    });
    expect(resolved.statusCode).toBe(200);

    const stateTwo = await fastify.inject({ method: 'GET', url: '/agents/agent-2/state' });
    expect(stateTwo.json().agent.status).toBe('paused');
    const stateOne = await fastify.inject({ method: 'GET', url: '/agents/agent-1/state' });
    expect(stateOne.json().agent.status).toBe('running'); // untouched
  });
});

describe('drift scans without a scheduler', () => {
  it('returns 503 for both the single-agent and fleet-wide scan routes', async () => {
    const { fastify, store } = await buildApp();
    await store.upsertAgent({ id: 'agent-1', name: 'Agent One', createdAt: 1 });

    const scoped = await fastify.inject({ method: 'POST', url: '/agents/agent-1/drift/scan' });
    expect(scoped.statusCode).toBe(503);

    const fleetWide = await fastify.inject({ method: 'POST', url: '/drift/scan' });
    expect(fleetWide.statusCode).toBe(503);
  });
});
