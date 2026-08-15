/**
 * StateStore conformance suite.
 *
 * The same assertions run against every backend, because the composition root
 * picks exactly one and the rest of the server is written against the interface.
 * If Memory and Postgres disagree about anything here — resolve idempotency,
 * list ordering, whether an absent optional comes back as `undefined` or `null`
 * — then "choose a backend" silently means "choose a set of bugs", and the
 * difference surfaces in production rather than in CI.
 *
 * Postgres is skipped unless TEST_DATABASE_URL is set, so a contributor with no
 * database still gets the memory backend verified. CI sets it.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStateStore } from '@driftwatch/sdk';
import type {
  ActionLogEntry,
  AgentDefinition,
  ApiKeyRecord,
  Approval,
  AuditEvent,
  DriftHistoryEntry,
  StateStore,
  ToolCallApproval,
} from '@driftwatch/sdk';
import { sql } from 'drizzle-orm';
import { createDatabase, type DatabaseHandle } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { seedOrganization } from '../db/seed.js';
import { PostgresStateStore } from '../db/postgres-store.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function anApiKey(overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    id: 'key-1',
    name: 'CI deploy key',
    prefix: 'dw_abcd1234',
    hash: 'hash-1',
    scopes: ['read'],
    createdAt: 1_000,
    createdBy: 'root',
    ...overrides,
  };
}

function anApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: 'ap-1',
    agentId: 'agent-a',
    action: 'pause_agent',
    severity: 'high',
    reasons: ['token spend up 300%'],
    recommendedAction: 'pause',
    status: 'pending',
    createdAt: 1_000,
    expiresAt: 9_999_999_999_999,
    ...overrides,
  };
}

function aToolCall(overrides: Partial<ToolCallApproval> = {}): ToolCallApproval {
  return {
    id: 'tc-1',
    agentId: 'agent-a',
    tool: 'issue_refund',
    status: 'pending',
    createdAt: 1_000,
    expiresAt: 9_999_999_999_999,
    ...overrides,
  };
}

function aDriftEntry(overrides: Partial<DriftHistoryEntry> = {}): DriftHistoryEntry {
  return {
    id: 'dh-1',
    at: 1_000,
    drift: true,
    severity: 'medium',
    reasons: ['p95 latency doubled'],
    recommendedAction: 'notify',
    baselineTokenSpend: 100,
    currentTokenSpend: 250,
    ...overrides,
  };
}

function anAction(overrides: Partial<ActionLogEntry> = {}): ActionLogEntry {
  return {
    id: 'al-1',
    at: 1_000,
    action: 'notify_slack',
    category: 'notify',
    outcome: 'executed',
    reason: 'drift detected',
    ...overrides,
  };
}

function anAuditEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: 'ae-1',
    at: 1_000,
    actor: 'root',
    actorLabel: 'AUTH_TOKEN',
    action: 'agent.create',
    summary: 'registered agent-a',
    ...overrides,
  };
}

function anAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return { id: 'agent-a', name: 'Agent A', createdAt: 1_000, ...overrides };
}

/** Every assertion any StateStore must satisfy. */
function describeStateStore(backend: string, getStore: () => StateStore): void {
  describe(`StateStore conformance: ${backend}`, () => {
    // --- API keys -----------------------------------------------------------

    it('looks a key up by hash and by id', async () => {
      const store = getStore();
      await store.createApiKey(anApiKey());
      expect(await store.getApiKeyByHash('hash-1')).toMatchObject({ id: 'key-1', name: 'CI deploy key' });
      expect(await store.getApiKey('key-1')).toMatchObject({ hash: 'hash-1' });
      expect(await store.getApiKeyByHash('nope')).toBeUndefined();
    });

    it('lists keys newest first', async () => {
      const store = getStore();
      await store.createApiKey(anApiKey({ id: 'old', hash: 'h-old', createdAt: 1_000 }));
      await store.createApiKey(anApiKey({ id: 'new', hash: 'h-new', createdAt: 2_000 }));
      expect((await store.listApiKeys()).map((key) => key.id)).toEqual(['new', 'old']);
    });

    it('revokes a key once, and still resolves it by hash afterwards', async () => {
      const store = getStore();
      await store.createApiKey(anApiKey());

      const revoked = await store.revokeApiKey('key-1', 'admin');
      expect(revoked?.revokedAt).toBeTypeOf('number');
      expect(revoked?.revokedBy).toBe('admin');

      // Idempotency guard: a second revoke is a no-op, not a second stamp.
      expect(await store.revokeApiKey('key-1', 'someone-else')).toBeUndefined();

      // The gate must still be able to say "revoked" rather than "unknown".
      expect(await store.getApiKeyByHash('hash-1')).toMatchObject({ revokedBy: 'admin' });
    });

    it('records a coarse last-used stamp', async () => {
      const store = getStore();
      await store.createApiKey(anApiKey());
      await store.touchApiKey('key-1', 5_000);
      expect((await store.getApiKey('key-1'))?.lastUsedAt).toBe(5_000);
      // Touching an unknown key must not throw — auth swallows store hiccups.
      await expect(store.touchApiKey('ghost', 1)).resolves.toBeUndefined();
    });

    it('leaves absent optional fields undefined, never null', async () => {
      const store = getStore();
      await store.createApiKey(anApiKey());
      const record = await store.getApiKey('key-1');
      // `null` here would break every `x === undefined` check in the gate.
      expect(record?.agentIds).toBeUndefined();
      expect(record?.expiresAt).toBeUndefined();
      expect(record?.revokedAt).toBeUndefined();
      expect(record?.lastUsedAt).toBeUndefined();
    });

    // --- audit --------------------------------------------------------------

    it('lists audit events newest first, honouring limit and agent filter', async () => {
      const store = getStore();
      await store.recordAuditEvent(anAuditEvent({ id: 'e1', agentId: 'agent-a' }));
      await store.recordAuditEvent(anAuditEvent({ id: 'e2', agentId: 'agent-b' }));
      await store.recordAuditEvent(anAuditEvent({ id: 'e3', agentId: 'agent-a' }));

      expect((await store.listAuditEvents(10)).map((event) => event.id)).toEqual(['e3', 'e2', 'e1']);
      expect((await store.listAuditEvents(2)).map((event) => event.id)).toEqual(['e3', 'e2']);
      expect((await store.listAuditEvents(10, 'agent-a')).map((event) => event.id)).toEqual([
        'e3',
        'e1',
      ]);
    });

    it('orders same-millisecond audit events by insertion, not arbitrarily', async () => {
      const store = getStore();
      // The exact condition a fast test creates and a naive `ORDER BY at`
      // resolves nondeterministically.
      for (const id of ['a', 'b', 'c', 'd']) {
        await store.recordAuditEvent(anAuditEvent({ id, at: 7_000 }));
      }
      expect((await store.listAuditEvents(10)).map((event) => event.id)).toEqual([
        'd',
        'c',
        'b',
        'a',
      ]);
    });

    // --- agent registry -----------------------------------------------------

    it('upserts an agent idempotently without resetting createdAt', async () => {
      const store = getStore();
      await store.upsertAgent(anAgent({ createdAt: 1_000 }));
      await store.upsertAgent(anAgent({ name: 'Renamed', createdAt: 5_000 }));

      const definition = await store.getAgentDefinition('agent-a');
      expect(definition?.name).toBe('Renamed');
      expect(definition?.createdAt).toBe(1_000);
      expect(await store.listAgents()).toHaveLength(1);
    });

    it('round-trips guardrails and tool policies', async () => {
      const store = getStore();
      await store.upsertAgent(
        anAgent({
          guardrails: { maxSteps: 8 },
          toolNames: ['issue_refund'],
          toolPolicies: [{ tool: 'issue_refund', action: 'require_approval' }],
          driftDetectionEnabled: false,
        }),
      );
      const definition = await store.getAgentDefinition('agent-a');
      expect(definition?.guardrails).toEqual({ maxSteps: 8 });
      expect(definition?.toolNames).toEqual(['issue_refund']);
      expect(definition?.toolPolicies).toEqual([
        { tool: 'issue_refund', action: 'require_approval' },
      ]);
      expect(definition?.driftDetectionEnabled).toBe(false);
    });

    it('clears a field that a re-registration no longer declares', async () => {
      const store = getStore();
      await store.upsertAgent(anAgent({ toolPolicies: [{ tool: 'x', action: 'deny' }] }));
      await store.upsertAgent(anAgent());
      // A partial upsert would leave the rule in place and the agent would keep
      // enforcing a policy its own definition no longer contains.
      expect((await store.getAgentDefinition('agent-a'))?.toolPolicies).toBeUndefined();
    });

    it('lists agents oldest first', async () => {
      const store = getStore();
      await store.upsertAgent(anAgent({ id: 'second', createdAt: 2_000 }));
      await store.upsertAgent(anAgent({ id: 'first', createdAt: 1_000 }));
      expect((await store.listAgents()).map((agent) => agent.id)).toEqual(['first', 'second']);
    });

    // --- console overrides --------------------------------------------------

    it('stores, reads back and clears an override', async () => {
      const store = getStore();
      await store.upsertAgent(anAgent());
      expect(await store.getAgentOverride('agent-a')).toBeUndefined();

      await store.setAgentOverride({
        agentId: 'agent-a',
        guardrails: { maxSteps: 3 },
        updatedAt: 5_000,
        updatedBy: 'user-1',
      });
      expect(await store.getAgentOverride('agent-a')).toMatchObject({
        guardrails: { maxSteps: 3 },
        updatedBy: 'user-1',
      });

      expect(await store.clearAgentOverride('agent-a')).toBe(true);
      expect(await store.getAgentOverride('agent-a')).toBeUndefined();
      // "Revert to code" twice is not an error, it is a no-op.
      expect(await store.clearAgentOverride('agent-a')).toBe(false);
    });

    it('replaces the override wholesale rather than merging into it', async () => {
      const store = getStore();
      await store.upsertAgent(anAgent());
      await store.setAgentOverride({
        agentId: 'agent-a',
        guardrails: { maxSteps: 3 },
        toolPolicies: [{ tool: 'x', action: 'deny', severity: 'high' }],
        updatedAt: 1,
        updatedBy: 'user-1',
      });
      // Dropping toolPolicies must actually stop overriding it — otherwise
      // "stop overriding just this field" would be inexpressible and a stale
      // rule would keep gating calls the operator thought they had released.
      await store.setAgentOverride({
        agentId: 'agent-a',
        guardrails: { maxSteps: 3 },
        updatedAt: 2,
        updatedBy: 'user-1',
      });

      const override = await store.getAgentOverride('agent-a');
      expect(override?.toolPolicies).toBeUndefined();
      expect(override?.guardrails).toEqual({ maxSteps: 3 });
    });

    it('keeps the baseline untouched when an override is written', async () => {
      const store = getStore();
      await store.upsertAgent(anAgent({ guardrails: { maxSteps: 10 } }));
      await store.setAgentOverride({
        agentId: 'agent-a',
        guardrails: { maxSteps: 2 },
        updatedAt: 1,
        updatedBy: 'user-1',
      });
      // The whole point of layering: a redeploy re-pushes the baseline and the
      // operator's override still wins, because they live in different records.
      expect((await store.getAgentDefinition('agent-a'))?.guardrails).toEqual({ maxSteps: 10 });
    });

    it('survives a re-registration of the baseline', async () => {
      const store = getStore();
      await store.upsertAgent(anAgent({ guardrails: { maxSteps: 10 } }));
      await store.setAgentOverride({
        agentId: 'agent-a',
        guardrails: { maxSteps: 2 },
        updatedAt: 1,
        updatedBy: 'user-1',
      });
      // Simulates a redeploy.
      await store.upsertAgent(anAgent({ guardrails: { maxSteps: 12 } }));
      expect((await store.getAgentOverride('agent-a'))?.guardrails).toEqual({ maxSteps: 2 });
    });

    // --- runtime state ------------------------------------------------------

    it('synthesises a default state for an unregistered agent', async () => {
      const store = getStore();
      const state = await store.getAgentState('never-seen');
      expect(state.status).toBe('running');
      expect(state.activeVersion).toBe(1);
    });

    it('persists agent state', async () => {
      const store = getStore();
      await store.setAgentState('agent-a', {
        status: 'paused',
        activeVersion: 3,
        updatedAt: 4_000,
        reason: 'drift',
        activeModel: 'qwen3.6-plus',
      });
      expect(await store.getAgentState('agent-a')).toMatchObject({
        status: 'paused',
        activeVersion: 3,
        reason: 'drift',
        activeModel: 'qwen3.6-plus',
      });
    });

    // --- approvals ----------------------------------------------------------

    it('lists only pending approvals, oldest first', async () => {
      const store = getStore();
      await store.createApproval(anApproval({ id: 'a1', createdAt: 1_000 }));
      await store.createApproval(anApproval({ id: 'a2', createdAt: 2_000 }));
      await store.createApproval(anApproval({ id: 'other', agentId: 'agent-b' }));
      await store.resolveApproval('a1', 'approved', 'me', 'console');

      const pending = await store.listPendingApprovals('agent-a');
      expect(pending.map((approval) => approval.id)).toEqual(['a2']);
    });

    it('resolves an approval exactly once', async () => {
      const store = getStore();
      await store.createApproval(anApproval());

      const first = await store.resolveApproval('ap-1', 'approved', 'alice', 'console');
      expect(first).toMatchObject({ status: 'approved', resolvedBy: 'alice', channel: 'console' });
      expect(first?.resolvedAt).toBeTypeOf('number');

      // The CAS: a second resolver (Slack racing the console) gets undefined.
      expect(await store.resolveApproval('ap-1', 'rejected', 'bob', 'slack')).toBeUndefined();
      expect((await store.getApproval('ap-1'))?.resolvedBy).toBe('alice');
    });

    it('does not resolve an unknown approval', async () => {
      const store = getStore();
      expect(await store.resolveApproval('ghost', 'approved', 'a', 'console')).toBeUndefined();
    });

    it('survives concurrent resolution with exactly one winner', async () => {
      const store = getStore();
      await store.createApproval(anApproval());
      const results = await Promise.all([
        store.resolveApproval('ap-1', 'approved', 'a', 'console'),
        store.resolveApproval('ap-1', 'rejected', 'b', 'slack'),
        store.resolveApproval('ap-1', 'approved', 'c', 'telegram'),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    // --- tool-call approvals ------------------------------------------------

    it('resolves a tool call exactly once and keeps its captured input', async () => {
      const store = getStore();
      await store.createToolCallApproval(
        aToolCall({ inputSummary: { amountUsd: 500 }, fieldPath: 'amountUsd', matchedReason: 'big refund' }),
      );

      expect(await store.getToolCallApproval('tc-1')).toMatchObject({
        inputSummary: { amountUsd: 500 },
        fieldPath: 'amountUsd',
        matchedReason: 'big refund',
      });

      expect(await store.resolveToolCallApproval('tc-1', 'approved', 'alice', 'console')).toMatchObject(
        { status: 'approved' },
      );
      expect(await store.resolveToolCallApproval('tc-1', 'rejected', 'bob', 'slack')).toBeUndefined();
      expect(await store.listPendingToolCallApprovals('agent-a')).toHaveLength(0);
    });

    // --- history ------------------------------------------------------------

    it('lists drift history newest first, honouring limit', async () => {
      const store = getStore();
      await store.recordDriftVerdict('agent-a', aDriftEntry({ id: 'd1', at: 1_000 }));
      await store.recordDriftVerdict('agent-a', aDriftEntry({ id: 'd2', at: 2_000 }));
      await store.recordDriftVerdict('agent-b', aDriftEntry({ id: 'other' }));

      expect((await store.listDriftHistory('agent-a', 10)).map((entry) => entry.id)).toEqual([
        'd2',
        'd1',
      ]);
      expect((await store.listDriftHistory('agent-a', 1)).map((entry) => entry.id)).toEqual(['d2']);
      expect(await store.listDriftHistory('never-seen', 10)).toEqual([]);
    });

    it('lists the action log newest first and preserves optional actor/channel', async () => {
      const store = getStore();
      await store.recordAction('agent-a', anAction({ id: 'l1' }));
      await store.recordAction('agent-a', anAction({ id: 'l2', actor: 'alice', channel: 'console' }));

      const log = await store.listActionLog('agent-a', 10);
      expect(log.map((entry) => entry.id)).toEqual(['l2', 'l1']);
      expect(log[0]).toMatchObject({ actor: 'alice', channel: 'console' });
      expect(log[1]?.actor).toBeUndefined();
    });

    // --- coordination -------------------------------------------------------

    it('admits one caller per cooldown window, then admits again after expiry', async () => {
      const store = getStore();
      expect(await store.checkAndSetCooldown('agent-a', 'pause', 60)).toBe(true);
      expect(await store.checkAndSetCooldown('agent-a', 'pause', 60)).toBe(false);
      // Different agent, same key — cooldowns must not be shared across the fleet.
      expect(await store.checkAndSetCooldown('agent-b', 'pause', 60)).toBe(true);

      await sleep(90);
      expect(await store.checkAndSetCooldown('agent-a', 'pause', 60)).toBe(true);
    });

    it('grants the leader lock to exactly one caller', async () => {
      const store = getStore();
      const results = await Promise.all([
        store.acquireLeaderLock('drift-cycle', 5_000),
        store.acquireLeaderLock('drift-cycle', 5_000),
        store.acquireLeaderLock('drift-cycle', 5_000),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('releases the leader lock after its ttl', async () => {
      const store = getStore();
      expect(await store.acquireLeaderLock('cycle', 60)).toBe(true);
      expect(await store.acquireLeaderLock('cycle', 60)).toBe(false);
      await sleep(90);
      expect(await store.acquireLeaderLock('cycle', 60)).toBe(true);
    });
  });
}

// --- memory backend ---------------------------------------------------------

describe('memory', () => {
  let store: MemoryStateStore;
  beforeEach(() => {
    store = new MemoryStateStore();
  });
  describeStateStore('MemoryStateStore', () => store);
});

// --- postgres backend -------------------------------------------------------

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)('postgres', () => {
  let handle: DatabaseHandle;
  let store: PostgresStateStore;

  beforeEach(async () => {
    handle ??= createDatabase({ connectionString: testDatabaseUrl!, maxConnections: 4 });
    await runMigrations({ db: handle.db });
    await seedOrganization(handle.db);
    // Truncate rather than recreate: migrating per test would dominate runtime,
    // and RESTART IDENTITY matters because the ordering assertions depend on
    // `seq` starting fresh for each test.
    await handle.db.execute(
      sql`truncate table
        api_keys, audit_events, agents, agent_state, approvals, tool_call_approvals,
        drift_history, action_log, cooldowns, leader_locks, agent_overrides, agent_tools,
        agent_runs, tool_call_events, model_switches
      restart identity cascade`,
    );
    store = new PostgresStateStore({ db: handle.db });
  });

  afterAll(async () => {
    await handle?.close();
  });

  describeStateStore('PostgresStateStore', () => store);
});
