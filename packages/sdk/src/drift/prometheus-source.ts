/**
 * Default MetricsQuerySource: queries a Prometheus-compatible HTTP API
 * (Prometheus itself, Grafana Mimir/Cortex/Thanos, or any backend exposing
 * the same /api/v1/query endpoint) for the drift detector's window stats.
 *
 * Uses instant `increase()`/`rate()` queries evaluated at the window's end
 * timestamp, rather than a range query, since only a single aggregate value
 * per window is needed (not a time series) — one HTTP round trip per metric,
 * evaluated "as of" `endTimeMs`.
 *
 * Metric names assume the standard OTel-to-Prometheus naming convention
 * applied by the OTel Collector's Prometheus exporter / remote-write: dots
 * become underscores, and monotonic sums gain a `_total` suffix
 * (agent.tool.calls -> agent_tool_calls_total). Override `metricNames` if
 * your pipeline names them differently.
 */
import type { MetricsQuerySource, WindowStats } from './metrics-source.js';

export interface PrometheusMetricNames {
  toolCalls: string;
  toolDurationBucket: string;
  tokens: string;
  modelSwitches: string;
}

const DEFAULT_METRIC_NAMES: PrometheusMetricNames = {
  toolCalls: 'agent_tool_calls_total',
  toolDurationBucket: 'agent_tool_duration_bucket',
  tokens: 'agent_tokens_total',
  modelSwitches: 'agent_model_switches_total',
};

export interface PrometheusMetricsSourceOptions {
  /** Base URL of the Prometheus-compatible query API (not the OTel collector). */
  baseUrl: string;
  /** Optional bearer token, e.g. for Grafana Cloud / Mimir multi-tenant auth. */
  bearerToken?: string;
  /** Override the OTel->Prometheus metric names if your pipeline renames them. */
  metricNames?: Partial<PrometheusMetricNames>;
}

interface PrometheusVectorSample {
  metric?: Record<string, string>;
  value?: [number, string];
}
interface PrometheusQueryResponse {
  status?: string;
  data?: { resultType?: string; result?: PrometheusVectorSample[] };
  error?: string;
}

export class PrometheusMetricsSource implements MetricsQuerySource {
  private readonly options: PrometheusMetricsSourceOptions;
  private readonly metricNames: PrometheusMetricNames;

  constructor(options: PrometheusMetricsSourceOptions) {
    this.options = options;
    this.metricNames = { ...DEFAULT_METRIC_NAMES, ...options.metricNames };
  }

  async queryWindowStats(options: {
    windowLabel: string;
    startTimeMs: number;
    endTimeMs: number;
  }): Promise<WindowStats> {
    const { windowLabel, startTimeMs, endTimeMs } = options;
    const rangeSeconds = toRangeSeconds(startTimeMs, endTimeMs);
    const atSeconds = endTimeMs / 1000;
    const { toolCalls, toolDurationBucket, tokens } = this.metricNames;

    const [toolCallSamples, p95LatencyMs, tokenSpend] = await Promise.all([
      this.queryVector(
        `sum by (tool, outcome) (increase(${toolCalls}[${rangeSeconds}s]))`,
        atSeconds,
      ),
      this.queryScalar(
        `histogram_quantile(0.95, sum by (le) (rate(${toolDurationBucket}[${rangeSeconds}s])))`,
        atSeconds,
      ),
      this.queryScalar(`sum(increase(${tokens}[${rangeSeconds}s]))`, atSeconds),
    ]);

    return {
      windowLabel,
      p95LatencyMs,
      tokenSpend,
      ...summarizeToolCallSamples(toolCallSamples),
    };
  }

  async queryModelSwitchCount(options: {
    startTimeMs: number;
    endTimeMs: number;
  }): Promise<number> {
    const rangeSeconds = toRangeSeconds(options.startTimeMs, options.endTimeMs);
    const atSeconds = options.endTimeMs / 1000;
    return this.queryScalar(
      `sum(increase(${this.metricNames.modelSwitches}[${rangeSeconds}s]))`,
      atSeconds,
    );
  }

  private async queryVector(
    promql: string,
    atSeconds: number,
  ): Promise<PrometheusVectorSample[]> {
    const response = await this.query(promql, atSeconds);
    return response.data?.result ?? [];
  }

  private async queryScalar(promql: string, atSeconds: number): Promise<number> {
    const samples = await this.queryVector(promql, atSeconds);
    const raw = samples[0]?.value?.[1];
    const value = raw === undefined ? 0 : Number(raw);
    return Number.isFinite(value) ? value : 0;
  }

  private async query(promql: string, atSeconds: number): Promise<PrometheusQueryResponse> {
    const url = new URL('/api/v1/query', this.options.baseUrl);
    url.searchParams.set('query', promql);
    url.searchParams.set('time', String(atSeconds));

    const response = await fetch(url, {
      headers: this.options.bearerToken
        ? { authorization: `Bearer ${this.options.bearerToken}` }
        : {},
    });
    if (!response.ok) {
      throw new Error(`Prometheus query failed: ${response.status} ${await response.text()}`);
    }
    const body = (await response.json()) as PrometheusQueryResponse;
    if (body.status !== 'success') {
      throw new Error(`Prometheus query returned an error: ${body.error ?? 'unknown error'}`);
    }
    return body;
  }
}

function toRangeSeconds(startTimeMs: number, endTimeMs: number): number {
  return Math.max(1, Math.round((endTimeMs - startTimeMs) / 1000));
}

function summarizeToolCallSamples(
  samples: PrometheusVectorSample[],
): Pick<WindowStats, 'totalCalls' | 'errorRate' | 'toolMix'> {
  const totalsByTool: Record<string, number> = {};
  let totalCalls = 0;
  let totalErrorCalls = 0;

  for (const sample of samples) {
    const tool = sample.metric?.tool ?? 'unknown';
    const outcome = sample.metric?.outcome === 'error' ? 'error' : 'ok';
    const raw = sample.value?.[1];
    const count = raw === undefined ? 0 : Number(raw);
    if (!Number.isFinite(count)) continue;

    totalsByTool[tool] = (totalsByTool[tool] ?? 0) + count;
    totalCalls += count;
    if (outcome === 'error') totalErrorCalls += count;
  }

  const toolMix: Record<string, number> = {};
  if (totalCalls > 0) {
    for (const [tool, count] of Object.entries(totalsByTool)) {
      toolMix[tool] = count / totalCalls;
    }
  }

  return {
    totalCalls,
    errorRate: totalCalls > 0 ? totalErrorCalls / totalCalls : 0,
    toolMix,
  };
}
