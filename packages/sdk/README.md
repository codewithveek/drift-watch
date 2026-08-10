# @driftwatch/sdk

Self-observing AI agent SDK: OpenTelemetry instrumentation for
[AI SDK](https://ai-sdk.dev) agents, plus an LLM-over-traces behavioral
drift detector. Zero AI provider SDKs bundled, every function takes typed config/clients as parameters.

## Install

```bash
npm install @driftwatch/sdk ai zod
# plus exactly one AI SDK provider package for your chosen model, e.g.
npm install @ai-sdk/openai
```

Requires Node ≥ 22.

This SDK bundles **no** provider SDKs and never picks a provider from an env
var — you construct a model client with your provider package and pass it in.
Anthropic, Google, Mistral, Ollama, vLLM, Together, Groq, DeepSeek, or any
OpenAI-compatible endpoint all work the same way; swap the line that builds
`modelClient` below.

## Quickstart

Start telemetry with the bundled preload — no file of your own, and it runs
before your app's imports are evaluated (which is the only way OpenTelemetry
can patch pino/Fastify/database drivers in time):

```bash
node --env-file=.env --import @driftwatch/sdk/preload app.js
```

```ts title="app.js"
import { runAgentTask, detectBehavioralDrift, loadDriftWatchConfigFromEnv } from '@driftwatch/sdk';
import { openai } from '@ai-sdk/openai';
import { tool } from 'ai';
import { z } from 'zod';

const config = loadDriftWatchConfigFromEnv(); // every field has a default

const tools = {
  lookup_order: tool({
    description: 'Look up an order by id',
    inputSchema: z.object({ orderId: z.string() }),
    execute: async ({ orderId }) => ({ orderId, status: 'shipped' }),
  }),
};

const result = await runAgentTask({
  prompt: 'Where is order 4471?',
  modelClient: openai('gpt-4o-mini'), // any AI SDK provider client
  tools,
  maxSteps: config.agent.maxSteps,
  // Inline guardrails (Loop 1): abort/flag a single run the moment it crosses
  // a per-task token or cost cap. 0 disables a given check.
  guardrails: toAgentGuardrails(config.agent),
});
console.log(result.responseText, result.tokenUsage);
if (result.guardrailTriggered) {
  console.warn('guardrail hit:', result.guardrailReason);
}

// Loop 2: LLM-over-traces drift detection. isDryRun uses built-in fixtures, so
// this works before any real traffic exists (demos / CI); metricsQuerySource
// is required unless isDryRun is true.
const driftReport = await detectBehavioralDrift({ modelClient: openai('gpt-4o-mini'), isDryRun: true });
console.log(driftReport.verdict, `(judge attempts: ${driftReport.judgeAttempts})`);
```

### Per-agent guardrails and tool-call policies

For an agent with its own caps and pre-execution tool gating, `createAgentRuntime`
binds the context once instead of threading it through every call:

```ts
import { createAgentRuntime, DriftWatchConfigSchema, generateAgentSlug } from '@driftwatch/sdk';

const runtime = createAgentRuntime({
  agent: {
    id: generateAgentSlug('Support Agent'),
    name: 'Support Agent',
    guardrails: { maxTokensPerTask: 20_000 },
    toolPolicies: [
      { tool: 'issue_refund', field: 'amountUsd', condition: { gt: 100 },
        action: 'deny', severity: 'high', reason: 'refunds over $100 need a human' },
    ],
    createdAt: Date.now(),
  },
  config: DriftWatchConfigSchema.parse({}),
});

const gatedTools = {
  issue_refund: tool({
    description: 'Issue a refund for an order',
    inputSchema: z.object({ orderId: z.string(), amountUsd: z.number() }),
    execute: runtime.skill('issue_refund', async (input) => ({ refunded: true, ...input })),
  }),
};

await runtime.run({ prompt: 'Refund order A-4471 in full.', modelClient: openai('gpt-4o-mini'), tools: gatedTools });
```

A denied call throws inside the tool, which the AI SDK surfaces to the model as
a tool error — so the agent can adapt (escalate, explain, try something else)
instead of the run failing. A `deny`-only policy needs no store and no
notifiers; only `require_approval` does.

### Configuration

`loadDriftWatchConfigFromEnv()` reads these (all optional — every field has a
default, so the SDK runs with none of them set):

| Env var | Config path | Default | Purpose |
| --- | --- | --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `telemetry.otlpEndpoint` | `http://localhost:4318` | OTLP/HTTP base endpoint; traces, metrics and logs go to `<endpoint>/v1/{traces,metrics,logs}` |
| `OTEL_EXPORTER_OTLP_HEADERS` | `telemetry.otlpHeaders` | `{}` | Headers on every OTLP export (`k=v,k2=v2`). For a managed collector needing an ingestion key: `x-api-key=<key>` |
| `OTEL_SERVICE_NAME` | `telemetry.serviceName` | `driftwatch` | `service.name` on every span/metric |
| `OTEL_CAPTURE_PAYLOADS` | `telemetry.capturePayloads` | `true` (set `0` to disable) | Attach prompt/tool-input text to spans |
| `AGENT_MAX_STEPS` | `agent.maxSteps` | `8` | Upper bound on the tool-use loop |
| `AGENT_MAX_TOKENS_PER_TASK` | `agent.maxTokensPerTask` | `0` (off) | Per-run token cap |
| `AGENT_MAX_COST_USD` | `agent.maxCostUsd` | `0` (off) | Per-run USD cap |
| `AGENT_PRICE_PER_1K_INPUT` / `AGENT_PRICE_PER_1K_OUTPUT` | `agent.pricePer1kInput` / `pricePer1kOutput` | `0` | Prices the USD cap is derived from |
| `AGENT_ON_EXCEED` | `agent.onExceed` | `stop` | `stop` halts at the breach; `flag` finishes and marks it |
| `PROMETHEUS_URL` | `driftDetection.prometheusBaseUrl` | `http://localhost:9090` | Prometheus-compatible query API base URL (Prometheus, Mimir, Cortex, Thanos, ...) |
| `PROMETHEUS_BEARER_TOKEN` | `driftDetection.prometheusBearerToken` | `''` | Optional bearer token, e.g. for Grafana Cloud / Mimir multi-tenant auth |

Prefer to build config yourself? Every SDK function takes a plain typed object —
validate your own against the same schema instead of reading `process.env`:

```ts
import { DriftWatchConfigSchema } from '@driftwatch/sdk';

const config = DriftWatchConfigSchema.parse({
  telemetry: { serviceName: 'checkout-agent', environment: 'production' },
  agent: { maxSteps: 12, maxTokensPerTask: 40_000, onExceed: 'stop' },
  driftDetection: { prometheusBaseUrl: 'https://prometheus.internal' },
});
```

## What's in this package

- `runAgentTask` — a traced `generateText` tool-use loop. Takes
  `modelClient` and `tools` as parameters; returns task id, skills used,
  and token usage.
- `detectBehavioralDrift` — queries two time windows through an injected
  `MetricsQuerySource`, diffs them (tool mix, error rate, p95 latency, token
  spend), and asks the injected model to classify drift into a Zod-typed
  verdict. It drives the model with `generateText` and parses the JSON
  defensively (retrying up to 3 times, surfaced as `judgeAttempts`) so it works
  against providers whose structured-output support is unreliable. Supports
  `isDryRun: true` for fixture-based demos/CI (no `MetricsQuerySource` needed).
- `PrometheusMetricsSource` — the built-in `MetricsQuerySource`: queries any
  Prometheus-compatible `/api/v1/query` API (Prometheus, Grafana
  Mimir/Cortex/Thanos, ...). Targeting a different metrics backend? Implement
  `MetricsQuerySource` yourself instead.
- `bootstrapTelemetry` — starts the OTel Node SDK and registers the AI SDK
  v7 telemetry bridge. Call once, before other application code (typically
  via `node --import`). Exports traces, metrics and logs over OTLP/HTTP.
  Metrics use **cumulative** temporality (the OTel default) so PromQL's
  `increase()`/`rate()` — and so `PrometheusMetricsSource` — see meaningful
  counters; logs carry `trace_id`/`span_id` (via the pino auto-instrumentation)
  for trace↔log correlation.
- `withSkillExecutionSpan` — wrap a tool's `execute` so every call emits a
  labelled span + the `agent.tool.calls` / `agent.tool.duration` metrics.
- `DriftWatchConfigSchema` / `loadDriftWatchConfigFromEnv` — Zod-validated
  typed config for telemetry, agent, and drift-detection settings.
- `ApprovalService` / `AutopilotScheduler` / `executeControlAction` — the full
  perceive→reason→act orchestration engine: runs drift detection on a
  schedule, evaluates policies, dispatches notifications, and manages
  human-in-the-loop approvals for control actions (pause/rollback/throttle/
  switch_model). Built entirely on the `StateStore`/`Notifier` interfaces
  below — no concrete I/O, so it costs nothing to import.
- `MemoryStateStore` — the zero-dependency `StateStore` implementation
  (single-process). For multi-process, `RedisStateStore` lives at the isolated
  subpath `@driftwatch/sdk/redis`, with `ioredis` as an optional peer
  dependency — importing the package root never pulls it in.
- `evaluatePolicies` — the pure function mapping a `DriftReport` + policy
  config to a list of action intents.

Concrete Slack/Telegram/webhook notifiers and inbound-webhook signature
verification are a separate companion package,
[`@driftwatch/autopilot`](https://www.npmjs.com/package/@driftwatch/autopilot) —
install it only if you use those channels.

Full docs, architecture, and the reference Fastify server that uses this SDK
are at **[drift-watch-docs.vercel.app](https://drift-watch-docs.vercel.app)**;
the [root README](https://github.com/codewithveek/drift-watch#readme) has the
full picture.

## License

MIT — see [LICENSE](https://github.com/codewithveek/drift-watch/blob/main/LICENSE).
