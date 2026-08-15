/**
 * Layered configuration, at the HTTP boundary.
 *
 * The conformance suite already proves the STORE keeps a baseline and an
 * override apart. These tests prove the routes actually use that separation —
 * which is where the property that matters lives: a console edit must survive
 * the next deploy, and a deploy must not silently revert an operator's
 * incident-time change.
 */
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
import { ServerConfigSchema } from '../config/server-config.js';
import { getEffectiveAgent } from '../state/effective-agent.js';

let app: FastifyInstance | undefined;

async function buildApp() {
  const store = new MemoryStateStore();
  const config = ServerConfigSchema.parse({});
  const fastify = Fastify({ logger: false });
  await registerConsoleRoutes(fastify, {
    store,
    serverConfig: config,
    driftWatchConfig: DriftWatchConfigSchema.parse({}),
    approvalService: new ApprovalService({
      store,
      notifiers: { list: [] },
      approvalTimeoutMs: 60_000,
      timeoutDecision: 'rejected',
    }),
    scheduler: {
      async runCycleForAgent(agentId: string): Promise<AgentCycleResult> {
        return { agentId, intents: [] };
      },
      async runCycle() {
        return { results: [] as AgentCycleResult[] };
      },
      start() {},
      stop() {},
    } as unknown as AutopilotScheduler,
    authorize: createAuthGate({ store, authToken: config.authToken }),
    recordAudit: createAuditRecorder(store),
  });
  await fastify.ready();
  app = fastify;
  return { fastify, store };
}

/** Registers an agent the way an SDK client would, with a code-declared baseline. */
async function register(fastify: FastifyInstance, guardrails: Record<string, unknown>) {
  return fastify.inject({
    method: 'POST',
    url: '/agents',
    payload: { id: 'payments', name: 'Payments', guardrails },
  });
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('layered agent configuration', () => {
  it('a console PATCH writes an override, leaving the baseline untouched', async () => {
    const { fastify, store } = await buildApp();
    await register(fastify, { maxSteps: 10 });

    const patched = await fastify.inject({
      method: 'PATCH',
      url: '/agents/payments',
      payload: { guardrails: { maxSteps: 2 } },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().agent.guardrails).toMatchObject({ maxSteps: 2 });

    // The declared value is preserved, which is what makes reverting possible
    // without the code having to be consulted.
    expect((await store.getAgentDefinition('payments'))?.guardrails).toEqual({ maxSteps: 10 });
    expect((await store.getAgentOverride('payments'))?.guardrails).toEqual({ maxSteps: 2 });
  });

  it('an operator edit SURVIVES a redeploy that re-pushes the baseline', async () => {
    const { fastify, store } = await buildApp();
    await register(fastify, { maxSteps: 10 });
    await fastify.inject({
      method: 'PATCH',
      url: '/agents/payments',
      payload: { guardrails: { maxSteps: 2 } },
    });

    // The deploy: same agent id, a new baseline from code.
    const redeployed = await register(fastify, { maxSteps: 20 });
    expect(redeployed.statusCode).toBe(200);

    // This is the whole point of the layering. Under a "code wins" model this
    // would be 20, and an operator who tightened a cap during an incident would
    // have it silently undone by an unrelated deploy.
    const effective = await getEffectiveAgent(store, 'payments');
    expect(effective?.guardrails).toEqual({ maxSteps: 2 });
  });

  it('reports which fields are overridden so the console can mark them', async () => {
    const { fastify } = await buildApp();
    await register(fastify, { maxSteps: 10 });

    const before = await fastify.inject({ method: 'GET', url: '/agents/payments/state' });
    expect(before.json().overriddenFields).toEqual([]);

    await fastify.inject({
      method: 'PATCH',
      url: '/agents/payments',
      payload: { guardrails: { maxSteps: 2 }, driftDetectionEnabled: false },
    });

    const after = await fastify.inject({ method: 'GET', url: '/agents/payments/state' });
    expect(after.json().overriddenFields.sort()).toEqual(['driftDetectionEnabled', 'guardrails']);
    expect(after.json().guardrails.maxSteps).toBe(2);
  });

  it('reverting drops the override and falls back to the declared config', async () => {
    const { fastify, store } = await buildApp();
    await register(fastify, { maxSteps: 10 });
    await fastify.inject({
      method: 'PATCH',
      url: '/agents/payments',
      payload: { guardrails: { maxSteps: 2 } },
    });

    const reverted = await fastify.inject({ method: 'DELETE', url: '/agents/payments/override' });
    expect(reverted.statusCode).toBe(200);
    expect(reverted.json().cleared).toBe(true);

    expect((await getEffectiveAgent(store, 'payments'))?.guardrails).toEqual({ maxSteps: 10 });
    expect((await fastify.inject({ method: 'GET', url: '/agents/payments/state' })).json()
      .overriddenFields).toEqual([]);
  });

  it('reverting an agent with no override is a successful no-op, not a 404', async () => {
    const { fastify } = await buildApp();
    await register(fastify, { maxSteps: 10 });
    const response = await fastify.inject({ method: 'DELETE', url: '/agents/payments/override' });
    expect(response.statusCode).toBe(200);
    expect(response.json().cleared).toBe(false);
  });

  it('merges guardrails per-field but replaces tool policies wholesale', async () => {
    const { fastify, store } = await buildApp();
    await register(fastify, { maxSteps: 10, maxCostUsd: 1 });

    await fastify.inject({
      method: 'PATCH',
      url: '/agents/payments',
      payload: { guardrails: { maxSteps: 2 }, toolPolicies: [{ tool: '*', action: 'deny', severity: 'high' }] },
    });
    await fastify.inject({
      method: 'PATCH',
      url: '/agents/payments',
      payload: { guardrails: { maxCostUsd: 5 } },
    });

    const override = await store.getAgentOverride('payments');
    // Guardrails accumulate: patching one field must not silently drop another
    // set moments earlier in the same session.
    expect(override?.guardrails).toEqual({ maxSteps: 2, maxCostUsd: 5 });
    // The rule list is untouched by a guardrails-only patch.
    expect(override?.toolPolicies).toHaveLength(1);
  });

  it('deletes an override that no longer changes anything', async () => {
    const { fastify, store } = await buildApp();
    await register(fastify, { maxSteps: 10 });
    // A patch carrying no overridable field leaves nothing to override; storing
    // an empty row would keep the console's "overridden" badge lit forever.
    await fastify.inject({ method: 'PATCH', url: '/agents/payments', payload: { name: 'Renamed' } });

    expect(await store.getAgentOverride('payments')).toBeUndefined();
    expect((await store.getAgentDefinition('payments'))?.name).toBe('Renamed');
  });

  it('refuses to override the inheritance source fields', async () => {
    const { fastify, store } = await buildApp();
    await register(fastify, { maxSteps: 10 });
    await fastify.inject({ method: 'POST', url: '/agents', payload: { id: 'shared', name: 'Shared' } });

    const response = await fastify.inject({
      method: 'PATCH',
      url: '/agents/payments',
      payload: { guardrailsSource: 'shared' },
    });
    expect(response.statusCode).toBe(400);
    // Rejected BEFORE any write — a validation failure must not leave a
    // half-applied override behind.
    expect(await store.getAgentOverride('payments')).toBeUndefined();
  });

  it('identity edits still write to the baseline, not the override', async () => {
    const { fastify, store } = await buildApp();
    await register(fastify, { maxSteps: 10 });
    await fastify.inject({
      method: 'PATCH',
      url: '/agents/payments',
      payload: { name: 'Payments v2', owner: 'platform' },
    });

    const baseline = await store.getAgentDefinition('payments');
    expect(baseline).toMatchObject({ name: 'Payments v2', owner: 'platform' });
    expect(await store.getAgentOverride('payments')).toBeUndefined();
  });
});
