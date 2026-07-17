/**
 * Behavioral drift detection — the "AI analysis over traces" layer.
 *
 * 1. Query SigNoz for aggregate agent behavior over two windows.
 * 2. Compute deltas (tool mix, error rate, p95 latency, token spend).
 * 3. Ask the LLM (whatever ModelClient the caller injected) to classify
 *    drift with generateObject so the verdict is schema-typed — no fragile
 *    JSON parsing.
 *
 * SigNoz query API: v4 query_range accepts a builder payload. Auth via a
 * SIGNOZ-API-KEY header (SigNoz UI -> Settings -> API Keys).
 *
 * Dry-run mode: pass isDryRun: true to use built-in fixtures instead of
 * hitting SigNoz. Useful for demos, CI, or first-run before you've generated
 * traffic.
 */
import { generateObject } from 'ai';
import { z } from 'zod';
import type { ModelClient } from '../agent/model-client.js';
import { describeModelClient } from '../agent/model-client.js';
import {
  summarizeTokenUsage,
  type TokenUsageSummary,
} from '../telemetry/usage-tracking.js';

const DEFAULT_SIGNOZ_BASE_URL = 'http://localhost:8080';
const DRIFT_JUDGE_FUNCTION_ID = 'drift-judge';
const ONE_HOUR_MS = 60 * 60 * 1000;

export interface WindowStats {
  windowLabel: string;
  totalCalls: number;
  errorRate: number;
  p95LatencyMs: number;
  tokenSpend: number;
  toolMix: Record<string, number>;
}

const DriftVerdictSchema = z.object({
  drift: z.boolean(),
  severity: z.enum(['none', 'low', 'medium', 'high']),
  reasons: z.array(z.string()),
  recommended_action: z.string(),
});
export type DriftVerdict = z.infer<typeof DriftVerdictSchema>;

export interface DriftReport {
  baselineWindowStats: WindowStats;
  currentWindowStats: WindowStats;
  verdict: DriftVerdict;
  judgeTokenUsage: TokenUsageSummary;
  providerName: string;
  modelIdentifier: string;
}

interface SigNozSeriesPoint {
  timestamp?: number;
  value?: number | string;
}
interface SigNozSeries {
  labels?: Record<string, string>;
  values?: SigNozSeriesPoint[];
}
interface SigNozBuilderResult {
  queryName?: string;
  series?: SigNozSeries[];
}
export interface SigNozResponse {
  status?: string;
  data?: {
    resultType?: string;
    result?: SigNozBuilderResult[];
  };
}

export interface DetectBehavioralDriftOptions {
  modelClient: ModelClient;
  isDryRun?: boolean;
  signozBaseUrl?: string;
  signozApiKey?: string;
}

export async function detectBehavioralDrift(
  options: DetectBehavioralDriftOptions,
): Promise<DriftReport> {
  const {
    modelClient,
    isDryRun = false,
    signozBaseUrl = process.env.SIGNOZ_URL ?? DEFAULT_SIGNOZ_BASE_URL,
    signozApiKey = process.env.SIGNOZ_API_KEY ?? '',
  } = options;

  const [baselineWindowStats, currentWindowStats] = isDryRun
    ? loadFixtureWindows()
    : await queryLiveWindows({ signozBaseUrl, signozApiKey });

  const modelClientDescriptor = describeModelClient(modelClient);
  const { verdict, judgeTokenUsage } = await judgeDriftVerdict({
    baselineWindowStats,
    currentWindowStats,
    modelClient,
  });

  return {
    baselineWindowStats,
    currentWindowStats,
    verdict,
    judgeTokenUsage,
    providerName: modelClientDescriptor.providerName,
    modelIdentifier: modelClientDescriptor.modelIdentifier,
  };
}

async function queryLiveWindows(options: {
  signozBaseUrl: string;
  signozApiKey: string;
}): Promise<[WindowStats, WindowStats]> {
  const { signozBaseUrl, signozApiKey } = options;
  const windowEndTimeMs = Date.now();

  return Promise.all([
    queryWindowStats({
      windowLabel: 'baseline',
      startTimeMs: windowEndTimeMs - 2 * ONE_HOUR_MS,
      endTimeMs: windowEndTimeMs - ONE_HOUR_MS,
      signozBaseUrl,
      signozApiKey,
    }),
    queryWindowStats({
      windowLabel: 'current',
      startTimeMs: windowEndTimeMs - ONE_HOUR_MS,
      endTimeMs: windowEndTimeMs,
      signozBaseUrl,
      signozApiKey,
    }),
  ]);
}

async function queryWindowStats(options: {
  windowLabel: string;
  startTimeMs: number;
  endTimeMs: number;
  signozBaseUrl: string;
  signozApiKey: string;
}): Promise<WindowStats> {
  const { windowLabel, startTimeMs, endTimeMs, signozBaseUrl, signozApiKey } =
    options;

  // Fan out three builder queries in one request:
  //   A: tool call counts by tool + outcome (drives toolMix + errorRate)
  //   B: p95 tool latency
  //   C: total token spend (from the agent.tokens counter)
  const signozResponseBody = await querySignozRange({
    signozBaseUrl,
    signozApiKey,
    startTimeMs,
    endTimeMs,
    builderQueries: {
      A: buildToolCallCountsQuery(),
      B: buildToolLatencyQuery(),
      C: buildTokenSpendQuery(),
    },
  });

  return parseWindowStats(windowLabel, signozResponseBody);
}

function buildToolCallCountsQuery(): Record<string, unknown> {
  return {
    dataSource: 'metrics',
    aggregateAttribute: { key: 'agent.tool.calls', dataType: 'float64' },
    aggregateOperator: 'sum',
    groupBy: [{ key: 'tool' }, { key: 'outcome' }],
    expression: 'A',
  };
}

function buildToolLatencyQuery(): Record<string, unknown> {
  return {
    dataSource: 'metrics',
    aggregateAttribute: { key: 'agent.tool.duration', dataType: 'float64' },
    aggregateOperator: 'p95',
    expression: 'B',
  };
}

function buildTokenSpendQuery(): Record<string, unknown> {
  return {
    dataSource: 'metrics',
    aggregateAttribute: { key: 'agent.tokens', dataType: 'float64' },
    aggregateOperator: 'sum',
    expression: 'C',
  };
}

async function querySignozRange(options: {
  signozBaseUrl: string;
  signozApiKey: string;
  startTimeMs: number;
  endTimeMs: number;
  builderQueries: Record<string, unknown>;
}): Promise<SigNozResponse> {
  const { signozBaseUrl, signozApiKey, startTimeMs, endTimeMs, builderQueries } =
    options;

  const requestBody = {
    start: startTimeMs,
    end: endTimeMs,
    step: 60,
    compositeQuery: {
      queryType: 'builder',
      panelType: 'table',
      builderQueries,
    },
  };

  const response = await fetch(`${signozBaseUrl}/api/v4/query_range`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'SIGNOZ-API-KEY': signozApiKey,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    throw new Error(
      `SigNoz query failed: ${response.status} ${await response.text()}`,
    );
  }
  return (await response.json()) as SigNozResponse;
}

export function parseWindowStats(
  windowLabel: string,
  signozResponseBody: SigNozResponse,
): WindowStats {
  const builderResults = signozResponseBody.data?.result ?? [];

  const toolCallCountsByOutcome = extractToolCallCounts(
    findBuilderResult(builderResults, 'A'),
  );
  const p95LatencyMs = extractP95LatencyMs(findBuilderResult(builderResults, 'B'));
  const tokenSpend = extractTokenSpend(findBuilderResult(builderResults, 'C'));

  return {
    windowLabel,
    ...summarizeToolCallCounts(toolCallCountsByOutcome),
    p95LatencyMs,
    tokenSpend,
  };
}

function findBuilderResult(
  builderResults: SigNozBuilderResult[],
  queryName: string,
): SigNozBuilderResult | undefined {
  return builderResults.find((result) => result.queryName === queryName);
}

interface ToolCallCounts {
  okCallCount: number;
  errorCallCount: number;
}

function extractToolCallCounts(
  builderResult: SigNozBuilderResult | undefined,
): Record<string, ToolCallCounts> {
  const callCountsByTool: Record<string, ToolCallCounts> = {};
  for (const series of builderResult?.series ?? []) {
    const toolName = series.labels?.tool ?? 'unknown';
    const outcome = series.labels?.outcome === 'error' ? 'error' : 'ok';
    callCountsByTool[toolName] ??= { okCallCount: 0, errorCallCount: 0 };
    const callCount = sumSeriesValues(series);
    if (outcome === 'error') {
      callCountsByTool[toolName].errorCallCount += callCount;
    } else {
      callCountsByTool[toolName].okCallCount += callCount;
    }
  }
  return callCountsByTool;
}

function summarizeToolCallCounts(
  callCountsByTool: Record<string, ToolCallCounts>,
): Pick<WindowStats, 'totalCalls' | 'errorRate' | 'toolMix'> {
  const totalCallsByTool = Object.fromEntries(
    Object.entries(callCountsByTool).map(([toolName, counts]) => [
      toolName,
      counts.okCallCount + counts.errorCallCount,
    ]),
  );
  const totalCalls = Object.values(totalCallsByTool).reduce(
    (sum, count) => sum + count,
    0,
  );
  const totalErrorCalls = Object.values(callCountsByTool).reduce(
    (sum, counts) => sum + counts.errorCallCount,
    0,
  );

  const toolMix: Record<string, number> = {};
  if (totalCalls > 0) {
    for (const [toolName, callCount] of Object.entries(totalCallsByTool)) {
      toolMix[toolName] = callCount / totalCalls;
    }
  }

  return {
    totalCalls,
    errorRate: totalCalls > 0 ? totalErrorCalls / totalCalls : 0,
    toolMix,
  };
}

function extractP95LatencyMs(
  builderResult: SigNozBuilderResult | undefined,
): number {
  let p95LatencyMs = 0;
  for (const series of builderResult?.series ?? []) {
    p95LatencyMs = Math.max(p95LatencyMs, sumSeriesValues(series));
  }
  return p95LatencyMs;
}

function extractTokenSpend(
  builderResult: SigNozBuilderResult | undefined,
): number {
  return (builderResult?.series ?? []).reduce(
    (totalTokens, series) => totalTokens + sumSeriesValues(series),
    0,
  );
}

function sumSeriesValues(series: SigNozSeries): number {
  return (series.values ?? []).reduce((total, point) => {
    const numericValue =
      typeof point.value === 'string' ? Number(point.value) : point.value ?? 0;
    return Number.isFinite(numericValue) ? total + (numericValue as number) : total;
  }, 0);
}

function loadFixtureWindows(): [WindowStats, WindowStats] {
  return [
    buildFixtureWindowStats('baseline', 1),
    buildFixtureWindowStats('current', 2.5),
  ];
}

function buildFixtureWindowStats(
  windowLabel: string,
  driftMultiplier: number,
): WindowStats {
  return {
    windowLabel,
    totalCalls: Math.round(120 * driftMultiplier),
    errorRate: 0.02 * driftMultiplier,
    p95LatencyMs: 180 * driftMultiplier,
    tokenSpend: Math.round(48_000 * driftMultiplier),
    toolMix: {
      get_weather: driftMultiplier < 2 ? 0.6 : 0.25,
      search_docs: driftMultiplier < 2 ? 0.4 : 0.75,
    },
  };
}

async function judgeDriftVerdict(options: {
  baselineWindowStats: WindowStats;
  currentWindowStats: WindowStats;
  modelClient: ModelClient;
}): Promise<{ verdict: DriftVerdict; judgeTokenUsage: TokenUsageSummary }> {
  const { baselineWindowStats, currentWindowStats, modelClient } = options;

  const { object: verdict, usage } = await generateObject({
    model: modelClient,
    schema: DriftVerdictSchema,
    experimental_telemetry: {
      isEnabled: true,
      functionId: DRIFT_JUDGE_FUNCTION_ID,
    },
    prompt: buildDriftJudgePrompt({ baselineWindowStats, currentWindowStats }),
  });

  return { verdict, judgeTokenUsage: summarizeTokenUsage(usage) };
}

function buildDriftJudgePrompt(options: {
  baselineWindowStats: WindowStats;
  currentWindowStats: WindowStats;
}): string {
  const { baselineWindowStats, currentWindowStats } = options;
  return `You are an SRE copilot monitoring an AI agent for behavioral drift.
Compare the CURRENT window against the BASELINE and decide whether the agent's
behavior has drifted enough to warrant a human alert. Consider shifts in
tool-call mix, rising error rate, latency regressions, and token-spend spikes.

BASELINE: ${JSON.stringify(baselineWindowStats)}
CURRENT:  ${JSON.stringify(currentWindowStats)}`;
}

// CLI entry point: `npm run drift` (or `npm run drift:dry-run`).
if (import.meta.url === `file://${process.argv[1]}`) {
  const { modelClient } = await import('../config/model-client.js');
  detectBehavioralDrift({
    modelClient,
    isDryRun: process.env.DRIFT_DRY_RUN === '1',
  })
    .then((driftReport) => {
      console.log(JSON.stringify(driftReport, null, 2));
      process.exit(0);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
