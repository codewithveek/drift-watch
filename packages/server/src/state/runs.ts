/**
 * Durable run and tool-call records — the telemetry the console reads without
 * Grafana, and the data `SqlMetricsSource` aggregates so a deployment needs no
 * Prometheus.
 *
 * ## Summaries, not spans
 *
 * One row per RUN and one per TOOL CALL, rather than a row per OTel span. A span
 * table would need partitioning and a retention policy to survive real
 * throughput, and would push the deployment back toward ClickHouse or Tempo —
 * exactly the multi-container complexity this architecture removes. One run row
 * instead of ~50 spans answers the questions operators actually ask (what did
 * this cost, what did it call, did it fail) at a fraction of the write volume.
 *
 * Full distributed tracing stays available to anyone exporting OTLP to a real
 * trace backend, and `traceId` is stored here so a run links straight to it.
 * DriftWatch does not try to replace Tempo; it tries to make Tempo optional.
 *
 * Postgres-only, for the same reason as agent-tools.ts: this is reporting data,
 * no enforcement path reads it, and it does not belong on the `StateStore`
 * interface that custom backends must implement. Deployments on Redis or memory
 * simply have no stored history and fall back to Prometheus for drift metrics.
 */
import { and, count, eq, gte, lt, sql, sum } from 'drizzle-orm';
import type { StateStore, WindowStats } from '@driftwatch/sdk';
import { PostgresStateStore } from '../db/postgres-store.js';
import { agentRuns, modelSwitches, toolCallEvents, DEFAULT_ORGANIZATION_ID } from '../db/schema.js';

/** One completed agent task, as reported by the SDK. */
export interface RunReport {
  id: string;
  agentId: string;
  startedAt: number;
  endedAt: number;
  status: 'completed' | 'failed' | 'stopped';
  stopReason?: string;
  errorMessage?: string;
  model?: string;
  steps?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  traceId?: string;
  toolCalls?: ToolCallReport[];
}

export interface ToolCallReport {
  tool: string;
  at: number;
  durationMs: number;
  ok: boolean;
  /** True when a Loop 3 policy denied or held this call. */
  gated?: boolean;
}

function databaseOf(store: StateStore) {
  return store instanceof PostgresStateStore ? store.database : undefined;
}

/** True when this deployment can store and query run history. */
export function supportsRunHistory(store: StateStore): boolean {
  return databaseOf(store) !== undefined;
}

/**
 * Records a finished run and its tool calls.
 *
 * The two tables are written in one transaction so a run can never appear
 * without the calls it made — a partial write would show as an agent that ran
 * and did nothing, which is indistinguishable from a real and alarming
 * condition.
 *
 * Tool calls are ALSO denormalised into their own table rather than living only
 * in the run's JSON: window aggregation needs to filter and average across them
 * without unpacking every run's blob, and that is the query
 * `SqlMetricsSource` runs on every drift cycle.
 */
export async function recordRun(store: StateStore, report: RunReport): Promise<void> {
  const db = databaseOf(store);
  if (!db) return;

  await db.transaction(async (tx) => {
    await tx.insert(agentRuns).values({
      id: report.id,
      organizationId: DEFAULT_ORGANIZATION_ID,
      agentId: report.agentId,
      startedAt: report.startedAt,
      endedAt: report.endedAt,
      durationMs: Math.max(0, report.endedAt - report.startedAt),
      status: report.status,
      stopReason: report.stopReason ?? null,
      errorMessage: report.errorMessage ?? null,
      model: report.model ?? null,
      steps: report.steps ?? null,
      promptTokens: report.promptTokens ?? null,
      completionTokens: report.completionTokens ?? null,
      totalTokens: report.totalTokens ?? null,
      costUsd: report.costUsd ?? null,
      toolCalls: (report.toolCalls ?? []).map((call) => ({
        tool: call.tool,
        durationMs: call.durationMs,
        ok: call.ok,
        ...(call.gated !== undefined ? { gated: call.gated } : {}),
      })),
      traceId: report.traceId ?? null,
    });

    if (report.toolCalls?.length) {
      await tx.insert(toolCallEvents).values(
        report.toolCalls.map((call, index) => ({
          // Deterministic per (run, position) so a retried report is an upsert
          // conflict rather than silent duplication of the same calls.
          id: `${report.id}:${index}`,
          organizationId: DEFAULT_ORGANIZATION_ID,
          agentId: report.agentId,
          runId: report.id,
          tool: call.tool,
          at: call.at,
          durationMs: call.durationMs,
          ok: call.ok,
          gated: call.gated ?? false,
        })),
      );
    }
  });
}

/**
 * Aggregates one time window into the shape the drift detector consumes.
 *
 * This is the SQL equivalent of the PromQL in `PrometheusMetricsSource`, and
 * producing the identical `WindowStats` is what lets the two be swapped with no
 * change to `detectBehavioralDrift`.
 *
 * p95 uses Postgres's `percentile_cont`, which interpolates — the same
 * definition Prometheus's `histogram_quantile` approximates from buckets. The
 * SQL version is in fact MORE accurate, since it reads actual observations
 * rather than bucket boundaries.
 */
export async function queryWindow(
  store: StateStore,
  agentId: string,
  windowLabel: string,
  startTimeMs: number,
  endTimeMs: number,
): Promise<WindowStats> {
  const db = databaseOf(store);
  const empty: WindowStats = {
    windowLabel,
    totalCalls: 0,
    errorRate: 0,
    p95LatencyMs: 0,
    tokenSpend: 0,
    toolMix: {},
  };
  if (!db) return empty;

  const inWindow = and(
    eq(toolCallEvents.agentId, agentId),
    eq(toolCallEvents.organizationId, DEFAULT_ORGANIZATION_ID),
    gte(toolCallEvents.at, startTimeMs),
    lt(toolCallEvents.at, endTimeMs),
  );

  const [byTool, [latency], [tokens]] = await Promise.all([
    // Tool mix and error rate in one pass: grouping by tool gives both the
    // per-tool counts the drift judge compares AND the totals, so there is no
    // second scan of the same rows.
    db
      .select({
        tool: toolCallEvents.tool,
        calls: count(),
        failures: sql<number>`count(*) filter (where not ${toolCallEvents.ok})`.mapWith(Number),
      })
      .from(toolCallEvents)
      .where(inWindow)
      .groupBy(toolCallEvents.tool),
    db
      .select({
        p95: sql<number>`coalesce(percentile_cont(0.95) within group (order by ${toolCallEvents.durationMs}), 0)`.mapWith(
          Number,
        ),
      })
      .from(toolCallEvents)
      .where(inWindow),
    db
      .select({ total: sum(agentRuns.totalTokens).mapWith(Number) })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.agentId, agentId),
          eq(agentRuns.organizationId, DEFAULT_ORGANIZATION_ID),
          gte(agentRuns.startedAt, startTimeMs),
          lt(agentRuns.startedAt, endTimeMs),
        ),
      ),
  ]);

  const totalCalls = byTool.reduce((sumCalls, row) => sumCalls + row.calls, 0);
  const failures = byTool.reduce((sumFailures, row) => sumFailures + row.failures, 0);

  return {
    windowLabel,
    totalCalls,
    errorRate: totalCalls === 0 ? 0 : failures / totalCalls,
    p95LatencyMs: latency?.p95 ?? 0,
    tokenSpend: tokens?.total ?? 0,
    toolMix: Object.fromEntries(byTool.map((row) => [row.tool, row.calls])),
  };
}

/** Autopilot-initiated model switches in a window, so drift can be attributed. */
export async function queryModelSwitches(
  store: StateStore,
  agentId: string,
  startTimeMs: number,
  endTimeMs: number,
): Promise<number> {
  const db = databaseOf(store);
  if (!db) return 0;
  const [row] = await db
    .select({ switches: count() })
    .from(modelSwitches)
    .where(
      and(
        eq(modelSwitches.agentId, agentId),
        eq(modelSwitches.organizationId, DEFAULT_ORGANIZATION_ID),
        gte(modelSwitches.at, startTimeMs),
        lt(modelSwitches.at, endTimeMs),
      ),
    );
  return row?.switches ?? 0;
}

/** One time bucket of run activity, for the console's charts. */
export interface RunBucket {
  /** Bucket start, epoch ms. */
  at: number;
  runs: number;
  failed: number;
  totalTokens: number;
  costUsd: number;
  /** Median run duration. Median, not mean: one 90-second outlier should not
   *  redraw the whole series and hide what typical looks like. */
  medianDurationMs: number;
}

/**
 * Buckets run activity over a window.
 *
 * Bucketing happens in SQL rather than by fetching rows and grouping in JS: a
 * busy agent over 7 days is tens of thousands of rows, and shipping them to
 * Node to produce 24 numbers is the kind of thing that works in development and
 * falls over in production.
 */
export async function queryRunBuckets(
  store: StateStore,
  agentId: string,
  startTimeMs: number,
  endTimeMs: number,
  bucketMs: number,
): Promise<RunBucket[]> {
  const db = databaseOf(store);
  if (!db) return [];

  /*
   * The bucket width is inlined as a literal rather than bound as a parameter.
   *
   * Drizzle binds each `sql` fragment's values independently, so the expression
   * in SELECT and the one in GROUP BY arrive as different placeholders ($1/$2
   * vs $7/$8) and Postgres refuses to recognise them as the same expression —
   * "column must appear in the GROUP BY clause". Grouping by ordinal position
   * sidesteps that entirely and is unambiguous here: the bucket is always the
   * first selected column.
   *
   * `bucketMs` is a server-computed clamped integer (see the route), never
   * caller-supplied text, so there is nothing to inject.
   */
  const bucketExpression = sql.raw(
    `(agent_runs.started_at / ${bucketMs}) * ${bucketMs}`,
  );
  return db
    .select({
      at: sql<number>`${bucketExpression}`.mapWith(Number),
      runs: count(),
      failed: sql<number>`count(*) filter (where ${agentRuns.status} <> 'completed')`.mapWith(Number),
      totalTokens: sql<number>`coalesce(sum(${agentRuns.totalTokens}), 0)`.mapWith(Number),
      costUsd: sql<number>`coalesce(sum(${agentRuns.costUsd}), 0)`.mapWith(Number),
      medianDurationMs: sql<number>`coalesce(percentile_cont(0.5) within group (order by ${agentRuns.durationMs}), 0)`.mapWith(
        Number,
      ),
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.agentId, agentId),
        eq(agentRuns.organizationId, DEFAULT_ORGANIZATION_ID),
        gte(agentRuns.startedAt, startTimeMs),
        lt(agentRuns.startedAt, endTimeMs),
      ),
    )
    .groupBy(sql`1`)
    .orderBy(sql`1`);
}

export type { WindowStats };
