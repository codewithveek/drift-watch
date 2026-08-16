import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  DriftWatchConfigSchema,
  MemoryStateStore,
  ApprovalService,
  type AgentCycleResult,
  type AutopilotScheduler,
} from '@driftwatch/sdk';
import { registerConsoleRoutes } from './console.js';
import { createAuthGate } from './auth.js';
import { createAuditRecorder } from './audit.js';
import { ServerConfigSchema, type ServerConfig } from '../config/server-config.js';

let app: FastifyInstance | undefined;

function buildServerConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return ServerConfigSchema.parse({ ...overrides });
}

/**
 * Only the two entry points the console routes call. A real AutopilotScheduler
 * would drag in a model client and a metrics source for tests that are about
 * routing and authorization, not drift detection.
 */
function buildStubScheduler(overrides: Partial<AutopilotScheduler> = {}): AutopilotScheduler {
  return {
    async runCycleForAgent(agentId: string): Promise<AgentCycleResult> {
      return { agentId, intents: [] };
    },
    async runCycle() {
      return { results: [] as AgentCycleResult[] };
    },
    start() {},
    stop() {},
    ...overrides,
  } as unknown as AutopilotScheduler;
}

async function buildApp(
  config: ServerConfig = buildServerConfig(),
  options: { scheduler?: AutopilotScheduler } = {},
) {
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
    scheduler: options.scheduler ?? buildStubScheduler(),
    authorize: createAuthGate({ store, authToken: config.authToken }),
    recordAudit: createAuditRecorder(store),
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

  it('auto-generates a human-readable slug id, not a raw UUID', async () => {
    const { fastify } = await buildApp();
    const response = await fastify.inject({
      method: 'POST',
      url: '/agents',
      payload: { name: 'Payment Agent' },
    });
    expect(response.json().agent.id).toMatch(/^payment-agent-[0-9a-f]{6}$/);
  });

  it('re-registering an existing id preserves createdAt and returns 200 (upsert, not reset)', async () => {
    const { fastify } = await buildApp();
    const first = await fastify.inject({
      method: 'POST',
      url: '/agents',
      payload: { id: 'finance-agent-prod', name: 'Finance Agent' },
    });
    expect(first.statusCode).toBe(201);
    const originalCreatedAt = first.json().agent.createdAt;

    const second = await fastify.inject({
      method: 'POST',
      url: '/agents',
      payload: { id: 'finance-agent-prod', name: 'Finance Agent Renamed' },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().agent.name).toBe('Finance Agent Renamed');
    expect(second.json().agent.createdAt).toBe(originalCreatedAt);
  });

  it('rejects unknown toolNames at registration with 400', async () => {
    const { fastify } = await buildApp();
    const response = await fastify.inject({
      method: 'POST',
      url: '/agents',
      payload: { name: 'Bad Tools Agent', toolNames: ['not_a_real_tool'] },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a guardrailsSource that self-references at registration with 400', async () => {
    const { fastify } = await buildApp();
    const response = await fastify.inject({
      method: 'POST',
      url: '/agents',
      payload: { id: 'self-ref-agent', name: 'Self Ref', guardrailsSource: 'self-ref-agent' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a guardrailsSource pointing at a nonexistent agent with 400', async () => {
    const { fastify } = await buildApp();
    const response = await fastify.inject({
      method: 'POST',
      url: '/agents',
      payload: { name: 'Dangling Ref', guardrailsSource: 'does-not-exist' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('accepts toolPolicies referencing a registered tool name, and the wildcard', async () => {
    const { fastify } = await buildApp();
    const response = await fastify.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: 'Gated Agent',
        toolPolicies: [
          { tool: 'get_weather', action: 'deny', severity: 'medium' },
          { tool: '*', action: 'require_approval', severity: 'low' },
        ],
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().agent.toolPolicies).toHaveLength(2);
  });

  it('rejects toolPolicies referencing an unknown tool name with 400', async () => {
    const { fastify } = await buildApp();
    const response = await fastify.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: 'Bad Policy Agent',
        toolPolicies: [{ tool: 'not_a_real_tool', action: 'deny', severity: 'medium' }],
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a toolPoliciesSource that self-references at registration with 400', async () => {
    const { fastify } = await buildApp();
    const response = await fastify.inject({
      method: 'POST',
      url: '/agents',
      payload: { id: 'self-ref-policy', name: 'Self Ref', toolPoliciesSource: 'self-ref-policy' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a toolPoliciesSource pointing at a nonexistent agent with 400', async () => {
    const { fastify } = await buildApp();
    const response = await fastify.inject({
      method: 'POST',
      url: '/agents',
      payload: { name: 'Dangling Policy Ref', toolPoliciesSource: 'does-not-exist' },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('GET /agents/:agentId (raw definition)', () => {
  it('returns the unresolved definition, not the merged/resolved view', async () => {
    const { fastify, store } = await buildApp();
    await store.upsertAgent({
      id: 'agent-1',
      name: 'Agent One',
      guardrailsSource: 'agent-2',
      guardrails: { maxTokensPerTask: 42 },
      toolNames: ['get_weather'],
      createdAt: 1,
    });
    await store.upsertAgent({ id: 'agent-2', name: 'Agent Two', createdAt: 2 });

    const response = await fastify.inject({ method: 'GET', url: '/agents/agent-1' });
    expect(response.statusCode).toBe(200);
    expect(response.json().agent).toMatchObject({
      id: 'agent-1',
      guardrailsSource: 'agent-2',
      guardrails: { maxTokensPerTask: 42 },
      toolNames: ['get_weather'],
    });
  });

  it('404s for an unknown agent', async () => {
    const { fastify } = await buildApp();
    const response = await fastify.inject({ method: 'GET', url: '/agents/unknown' });
    expect(response.statusCode).toBe(404);
  });
});

describe('GET /tools', () => {
  it('returns the server tool registry with policy-authoring metadata', async () => {
    const { fastify } = await buildApp();
    const response = await fastify.inject({ method: 'GET', url: '/tools' });
    expect(response.statusCode).toBe(200);

    const tools = response.json().tools;
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual([
      'get_weather',
      'search_docs',
    ]);
    // `fields` is what lets the console offer a field-scoped policy rule; it is
    // derived from each Zod schema rather than hand-listed, so this also guards
    // against the metadata describing fields the schema no longer has.
    expect(tools[0]).toMatchObject({
      name: 'get_weather',
      fields: ['city'],
      readOnly: true,
      destructive: false,
      idempotent: true,
    });
    expect(tools[1].fields).toEqual(['query']);
  });
});

describe('PATCH /agents/:agentId', () => {
  it('merges guardrails per-field, preserving previously-set fields not touched by this patch', async () => {
    const { fastify, store } = await buildApp();
    await store.upsertAgent({
      id: 'agent-1',
      name: 'Agent One',
      guardrails: { maxTokensPerTask: 100, maxCostUsd: 5 },
      createdAt: 1,
    });

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: { guardrails: { maxCostUsd: 10 } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().agent.guardrails).toEqual({ maxTokensPerTask: 100, maxCostUsd: 10 });
  });

  it('rejects unknown toolNames with 400', async () => {
    const { fastify, store } = await buildApp();
    await store.upsertAgent({ id: 'agent-1', name: 'Agent One', createdAt: 1 });

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: { toolNames: ['not_a_real_tool'] },
    });
    expect(response.statusCode).toBe(400);
  });

  it('404s for an unknown agent', async () => {
    const { fastify } = await buildApp();
    const response = await fastify.inject({
      method: 'PATCH',
      url: '/agents/unknown',
      payload: { name: 'x' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('takes effect immediately in /state — the live-editability claim', async () => {
    const { fastify, store } = await buildApp();
    await store.upsertAgent({ id: 'agent-1', name: 'Agent One', createdAt: 1 });

    const before = await fastify.inject({ method: 'GET', url: '/agents/agent-1/state' });
    expect(before.json().guardrails.maxTokensPerTask).toBe(0);

    await fastify.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: { guardrails: { maxTokensPerTask: 42 } },
    });

    const after = await fastify.inject({ method: 'GET', url: '/agents/agent-1/state' });
    expect(after.json().guardrails.maxTokensPerTask).toBe(42);
  });

  it('toolPolicies is a full replace, not a merge — patching again drops rules not resent', async () => {
    const { fastify, store } = await buildApp();
    await store.upsertAgent({
      id: 'agent-1',
      name: 'Agent One',
      toolPolicies: [{ tool: 'get_weather', condition: {}, action: 'deny', severity: 'medium' }],
      createdAt: 1,
    });

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: {
        toolPolicies: [{ tool: 'search_docs', condition: {}, action: 'require_approval', severity: 'low' }],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().agent.toolPolicies).toEqual([
      { tool: 'search_docs', condition: {}, action: 'require_approval', severity: 'low' },
    ]);
  });

  it('rejects toolPolicies referencing an unknown tool name with 400', async () => {
    const { fastify, store } = await buildApp();
    await store.upsertAgent({ id: 'agent-1', name: 'Agent One', createdAt: 1 });

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: { toolPolicies: [{ tool: 'not_a_real_tool', action: 'deny', severity: 'medium' }] },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a toolPoliciesSource self-reference with 400', async () => {
    const { fastify, store } = await buildApp();
    await store.upsertAgent({ id: 'agent-1', name: 'Agent One', createdAt: 1 });

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      payload: { toolPoliciesSource: 'agent-1' },
    });
    expect(response.statusCode).toBe(400);
  });
});

/*
 * The console mirrors these envelope shapes in packages/console/src/api.ts.
 * Entity types come from @driftwatch/sdk and cannot drift, but the wrappers
 * exist only inline in this file — these tests are what stop them drifting
 * silently the way the old hand-copied console types did.
 */
describe('response envelope shapes (pinned for packages/console/src/api.ts)', () => {
  it('GET /agents/:agentId/state returns exactly the documented keys', async () => {
    const { fastify, store } = await buildApp();
    await store.upsertAgent({ id: 'agent-1', name: 'Agent One', createdAt: 1 });

    const body = (await fastify.inject({ method: 'GET', url: '/agents/agent-1/state' })).json();
    expect(Object.keys(body).sort()).toEqual([
      'agent',
      'autopilot',
      'guardrails',
      'overriddenFields',
      'toolNames',
      'toolPolicies',
    ]);
    expect(Object.keys(body.autopilot).sort()).toEqual(['enabled', 'mode', 'scanIntervalMs']);
    // The full resolved AgentConfig — the old console type carried only 3 of these 6.
    expect(Object.keys(body.guardrails).sort()).toEqual([
      'maxCostUsd',
      'maxSteps',
      'maxTokensPerTask',
      'onExceed',
      'pricePer1kInput',
      'pricePer1kOutput',
    ]);
  });

  it('list endpoints use the wrapper keys the console expects', async () => {
    const { fastify, store } = await buildApp();
    await store.upsertAgent({ id: 'agent-1', name: 'Agent One', createdAt: 1 });

    const at = async (url: string) => Object.keys((await fastify.inject({ method: 'GET', url })).json());
    expect(await at('/agents')).toEqual(['agents']);
    expect(await at('/tools')).toEqual(['tools']);
    // Both layers plus the derived marker list — the Config form edits the
    // override and shows the declaration underneath, so it needs all three.
    expect(await at('/agents/agent-1')).toEqual(['agent', 'override', 'overriddenFields']);
    expect(await at('/agents/agent-1/approvals')).toEqual(['approvals']);
    expect(await at('/agents/agent-1/drift/history')).toEqual(['history']);
    expect(await at('/agents/agent-1/actions/log')).toEqual(['log']);
    expect(await at('/agents/agent-1/tool-calls/pending')).toEqual(['toolCalls']);
  });
});

describe('tool-call approvals', () => {
  it('GET /agents/:agentId/tool-calls/pending lists only pending ones for that agent', async () => {
    const { fastify, store } = await buildApp();
    await store.upsertAgent({ id: 'agent-1', name: 'Agent One', createdAt: 1 });
    await store.upsertAgent({ id: 'agent-2', name: 'Agent Two', createdAt: 2 });
    await store.createToolCallApproval({
      id: 'tc-1',
      agentId: 'agent-1',
      tool: 'refund_payment',
      status: 'pending',
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
    });
    await store.createToolCallApproval({
      id: 'tc-2',
      agentId: 'agent-2',
      tool: 'refund_payment',
      status: 'pending',
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
    });

    const response = await fastify.inject({ method: 'GET', url: '/agents/agent-1/tool-calls/pending' });
    expect(response.statusCode).toBe(200);
    expect(response.json().toolCalls.map((t: { id: string }) => t.id)).toEqual(['tc-1']);
  });

  it('POST /agents/:agentId/tool-calls/:id/resolve approves without executing a control action', async () => {
    const { fastify, store } = await buildApp();
    await store.upsertAgent({ id: 'agent-1', name: 'Agent One', createdAt: 1 });
    await store.createToolCallApproval({
      id: 'tc-1',
      agentId: 'agent-1',
      tool: 'refund_payment',
      status: 'pending',
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
    });

    const response = await fastify.inject({
      method: 'POST',
      url: '/agents/agent-1/tool-calls/tc-1/resolve',
      payload: { decision: 'approved' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().toolCall.status).toBe('approved');
    // Approving a tool-call approval must not touch agent runtime status —
    // there's no control action here, only a status flip.
    expect((await store.getAgentState('agent-1')).status).toBe('running');
  });

  it('404s resolving a tool-call approval that belongs to a different agent', async () => {
    const { fastify, store } = await buildApp();
    await store.upsertAgent({ id: 'agent-1', name: 'Agent One', createdAt: 1 });
    await store.upsertAgent({ id: 'agent-2', name: 'Agent Two', createdAt: 2 });
    await store.createToolCallApproval({
      id: 'tc-1',
      agentId: 'agent-2',
      tool: 'refund_payment',
      status: 'pending',
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
    });

    const response = await fastify.inject({
      method: 'POST',
      url: '/agents/agent-1/tool-calls/tc-1/resolve',
      payload: { decision: 'approved' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('409s resolving an already-resolved tool-call approval', async () => {
    const { fastify, store } = await buildApp();
    await store.upsertAgent({ id: 'agent-1', name: 'Agent One', createdAt: 1 });
    await store.createToolCallApproval({
      id: 'tc-1',
      agentId: 'agent-1',
      tool: 'refund_payment',
      status: 'pending',
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
    });
    await store.resolveToolCallApproval('tc-1', 'rejected', 'someone-else', 'console');

    const response = await fastify.inject({
      method: 'POST',
      url: '/agents/agent-1/tool-calls/tc-1/resolve',
      payload: { decision: 'approved' },
    });
    expect(response.statusCode).toBe(409);
  });

  it('rejects an invalid decision with 400', async () => {
    const { fastify, store } = await buildApp();
    await store.upsertAgent({ id: 'agent-1', name: 'Agent One', createdAt: 1 });
    const response = await fastify.inject({
      method: 'POST',
      url: '/agents/agent-1/tool-calls/tc-1/resolve',
      payload: { decision: 'maybe' },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('guardrailsSource resolution at /state', () => {
  it('uses the referenced agent\'s guardrails as the baseline', async () => {
    const { fastify, store } = await buildApp();
    await store.upsertAgent({
      id: 'source-agent',
      name: 'Source Agent',
      guardrails: { maxTokensPerTask: 500, maxCostUsd: 3 },
      createdAt: 1,
    });
    await store.upsertAgent({
      id: 'derived-agent',
      name: 'Derived Agent',
      guardrailsSource: 'source-agent',
      createdAt: 2,
    });

    const response = await fastify.inject({ method: 'GET', url: '/agents/derived-agent/state' });
    expect(response.json().guardrails.maxTokensPerTask).toBe(500);
    expect(response.json().guardrails.maxCostUsd).toBe(3);
  });

  it('a local guardrails override wins per-field over the source, while unset fields still inherit', async () => {
    const { fastify, store } = await buildApp();
    await store.upsertAgent({
      id: 'source-agent',
      name: 'Source Agent',
      guardrails: { maxTokensPerTask: 500, maxCostUsd: 3 },
      createdAt: 1,
    });
    await store.upsertAgent({
      id: 'derived-agent',
      name: 'Derived Agent',
      guardrailsSource: 'source-agent',
      guardrails: { maxTokensPerTask: 42 },
      createdAt: 2,
    });

    const response = await fastify.inject({ method: 'GET', url: '/agents/derived-agent/state' });
    expect(response.json().guardrails.maxTokensPerTask).toBe(42); // local override wins
    expect(response.json().guardrails.maxCostUsd).toBe(3); // inherited from source
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

describe('manual drift scans with autopilot disabled', () => {
  it('scans on demand instead of 503ing — the scheduler is always constructed', async () => {
    // Regression: AUTOPILOT_ENABLED defaults to 0 in every compose file, and
    // the scheduler used to be built only when it was 1 — so the console's
    // always-enabled "Scan now" button 503'd on a default deployment. The flag
    // now gates only the periodic loop; see autopilot/index.ts.
    const { fastify, store } = await buildApp(buildServerConfig({ autopilotEnabled: false }));
    await store.upsertAgent({ id: 'agent-1', name: 'Agent One', createdAt: 1 });

    const scoped = await fastify.inject({ method: 'POST', url: '/agents/agent-1/drift/scan' });
    expect(scoped.statusCode).toBe(200);

    const fleetWide = await fastify.inject({ method: 'POST', url: '/drift/scan' });
    expect(fleetWide.statusCode).toBe(200);
  });

  it('still 503s the per-agent scan when that agent has drift detection off', async () => {
    const { fastify, store } = await buildApp(
      buildServerConfig(),
      {
        scheduler: buildStubScheduler({
          async runCycleForAgent(agentId: string) {
            return { agentId, intents: [], skipped: 'disabled' as const };
          },
        }),
      },
    );
    await store.upsertAgent({ id: 'agent-1', name: 'Agent One', createdAt: 1 });

    const response = await fastify.inject({ method: 'POST', url: '/agents/agent-1/drift/scan' });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toContain('drift detection disabled');
  });
});
