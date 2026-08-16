/**
 * The SQL metrics backend, which is what makes Prometheus optional.
 *
 * These assertions are about producing the SAME `WindowStats` contract the
 * drift detector already consumes — if the numbers are wrong or the empty case
 * lies, the autonomous loop acts on fiction, which is worse than having no
 * metrics at all.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { MemoryStateStore } from '@driftwatch/sdk';
import { createDatabase, type DatabaseHandle } from '../db/client.js';
import { createTestDatabase } from '../test-support.js';
import { runMigrations } from '../db/migrate.js';
import { seedOrganization } from '../db/seed.js';
import { PostgresStateStore } from '../db/postgres-store.js';
import { SqlMetricsSource } from './sql-metrics-source.js';
import { recordRun, supportsRunHistory } from './runs.js';
import { createMetricsQuerySourceFor } from '../config/metrics-source.js';
import { DriftWatchConfigSchema, type AgentDefinition } from '@driftwatch/sdk';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

const AGENT: AgentDefinition = { id: 'agent-a', name: 'Agent A', createdAt: 0 };
const T0 = 1_000_000;

describe('backend selection', () => {
  const driftConfig = (prometheusBaseUrl: string) =>
    DriftWatchConfigSchema.parse({ driftDetection: { prometheusBaseUrl } }).driftDetection;

  it('has no source at all without Prometheus or a database', () => {
    // Deliberately undefined rather than an empty source: a window of zeroes is
    // indistinguishable from an idle agent, and feeding one to the judge would
    // invent drift out of missing data.
    expect(
      createMetricsQuerySourceFor(driftConfig('http://localhost:9090'), AGENT, {
        store: new MemoryStateStore(),
      }),
    ).toBeUndefined();
  });

  it('respects driftDetectionEnabled: false regardless of backend', () => {
    expect(
      createMetricsQuerySourceFor(driftConfig('https://prom.internal'), {
        ...AGENT,
        driftDetectionEnabled: false,
      }),
    ).toBeUndefined();
  });

  it('prefers a configured Prometheus over the local database', () => {
    // A deployment running Prometheus has strictly richer data — including from
    // processes that never report runs here — so falling back would downgrade it.
    const source = createMetricsQuerySourceFor(driftConfig('https://prom.internal'), AGENT, {
      store: new MemoryStateStore(),
    });
    expect(source).toBeDefined();
    expect(source).not.toBeInstanceOf(SqlMetricsSource);
  });
});

describe.skipIf(!testDatabaseUrl)('SqlMetricsSource', () => {
  let handle: DatabaseHandle;
  let store: PostgresStateStore;
  let source: SqlMetricsSource;

  beforeEach(async () => {
    handle ??= createDatabase({
      // Its own database: parallel test FILES truncating shared tables would
      // otherwise delete rows another file just wrote. See test-support.ts.
      connectionString: await createTestDatabase(testDatabaseUrl!, 'metrics'),
      maxConnections: 4,
    });
    await runMigrations({ db: handle.db });
    await seedOrganization(handle.db);
    await handle.db.execute(
      sql`truncate table agent_runs, tool_call_events, model_switches, agents restart identity cascade`,
    );
    store = new PostgresStateStore({ db: handle.db });
    await store.upsertAgent(AGENT);
    source = new SqlMetricsSource({ store, agentId: AGENT.id });
  });

  afterAll(async () => {
    await handle?.close();
  });

  it('is selected when there is a database and no Prometheus', () => {
    expect(supportsRunHistory(store)).toBe(true);
    const selected = createMetricsQuerySourceFor(
      DriftWatchConfigSchema.parse({}).driftDetection,
      AGENT,
      { store },
    );
    expect(selected).toBeInstanceOf(SqlMetricsSource);
  });

  it('reports an honest empty window rather than throwing', async () => {
    const stats = await source.queryWindowStats({
      windowLabel: 'baseline',
      startTimeMs: T0,
      endTimeMs: T0 + 60_000,
    });
    expect(stats).toEqual({
      windowLabel: 'baseline',
      totalCalls: 0,
      // Not NaN: 0/0 would poison every downstream comparison.
      errorRate: 0,
      p95LatencyMs: 0,
      tokenSpend: 0,
      toolMix: {},
    });
  });

  it('aggregates tool mix, error rate, p95 latency and token spend', async () => {
    await recordRun(store, {
      id: 'run-1',
      agentId: AGENT.id,
      startedAt: T0,
      endedAt: T0 + 5_000,
      status: 'completed',
      totalTokens: 1_200,
      toolCalls: [
        { tool: 'issue_refund', at: T0 + 10, durationMs: 100, ok: true },
        { tool: 'issue_refund', at: T0 + 20, durationMs: 200, ok: true },
        { tool: 'lookup_order', at: T0 + 30, durationMs: 300, ok: false },
        { tool: 'lookup_order', at: T0 + 40, durationMs: 1_000, ok: true },
      ],
    });

    const stats = await source.queryWindowStats({
      windowLabel: 'current',
      startTimeMs: T0,
      endTimeMs: T0 + 60_000,
    });
    expect(stats.totalCalls).toBe(4);
    expect(stats.toolMix).toEqual({ issue_refund: 2, lookup_order: 2 });
    expect(stats.errorRate).toBeCloseTo(0.25);
    expect(stats.tokenSpend).toBe(1_200);
    // percentile_cont interpolates over the actual observations rather than
    // approximating from histogram buckets the way PromQL must.
    expect(stats.p95LatencyMs).toBeGreaterThan(300);
    expect(stats.p95LatencyMs).toBeLessThanOrEqual(1_000);
  });

  it('excludes calls outside the window', async () => {
    await recordRun(store, {
      id: 'old',
      agentId: AGENT.id,
      startedAt: T0 - 100_000,
      endedAt: T0 - 99_000,
      status: 'completed',
      totalTokens: 999,
      toolCalls: [{ tool: 'issue_refund', at: T0 - 100_000, durationMs: 10, ok: true }],
    });
    await recordRun(store, {
      id: 'new',
      agentId: AGENT.id,
      startedAt: T0,
      endedAt: T0 + 1_000,
      status: 'completed',
      totalTokens: 10,
      toolCalls: [{ tool: 'issue_refund', at: T0 + 5, durationMs: 10, ok: true }],
    });

    const stats = await source.queryWindowStats({
      windowLabel: 'current',
      startTimeMs: T0,
      endTimeMs: T0 + 60_000,
    });
    // Baseline-vs-current comparison is the whole mechanism; a window that
    // leaked older data would flatten every delta the judge looks for.
    expect(stats.totalCalls).toBe(1);
    expect(stats.tokenSpend).toBe(10);
  });

  it("excludes another agent's calls", async () => {
    await store.upsertAgent({ id: 'agent-b', name: 'B', createdAt: 0 });
    await recordRun(store, {
      id: 'other',
      agentId: 'agent-b',
      startedAt: T0,
      endedAt: T0 + 10,
      status: 'completed',
      totalTokens: 500,
      toolCalls: [{ tool: 'issue_refund', at: T0, durationMs: 10, ok: true }],
    });

    const stats = await source.queryWindowStats({
      windowLabel: 'current',
      startTimeMs: T0,
      endTimeMs: T0 + 60_000,
    });
    // Per-agent isolation is the point of the fleet model; leaking here would
    // make one noisy agent look like drift in a quiet one.
    expect(stats.totalCalls).toBe(0);
    expect(stats.tokenSpend).toBe(0);
  });

  it('counts a gated call as gated, not as a tool failure', async () => {
    await recordRun(store, {
      id: 'gated',
      agentId: AGENT.id,
      startedAt: T0,
      endedAt: T0 + 10,
      status: 'completed',
      toolCalls: [
        { tool: 'issue_refund', at: T0, durationMs: 5, ok: false, gated: true },
        { tool: 'issue_refund', at: T0 + 1, durationMs: 5, ok: true },
      ],
    });

    const stats = await source.queryWindowStats({
      windowLabel: 'current',
      startTimeMs: T0,
      endTimeMs: T0 + 60_000,
    });
    // A policy denial is recorded (the call was attempted) but it is a governance
    // outcome, not a malfunction. It still counts toward errorRate today —
    // pinning that here so the choice is explicit rather than accidental.
    expect(stats.totalCalls).toBe(2);
    expect(stats.errorRate).toBeCloseTo(0.5);
  });

  it('reports zero model switches rather than failing when none exist', async () => {
    await expect(
      source.queryModelSwitchCount({ startTimeMs: T0, endTimeMs: T0 + 60_000 }),
    ).resolves.toBe(0);
  });
});
