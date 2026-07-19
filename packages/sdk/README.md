# @driftwatch/sdk

Self-observing AI agent SDK: OpenTelemetry instrumentation for
[AI SDK](https://ai-sdk.dev) agents, plus an LLM-over-traces behavioral
drift detector. Zero AI provider SDKs bundled, every function takes typed config/clients as parameters.

## Install

```bash
npm install @driftwatch/sdk ai zod
# plus exactly one AI SDK provider package for your chosen model.
# The reference deployment targets Qwen Cloud (OpenAI-compatible), so:
npm install @ai-sdk/openai
```

This SDK bundles **no** provider SDKs and never picks a provider from an env
var — you construct a model client with your provider package and pass it in.
Anthropic, Google, Mistral, Ollama, vLLM, Together, Groq, DeepSeek, or any
OpenAI-compatible endpoint all work the same way; swap the two lines that build
`modelClient` below.

## Quickstart

```ts
import {
  runAgentTask,
  detectBehavioralDrift,
  bootstrapTelemetry,
  loadDriftWatchConfigFromEnv,
} from '@driftwatch/sdk';
import { createOpenAI } from '@ai-sdk/openai';
import { tool } from 'ai';
import { z } from 'zod';

const config = loadDriftWatchConfigFromEnv();
bootstrapTelemetry(config.telemetry); // call before other imports run, e.g. via --import

// This deployment targets Qwen Cloud's OpenAI-compatible endpoint.
// Credentials come from the environment, never hardcoded.
const qwenCloud = createOpenAI({
  baseURL:
    process.env.QWEN_BASE_URL ??
    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  apiKey: process.env.QWEN_API_KEY ?? '',
});
const modelClient = qwenCloud(process.env.MODEL ?? 'qwen3.7-max');

const tools = {
  lookup_order: tool({
    description: 'Look up an order by id',
    inputSchema: z.object({ orderId: z.string() }),
    execute: async ({ orderId }) => ({ orderId, status: 'shipped' }),
  }),
};

const result = await runAgentTask({
  prompt: 'Where is order 4471?',
  modelClient,
  tools,
  maxSteps: config.agent.maxSteps,
  // Inline guardrails (Loop 1): abort/flag a single run the moment it crosses
  // a per-task token or cost cap. config.agent already carries these fields.
  guardrails: {
    maxTokensPerTask: config.agent.maxTokensPerTask, // 0 disables the check
    maxCostUsd: config.agent.maxCostUsd,             // 0 disables the check
    pricePer1kInput: config.agent.pricePer1kInput,
    pricePer1kOutput: config.agent.pricePer1kOutput,
    onExceed: config.agent.onExceed,                 // 'stop' halts mid-loop, 'flag' finishes and marks it
  },
});
console.log(result.responseText, result.tokenUsage);
if (result.guardrailTriggered) {
  console.warn('guardrail hit:', result.guardrailReason);
}

// Loop 2: LLM-over-traces drift detection. Use isDryRun for a fixture-backed
// run before you've generated real traffic (demos / CI).
const driftReport = await detectBehavioralDrift({
  modelClient,
  driftDetectionConfig: config.driftDetection,
  isDryRun: true,
});
console.log(driftReport.verdict, `(judge attempts: ${driftReport.judgeAttempts})`);
```

### Configuration

`loadDriftWatchConfigFromEnv()` reads these (all optional — every field has a
default, so the SDK runs with none of them set):

| Env var | Config path | Default | Purpose |
| --- | --- | --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `telemetry.otlpEndpoint` | `http://localhost:4318` | OTLP/HTTP collector endpoint |
| `OTEL_SERVICE_NAME` | `telemetry.serviceName` | `driftwatch` | `service.name` on every span/metric |
| `OTEL_CAPTURE_PAYLOADS` | `telemetry.capturePayloads` | `true` (set `0` to disable) | Attach prompt/tool-input text to spans |
| `AGENT_MAX_STEPS` | `agent.maxSteps` | `8` | Upper bound on the tool-use loop |
| `AGENT_MAX_TOKENS_PER_TASK` | `agent.maxTokensPerTask` | `0` (off) | Per-run token cap |
| `AGENT_MAX_COST_USD` | `agent.maxCostUsd` | `0` (off) | Per-run USD cap |
| `AGENT_PRICE_PER_1K_INPUT` / `AGENT_PRICE_PER_1K_OUTPUT` | `agent.pricePer1kInput` / `pricePer1kOutput` | `0` | Prices the USD cap is derived from |
| `AGENT_ON_EXCEED` | `agent.onExceed` | `stop` | `stop` halts at the breach; `flag` finishes and marks it |
| `SIGNOZ_URL` | `driftDetection.signozBaseUrl` | `http://localhost:8080` | SigNoz query-service API base URL |
| `SIGNOZ_API_KEY` | `driftDetection.signozApiKey` | `''` | SigNoz API key |

Prefer to build config yourself? Every SDK function takes a plain typed object —
validate your own against the same schema instead of reading `process.env`:

```ts
import { DriftWatchConfigSchema } from '@driftwatch/sdk';

const config = DriftWatchConfigSchema.parse({
  telemetry: { serviceName: 'checkout-agent', environment: 'production' },
  agent: { maxSteps: 12, maxTokensPerTask: 40_000, onExceed: 'stop' },
  driftDetection: { signozBaseUrl: 'https://signoz.internal' },
});
```

## What's in this package

- `runAgentTask` — a traced `generateText` tool-use loop. Takes
  `modelClient` and `tools` as parameters; returns task id, skills used,
  and token usage.
- `detectBehavioralDrift` — queries two time windows from a SigNoz-shaped
  backend, diffs them (tool mix, error rate, p95 latency, token spend), and
  asks the injected model to classify drift into a Zod-typed verdict. It drives
  the model with `generateText` and parses the JSON defensively (retrying up to
  3 times, surfaced as `judgeAttempts`) so it works against providers whose
  structured-output support is unreliable. Supports `isDryRun: true` for
  fixture-based demos/CI.
- `bootstrapTelemetry` — starts the OTel Node SDK and registers the AI SDK
  v7 telemetry bridge. Call once, before other application code (typically
  via `node --import`).
- `withSkillExecutionSpan` — wrap a tool's `execute` so every call emits a
  labelled span + the `agent.tool.calls` / `agent.tool.duration` metrics.
- `DriftWatchConfigSchema` / `loadDriftWatchConfigFromEnv` — Zod-validated
  typed config for telemetry, agent, and drift-detection settings.

Full docs, architecture, and the reference Fastify server that uses this
SDK live in the [workspace repo](https://github.com/codewithveek/drift-watch) —
see [`docs/`](https://github.com/codewithveek/drift-watch/tree/main/docs)
for guides and the [root README](https://github.com/codewithveek/drift-watch#readme)
for the full picture.

## License

MIT — see [LICENSE](https://github.com/codewithveek/drift-watch/blob/main/LICENSE).
