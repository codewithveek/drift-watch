/**
 * Behavioral drift detection — the "AI analysis over traces" layer.
 *
 * 1. Query a SigNoz-compatible backend for aggregate agent behavior over two
 *    windows (config injected via `driftDetectionConfig`, not read from env
 *    here — see ../config/schema.ts for the typed shape and its env loader).
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
import { generateText, type LanguageModelUsage, type ModelMessage } from 'ai';
import { z } from 'zod';
import type { ModelClient } from '../model-client.js';
import { describeModelClient } from '../model-client.js';
import {
  DriftDetectionConfigSchema,
  type DriftDetectionConfig,
} from '../config/schema.js';
import type { TokenUsageSummary } from '../telemetry/usage-tracking.js';

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
  drift: z.boolean().describe('Whether the agent has behaviorally drifted enough to warrant a human alert.'),
  severity: z
    .enum(['none', 'low', 'medium', 'high'])
    .describe('Severity of the drift, or "none" if drift is false.'),
  reasons: z
    .array(z.string())
    .describe('Short bullet-point reasons citing the specific metrics that changed.'),
  recommended_action: z.string().describe('One sentence recommending what to do next.'),
});
export type DriftVerdict = z.infer<typeof DriftVerdictSchema>;

export interface DriftReport {
  baselineWindowStats: WindowStats;
  currentWindowStats: WindowStats;
  verdict: DriftVerdict;
  judgeTokenUsage: TokenUsageSummary;
  /**
   * How many model calls the judge needed to get a schema-valid verdict
   * (1 = the model returned valid JSON on the first try). Consistently >1
   * is a signal the model/provider is struggling with the output format and
   * burning extra tokens on retries.
   */
  judgeAttempts: number;
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
  /** Defaults to DriftDetectionConfigSchema's own defaults when omitted. */
  driftDetectionConfig?: DriftDetectionConfig;
}

export async function detectBehavioralDrift(
  options: DetectBehavioralDriftOptions,
): Promise<DriftReport> {
  const {
    modelClient,
    isDryRun = false,
    driftDetectionConfig = DriftDetectionConfigSchema.parse({}),
  } = options;

  const [baselineWindowStats, currentWindowStats] = isDryRun
    ? loadFixtureWindows()
    : await queryLiveWindows(driftDetectionConfig);

  const modelClientDescriptor = describeModelClient(modelClient);
  const { verdict, judgeTokenUsage, judgeAttempts } = await judgeDriftVerdict({
    baselineWindowStats,
    currentWindowStats,
    modelClient,
  });

  return {
    baselineWindowStats,
    currentWindowStats,
    verdict,
    judgeTokenUsage,
    judgeAttempts,
    providerName: modelClientDescriptor.providerName,
    modelIdentifier: modelClientDescriptor.modelIdentifier,
  };
}

async function queryLiveWindows(
  driftDetectionConfig: DriftDetectionConfig,
): Promise<[WindowStats, WindowStats]> {
  const windowEndTimeMs = Date.now();

  return Promise.all([
    queryWindowStats({
      windowLabel: 'baseline',
      startTimeMs: windowEndTimeMs - 2 * ONE_HOUR_MS,
      endTimeMs: windowEndTimeMs - ONE_HOUR_MS,
      driftDetectionConfig,
    }),
    queryWindowStats({
      windowLabel: 'current',
      startTimeMs: windowEndTimeMs - ONE_HOUR_MS,
      endTimeMs: windowEndTimeMs,
      driftDetectionConfig,
    }),
  ]);
}

async function queryWindowStats(options: {
  windowLabel: string;
  startTimeMs: number;
  endTimeMs: number;
  driftDetectionConfig: DriftDetectionConfig;
}): Promise<WindowStats> {
  const { windowLabel, startTimeMs, endTimeMs, driftDetectionConfig } = options;

  // Fan out three builder queries in one request:
  //   A: tool call counts by tool + outcome (drives toolMix + errorRate)
  //   B: p95 tool latency
  //   C: total token spend (from the agent.tokens counter)
  const signozResponseBody = await querySignozRange({
    driftDetectionConfig,
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

/**
 * SigNoz v4's metrics builder splits aggregation into two stages that the
 * older single `aggregateOperator` did not express, and sending the v3 shape
 * to /api/v4/query_range 500s with "error in builder queries":
 *   - timeAggregation:  how samples in ONE series collapse over the step
 *                       (our counters are exported DELTA, so summing deltas
 *                       within the window yields "activity during the window"
 *                       — see telemetry/otel.ts for why DELTA).
 *   - spaceAggregation: how the resulting series combine across label sets.
 * The exporter's DELTA temporality must be echoed back as `temporality:
 * 'Delta'` or the query silently matches nothing. `type` must name the
 * instrument kind (Sum for counters, Histogram for the latency metric) —
 * percentiles are only defined over Histograms, so p95 lives in
 * spaceAggregation there.
 */
function buildMetricBuilderQuery(options: {
  metricKey: string;
  instrumentType: 'Sum' | 'Histogram';
  timeAggregation: string;
  spaceAggregation: string;
  expression: string;
  groupBy?: Array<{ key: string; dataType: string; type: string }>;
}): Record<string, unknown> {
  return {
    dataSource: 'metrics',
    aggregateAttribute: {
      key: options.metricKey,
      dataType: 'float64',
      type: options.instrumentType,
      isColumn: true,
    },
    temporality: 'Delta',
    timeAggregation: options.timeAggregation,
    spaceAggregation: options.spaceAggregation,
    functions: [],
    filters: { op: 'AND', items: [] },
    groupBy: options.groupBy ?? [],
    expression: options.expression,
    disabled: false,
    stepInterval: 60,
    reduceTo: 'sum',
  };
}

function buildToolCallCountsQuery(): Record<string, unknown> {
  return buildMetricBuilderQuery({
    metricKey: 'agent.tool.calls',
    instrumentType: 'Sum',
    timeAggregation: 'sum',
    spaceAggregation: 'sum',
    expression: 'A',
    groupBy: [
      { key: 'tool', dataType: 'string', type: 'tag' },
      { key: 'outcome', dataType: 'string', type: 'tag' },
    ],
  });
}

function buildToolLatencyQuery(): Record<string, unknown> {
  return buildMetricBuilderQuery({
    // SigNoz ingests an OTLP explicit-bucket histogram as several Prometheus-
    // style series (`.bucket`, `.count`, `.sum`, `.min`, `.max`) — the base
    // name `agent.tool.duration` is NOT itself queryable. Percentiles read the
    // cumulative `.bucket` series, so that is the key we aggregate over.
    metricKey: 'agent.tool.duration.bucket',
    instrumentType: 'Histogram',
    // Percentiles are computed across the histogram buckets (spaceAggregation);
    // there is no per-series time collapse to apply first.
    timeAggregation: '',
    spaceAggregation: 'p95',
    expression: 'B',
  });
}

function buildTokenSpendQuery(): Record<string, unknown> {
  return buildMetricBuilderQuery({
    metricKey: 'agent.tokens',
    instrumentType: 'Sum',
    timeAggregation: 'sum',
    spaceAggregation: 'sum',
    expression: 'C',
  });
}

async function querySignozRange(options: {
  driftDetectionConfig: DriftDetectionConfig;
  startTimeMs: number;
  endTimeMs: number;
  builderQueries: Record<string, unknown>;
}): Promise<SigNozResponse> {
  const { driftDetectionConfig, startTimeMs, endTimeMs, builderQueries } =
    options;

  // SigNoz v4 requires every builder query to carry a `queryName` that matches
  // its key in the `builderQueries` map (omitting it 400s with "query name is
  // required"). Stamp it from the key here so the individual build* helpers
  // don't have to repeat their own letter, and so it always matches the
  // `result.queryName` the response parser keys off of.
  const namedBuilderQueries = Object.fromEntries(
    Object.entries(builderQueries).map(([queryName, query]) => [
      queryName,
      { ...(query as Record<string, unknown>), queryName },
    ]),
  );

  const requestBody = {
    start: startTimeMs,
    end: endTimeMs,
    step: 60,
    compositeQuery: {
      queryType: 'builder',
      panelType: 'table',
      builderQueries: namedBuilderQueries,
    },
  };

  const response = await fetch(
    `${driftDetectionConfig.signozBaseUrl}/api/v4/query_range`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'SIGNOZ-API-KEY': driftDetectionConfig.signozApiKey,
      },
      body: JSON.stringify(requestBody),
    },
  );

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

/**
 * Ask the model to classify drift and return a schema-valid verdict.
 *
 * Why not `generateObject`? Its structured-output guarantee is only as good as
 * the provider's `response_format` support. The AI SDK's OpenAI provider always
 * sends `response_format: { type: 'json_schema' }` when a schema is present and
 * injects NO JSON instruction into the prompt — it trusts the API to enforce
 * shape. OpenAI-compatible endpoints that don't implement `json_schema` silently ignore that field, so
 * the model, with nothing in the prompt telling it otherwise, happily returns a
 * prose/markdown report and `generateObject` throws on the first `#`.
 *
 * So we drive the format from the prompt instead and parse defensively:
 *   1. a strong system prompt + example demand a single raw JSON object,
 *   2. `extractFirstJsonObject` salvages that object even if the model wraps it
 *      in a code fence or prose,
 *   3. Zod validates it, and
 *   4. on any failure we re-prompt with the concrete error, up to
 *      MAX_JUDGE_ATTEMPTS times, before giving up.
 * This works against any provider — strict-structured-output or not.
 */
const MAX_JUDGE_ATTEMPTS = 3;

async function judgeDriftVerdict(options: {
  baselineWindowStats: WindowStats;
  currentWindowStats: WindowStats;
  modelClient: ModelClient;
}): Promise<{
  verdict: DriftVerdict;
  judgeTokenUsage: TokenUsageSummary;
  judgeAttempts: number;
}> {
  const { baselineWindowStats, currentWindowStats, modelClient } = options;

  const messages: ModelMessage[] = [
    {
      role: 'user',
      content: buildDriftJudgePrompt({ baselineWindowStats, currentWindowStats }),
    },
  ];

  const usageTotals: TokenUsageSummary = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  let lastFailure = '';

  for (let attempt = 1; attempt <= MAX_JUDGE_ATTEMPTS; attempt++) {
    const { text, usage } = await generateText({
      model: modelClient,
      // Deterministic + non-creative: we want the verdict, not an essay.
      temperature: 0,
      system: DRIFT_JUDGE_SYSTEM_PROMPT,
      messages,
      telemetry: {
        isEnabled: true,
        functionId: DRIFT_JUDGE_FUNCTION_ID,
      },
    });
    accumulateUsage(usageTotals, usage);

    const parsed = parseDriftVerdict(text);
    if (parsed.ok) {
      return {
        verdict: parsed.verdict,
        judgeTokenUsage: { ...usageTotals },
        judgeAttempts: attempt,
      };
    }

    lastFailure = parsed.error;
    // Feed the model back its own reply plus the concrete failure so it can
    // self-correct on the next turn.
    messages.push({ role: 'assistant', content: text });
    messages.push({ role: 'user', content: buildCorrectionPrompt(parsed.error) });
  }

  throw new Error(
    `drift judge did not return a schema-valid JSON verdict after ` +
      `${MAX_JUDGE_ATTEMPTS} attempts. Last failure: ${lastFailure}`,
  );
}

type DriftVerdictParseResult =
  | { ok: true; verdict: DriftVerdict }
  | { ok: false; error: string };

function parseDriftVerdict(modelText: string): DriftVerdictParseResult {
  const jsonText = extractFirstJsonObject(modelText);
  if (jsonText === null) {
    return { ok: false, error: 'reply contained no JSON object.' };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(jsonText);
  } catch (error) {
    return {
      ok: false,
      error: `extracted text was not valid JSON: ${(error as Error).message}`,
    };
  }

  const validated = DriftVerdictSchema.safeParse(parsedJson);
  if (!validated.success) {
    return {
      ok: false,
      error: `JSON did not match the required schema: ${validated.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')}`,
    };
  }

  return { ok: true, verdict: validated.data };
}

/**
 * Pull the first complete, brace-balanced JSON object out of arbitrary model
 * text. Handles the object being wrapped in a ```json fence, prefixed with a
 * markdown report, or trailed by commentary. Tracks string literals and escapes
 * so a `}` inside a string value never terminates the scan early. Returns null
 * when no balanced object is present.
 */
export function extractFirstJsonObject(text: string): string | null {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const haystack = fenceMatch ? fenceMatch[1] : text;

  const start = haystack.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let isEscaped = false;

  for (let i = start; i < haystack.length; i++) {
    const char = haystack[i];

    if (inString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (char === '\\') {
        isEscaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) return haystack.slice(start, i + 1);
    }
  }

  return null;
}

function accumulateUsage(
  totals: TokenUsageSummary,
  usage: LanguageModelUsage,
): void {
  totals.inputTokens = (totals.inputTokens ?? 0) + (usage.inputTokens ?? 0);
  totals.outputTokens = (totals.outputTokens ?? 0) + (usage.outputTokens ?? 0);
  totals.totalTokens = (totals.totalTokens ?? 0) + (usage.totalTokens ?? 0);
}

const DRIFT_JUDGE_SYSTEM_PROMPT = `You are an SRE copilot that classifies whether an AI agent's behavior has drifted enough to warrant a human alert.

You MUST reply with a SINGLE raw JSON object and NOTHING else. No markdown, no code fences, no headings, no bullet points, no prose before or after the object. Any output that is not a lone JSON object is a failure.

The JSON object must have exactly these keys:
- "drift": boolean — true if the drift warrants a human alert, otherwise false.
- "severity": one of "none", "low", "medium", or "high" (use "none" when "drift" is false).
- "reasons": array of short strings, each naming a specific metric that changed (e.g. "p95 latency 180ms -> 450ms").
- "recommended_action": a single sentence recommending what to do next.

Example of a correctly formatted reply (structure only — do not reuse these values):
{"drift":true,"severity":"high","reasons":["p95 latency 180ms -> 450ms","error rate 2% -> 9%","search_docs share 40% -> 75%"],"recommended_action":"Page the on-call engineer to investigate the search_docs regression."}`;

function buildDriftJudgePrompt(options: {
  baselineWindowStats: WindowStats;
  currentWindowStats: WindowStats;
}): string {
  const { baselineWindowStats, currentWindowStats } = options;
  return `Compare the CURRENT window against the BASELINE and decide whether the agent's behavior has drifted enough to warrant a human alert. Consider shifts in tool-call mix, rising error rate, latency regressions, and token-spend spikes.

BASELINE: ${JSON.stringify(baselineWindowStats)}
CURRENT:  ${JSON.stringify(currentWindowStats)}

Reply with ONLY the JSON object described in your instructions.`;
}

function buildCorrectionPrompt(failure: string): string {
  return `Your previous reply was rejected: ${failure}

Reply again with ONLY a single raw JSON object — no markdown, no code fences, no commentary — using exactly the keys "drift", "severity", "reasons", and "recommended_action".`;
}
