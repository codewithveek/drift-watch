# AgentPulse

An AI agent SDK that **observes itself**. Every skill (tool) call and LLM
step is traced via OpenTelemetry into a backend like [SigNoz](https://signoz.io),
and an AI layer on top of those traces flags **behavioral drift** — shifts in
tool-call mix, error rate, latency, or token spend between time windows.

> `agentpulse` is provisionally taken on npm under a different project — the
> package names below (`@agentpulse/sdk`, `@agentpulse/server`) are working
> names for this pnpm workspace, not yet a final published identity. See
> [Naming](#naming) at the bottom.

This is a pnpm workspace with two packages:

```
packages/
├── sdk/      @agentpulse/sdk     — publishable. Zero AI provider SDKs bundled,
│                                    zero direct process.env access. Every
│                                    function takes typed config/clients as
│                                    parameters.
└── server/   @agentpulse/server  — the reference Fastify app. Depends on the
                                     SDK via workspace:*, supplies demo skills
                                     and the one file where you wire up a real
                                     model provider.
```

**Bring your own model client.** The SDK does not bundle any AI provider SDK.
You construct a model with whichever AI SDK provider package you choose (or
none at all, via the built-in gateway default) and hand it to the SDK's
functions. No installing OpenAI's SDK to talk to Anthropic, no dead weight in
`node_modules` for providers you'll never call.

**Typed config, not scattered `process.env` reads.** Every setting the SDK
needs — telemetry endpoint, agent step limit, drift-detector target — is a
Zod-validated typed object (`AgentPulseConfig`), injected into whichever
function needs it. `loadAgentPulseConfigFromEnv()` is a convenience loader for
the common case, but you can build that object however you want: from your
own app's parsed env config, a literal object in tests, anything.

> Looking for guided docs instead of one long README? See
> [`docs/`](./docs/README.md) — quickstart, config reference, architecture,
> deployment, and security.

## The idea in one line

> Instrument an agent's decisions as telemetry, then run an LLM over that
> telemetry to notice when the agent starts behaving differently.

## Typed config

```ts
import { AgentPulseConfigSchema, loadAgentPulseConfigFromEnv } from '@agentpulse/sdk';

// convenience: read from process.env
const config = loadAgentPulseConfigFromEnv();

// or build one however your app already manages config
const config = AgentPulseConfigSchema.parse({
  telemetry: { serviceName: 'checkout-agent', environment: 'production' },
  agent: { maxSteps: 12 },
  driftDetection: { signozBaseUrl: 'https://signoz.internal' },
});
```

`packages/server` has its own small `ServerConfig` schema (HTTP port, auth
token, body limits) alongside the SDK's config — see
`packages/server/src/config/server-config.ts`. Same pattern, kept separate
because those settings are specific to this reference server, not the SDK.

## Bring your own model client

There is exactly one file to touch: `packages/server/src/config/model-client.ts`.
The server imports the `modelClient` it exports and uses it for both the
agent and the drift judge — nowhere else in the codebase chooses a provider.

**Zero-install default** (Vercel AI Gateway — bundled inside the `ai`
package itself):

```ts
import { gateway } from 'ai';
export const modelClient = gateway(process.env.MODEL ?? 'anthropic/claude-3-5-sonnet');
```
```bash
AI_GATEWAY_API_KEY=... pnpm dev
```

**Any other provider** — install exactly that one package, swap two lines:

```ts
// pnpm --filter @agentpulse/server add @ai-sdk/anthropic
import { anthropic } from '@ai-sdk/anthropic';
export const modelClient = anthropic(process.env.MODEL ?? 'claude-3-5-sonnet-latest');
```

Same pattern for `@ai-sdk/openai` and `@ai-sdk/google`. For any
OpenAI-compatible endpoint (Ollama, vLLM, Together, Groq, DeepSeek, ...):

```ts
// pnpm --filter @agentpulse/server add @ai-sdk/openai
import { createOpenAI } from '@ai-sdk/openai';
const openaiCompatibleClient = createOpenAI({
  baseURL: process.env.OPENAI_BASE_URL, // e.g. http://localhost:11434/v1
  apiKey: process.env.OPENAI_API_KEY ?? 'not-used',
});
export const modelClient = openaiCompatibleClient(process.env.MODEL ?? 'llama3.1');
```

The server refuses to start without a `modelClient` — there's no implicit
fallback beyond what you put in this file.

## Bring your own skills (tools)

The SDK's `runAgentTask` takes `tools` as a parameter too — it doesn't ship
any. `packages/server/src/tools.ts` has two demo skills (`get_weather`,
`search_docs`) showing the pattern: an AI SDK `tool()` wrapping
`withSkillExecutionSpan` so every call emits the SDK's labelled tool-call
counter + latency histogram. Swap in your own DB lookups, HTTP calls, vector
search — same pattern.

## Can this run on X?

- **Anything the Vercel AI SDK supports** — yes, first class. That's OpenAI,
  Anthropic, Google, AWS Bedrock, Cohere, Mistral, and every OpenAI-compatible
  endpoint (Ollama, vLLM, Together, Groq, DeepSeek, Fireworks), plus
  everything reachable via AI Gateway (~100 models under one key).
- **Raw Anthropic/OpenAI SDKs, LangChain, LlamaIndex, CrewAI, Mastra** — not
  supported without a rewrite. Skill definitions and telemetry both use AI SDK
  conventions (`tool()`, `generateText`).
- The drift judge calls `generateObject` (structured output); your model
  needs tool-calling or JSON-mode support. Very small local models may fail
  here.

## Architecture

```
POST /run ──▶ Fastify (auto-instrumented)                    @agentpulse/server
                 └─ runAgentTask(...)                         @agentpulse/sdk
                     └─ span: agent.run (task id, skills used, token spend)
                         ├─ AI SDK generateText loop
                         │    ├─ span: gen_ai.step        (model, tokens, finish reason)
                         │    ├─ span: tool.get_weather   (latency, outcome)
                         │    └─ span: gen_ai.step
                              │
                              ▼  OTLP/HTTP :4318
                           SigNoz collector ──▶ ClickHouse ──▶ SigNoz UI
                              │
GET /drift ──▶ detectBehavioralDrift(...) ─┘  queries two windows, diffs them,
                                               generateObject → schema-typed verdict
```

## Tracking: tokens, tasks, skills, provider & model

Every `/run` call returns a `usage` object directly in the response — no trip
to a tracing backend required to answer "how many tokens did that cost":

```jsonc
{
  "output": "It's 24°C in Lagos. Found 3 onboarding docs.",
  "usage": {
    "taskId": "b3f1...e2",
    "responseText": "It's 24°C in Lagos. Found 3 onboarding docs.",
    "stepCount": 3,
    "skillsUsed": ["get_weather", "search_docs"],
    "tokenUsage": { "inputTokens": 812, "outputTokens": 96, "totalTokens": 908 },
    "providerName": "anthropic",
    "modelIdentifier": "claude-3-5-sonnet-latest"
  }
}
```

The same fields land on the `agent.run` root span (`agent.task_id`,
`agent.skills_used`, `gen_ai.usage.*`, `gen_ai.provider`,
`gen_ai.request.model`), so you can look up one task's full trace by id and
see every skill it invoked and every token it spent.

Aggregate token spend is also exported as the `agent.tokens` counter, labelled
by `model`, `provider`, `type` (input/output), and `function_id` (`agent-run`
vs. `drift-judge`) — enough to chart total spend per provider/model/task-type
over time without unbounded per-request cardinality on a metric.

| Signal | Type | Answers |
|---|---|---|
| `agent.tool.calls{tool,outcome}` | counter | how often each skill gets called |
| `agent.tool.duration{tool}` | histogram | latency regressions per skill |
| `agent.tokens{model,provider,function_id,type}` | counter | token spend by provider/model/task-type |
| `agent.run` span attrs | trace | per-task id, skills used, exact token spend |
| `gen_ai.step` / `tool.*` spans | traces | full decision chain |

## Run it

### 1. Bring up SigNoz

```bash
git clone https://github.com/SigNoz/signoz && cd signoz/deploy/docker
docker compose up -d   # UI on :8080
```

### 2. Configure a model client and run the server

```bash
cd /path/to/agentpulse
cp packages/server/.env.example packages/server/.env
# fill in AI_GATEWAY_API_KEY (or edit packages/server/src/config/model-client.ts for a direct provider)
pnpm install
pnpm dev
```

### 3. Drive traffic

```bash
curl -XPOST localhost:3000/run -H 'content-type: application/json' \
  -d '{"prompt":"weather in Lagos, then search docs for onboarding"}'

# or seed 40 mixed requests
BASE_URL=http://localhost:3000 pnpm seed 40
```

### 4. Drift report

```bash
# against real SigNoz data:
curl localhost:3000/drift

# without SigNoz, using built-in fixtures — great for demos + CI:
pnpm drift:dry-run
```

### 5. Docker

Build context is the workspace root (the server's Dockerfile uses
`pnpm deploy` to pull in the SDK as real files, not a workspace symlink):

```bash
docker build -f packages/server/Dockerfile -t agentpulse-server .
docker run --rm -p 3000:3000 --env-file packages/server/.env agentpulse-server
```

## Security

- `/run` and `/drift` are gated by a bearer token, compared with
  `crypto.timingSafeEqual` (not `===`) so response timing can't be used to
  guess it byte by byte. Set `AUTH_TOKEN=<secret>` in `.env`; clients pass
  `Authorization: Bearer <secret>`.
- When `AUTH_TOKEN` is unset, the server refuses everything outside RFC 1918
  private ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) plus
  loopback — model tokens cost money, so no anonymous production access by
  accident.
- `MAX_PROMPT_BYTES` (default 8 KiB) caps prompt size; `BODY_LIMIT` (128 KiB)
  caps overall request size.
- `RATE_LIMIT_MAX` requests per `RATE_LIMIT_WINDOW_MS` (default 30/60s) are
  enforced per client on `/run` and `/drift` — a leaked or shared token can't
  be used to run up unbounded model spend.
- `OTEL_CAPTURE_PAYLOADS` (default `1`) controls whether raw prompt text and
  tool-call inputs get attached to spans. Set to `0` if prompts/tool inputs
  may carry PII or secrets that shouldn't land in the tracing backend —
  span/metric names and token counts are unaffected either way.

## Using the SDK standalone

`@agentpulse/sdk` doesn't require the reference server at all:

```ts
import {
  runAgentTask,
  detectBehavioralDrift,
  bootstrapTelemetry,
  loadAgentPulseConfigFromEnv,
} from '@agentpulse/sdk';
import { anthropic } from '@ai-sdk/anthropic';
import { tool } from 'ai';
import { z } from 'zod';

const config = loadAgentPulseConfigFromEnv();
bootstrapTelemetry(config.telemetry); // call before other imports run, e.g. via --import

const modelClient = anthropic('claude-3-5-sonnet-latest');
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
});
console.log(result.responseText, result.tokenUsage);

const driftReport = await detectBehavioralDrift({
  modelClient,
  driftDetectionConfig: config.driftDetection,
});
```

## Files

**`packages/sdk/src/`** (publishable, no provider SDKs, no direct env access):
- `config/schema.ts` — `AgentPulseConfigSchema` + `loadAgentPulseConfigFromEnv`.
- `model-client.ts` — the `ModelClient` type + helpers to read provider/model
  identity off an injected client.
- `agent/runner.ts` — `runAgentTask`: takes `modelClient`, `tools`, `maxSteps`
  as parameters; returns task id, skills used, and token usage per call.
- `drift/detector.ts` — `detectBehavioralDrift`, AI-over-traces drift layer
  with dry-run fixtures.
- `telemetry/otel.ts` — `bootstrapTelemetry(telemetryConfig)`: starts the OTel
  SDK + registers the AI SDK integration. Must run before other app code.
- `telemetry/ai-sdk-otel.ts` — AI SDK v7 → OTel Telemetry bridge.
- `telemetry/instrument.ts` — `withSkillExecutionSpan` (labelled skill
  metrics).
- `telemetry/usage-tracking.ts` — shared token-usage summary + span attribute
  helpers.
- `telemetry/capture-config.ts` — process-wide toggle (set by
  `bootstrapTelemetry` from `TelemetryConfig.capturePayloads`) for whether
  raw prompt/tool-input text is attached to spans.

**`packages/server/src/`** (the reference app):
- `config/model-client.ts` — **the one file to edit** for a real provider.
- `config/server-config.ts` — `ServerConfig` schema (port, auth, body limits).
- `tools.ts` — demo skills.
- `telemetry-bootstrap.ts` — `--import` preload that loads config and calls
  `bootstrapTelemetry`.
- `routes/agent.ts` + `server.ts` — Fastify surface, composition root.
- `cli/drift.ts` — `pnpm drift` / `pnpm drift:dry-run`.
- `scripts/seed-traffic.ts` — traffic generator for demos.

## Naming

The npm name `agent-pulse` is already taken by another project, so
`@agentpulse/sdk` / `@agentpulse/server` here are working names, not a final
published identity — expect these to change before anything is actually
published to npm.

## License

MIT — see [LICENSE](./LICENSE).
