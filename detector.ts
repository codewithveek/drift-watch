/**
 * Behavioral drift detection — the "AI analysis over traces" layer.
 *
 * 1. Query SigNoz for aggregate agent behavior over two windows.
 * 2. Compute deltas (tool mix, error rate, p95 latency, token spend).
 * 3. Ask the LLM (any provider) to classify drift, with generateObject giving
 *    a schema-guaranteed verdict — no fragile JSON parsing.
 *
 * SigNoz query API: v4 query_range accepts a builder payload and returns
 * aggregated series. Auth via a SIGNOZ-API-KEY header (Settings -> API Keys).
 */
import { generateObject } from 'ai';
import { z } from 'zod';
import { resolveModel } from '../agent/model.js';

const SIGNOZ_URL = process.env.SIGNOZ_URL ?? 'http://localhost:8080';
const SIGNOZ_API_KEY = process.env.SIGNOZ_API_KEY ?? '';

interface WindowStats {
  label: string;
  totalCalls: number;
  errorRate: number;
  p95LatencyMs: number;
  tokenSpend: number;
  toolMix: Record<string, number>; // tool name -> call share (0..1)
}

const DriftVerdict = z.object({
  drift: z.boolean(),
  severity: z.enum(['none', 'low', 'medium', 'high']),
  reasons: z.array(z.string()),
  recommended_action: z.string(),
});
export type DriftVerdict = z.infer<typeof DriftVerdict>;

/**
 * Query SigNoz for one window via the query_range builder API and aggregate
 * our custom metrics (agent.tool.calls, agent.tool.duration, token usage).
 * Response shape is version-specific — adapt parseStats to your instance.
 * See signoz.io/docs/userguide/query-builder.
 */
async function queryWindow(
  label: string,
  startMs: number,
  endMs: number,
): Promise<WindowStats> {
  const body = {
    start: startMs,
    end: endMs,
    step: 60,
    compositeQuery: {
      queryType: 'builder',
      panelType: 'table',
      builderQueries: {
        A: {
          dataSource: 'metrics',
          aggregateAttribute: { key: 'agent.tool.calls' },
          aggregateOperator: 'sum',
          groupBy: [{ key: 'tool' }, { key: 'outcome' }],
          expression: 'A',
        },
      },
    },
  };

  const res = await fetch(`${SIGNOZ_URL}/api/v4/query_range`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'SIGNOZ-API-KEY': SIGNOZ_API_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`SigNoz query failed: ${res.status} ${await res.text()}`);
  }
  return parseStats(label, await res.json());
}

function parseStats(label: string, _raw: unknown): WindowStats {
  // TODO: map _raw series -> WindowStats against your SigNoz version.
  return {
    label,
    totalCalls: 0,
    errorRate: 0,
    p95LatencyMs: 0,
    tokenSpend: 0,
    toolMix: {},
  };
}

/** Ask the LLM (any provider) whether `current` drifted from `baseline`. */
async function judgeDrift(
  baseline: WindowStats,
  current: WindowStats,
): Promise<DriftVerdict> {
  const { model } = await resolveModel();
  const { object } = await generateObject({
    model,
    schema: DriftVerdict,
    experimental_telemetry: { isEnabled: true, functionId: 'drift-judge' },
    prompt: `You are an SRE copilot monitoring an AI agent for behavioral drift.
Compare the CURRENT window against the BASELINE and decide whether the agent's
behavior has drifted enough to warrant a human alert. Consider shifts in
tool-call mix, rising error rate, latency regressions, and token-spend spikes.

BASELINE: ${JSON.stringify(baseline)}
CURRENT:  ${JSON.stringify(current)}`,
  });
  return object;
}

export async function detectDrift() {
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const baseline = await queryWindow('baseline', now - 2 * hour, now - hour);
  const current = await queryWindow('current', now - hour, now);
  const verdict = await judgeDrift(baseline, current);
  return { baseline, current, verdict };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  detectDrift()
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
