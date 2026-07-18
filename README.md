# DriftWatch

An AI agent SDK that **observes itself** — and, optionally, **remediates
itself**. Every skill (tool) call and LLM step is traced via OpenTelemetry
into a backend like [SigNoz](https://signoz.io), an AI layer flags
**behavioral drift** (shifts in tool-call mix, error rate, latency, or token
spend), and a policy-driven **autopilot** turns that drift into action —
notify, pause, rollback, throttle — with a human in the loop for anything
destructive.

This is a pnpm workspace with three packages:

```
packages/
├── sdk/       @driftwatch/sdk      — publishable. Zero AI provider SDKs bundled,
│                                     zero direct process.env access. Owns
│                                     telemetry, drift detection, inline
│                                     guardrails, and the pure policy engine.
├── server/    @driftwatch/server   — the reference Fastify app. Depends on the
│                                     SDK via workspace:*, supplies demo skills,
│                                     wires the model provider (Qwen Cloud), and
│                                     owns all I/O: state store, notifiers,
│                                     autopilot scheduler, control-plane API.
└── console/   @driftwatch/console  — Vite + React + Tailwind operator console:
                                      approvals queue, drift feed, action log,
                                      agent-health strip. Served at /console/.
```

**Bring your own model client.** The SDK does not bundle any AI provider SDK.
You construct a model with whichever AI SDK provider package you choose and
hand it to the SDK's functions. This deployment targets Qwen Cloud via
`@ai-sdk/openai`. No installing OpenAI's SDK to talk to Anthropic, no dead
weight in `node_modules` for providers you'll never call.

**Typed config, not scattered `process.env` reads.** Every setting the SDK
needs — telemetry endpoint, agent step limit, drift-detector target — is a
Zod-validated typed object (`DriftWatchConfig`), injected into whichever
function needs it. `loadDriftWatchConfigFromEnv()` is a convenience loader
for the common case, but you can build that object however you want: from
your own app's parsed env config, a literal object in tests, anything.

> Looking for guided docs instead of one long README? See
> [`docs/`](./docs/README.md) — quickstart, config reference, architecture,
> deployment, and security.

## The idea in one line

> Instrument an agent's decisions as telemetry, then run an LLM over that
> telemetry to notice when the agent starts behaving differently — and act on
> it, with a human in the loop.

## Typed config

```ts
import { DriftWatchConfigSchema, loadDriftWatchConfigFromEnv } from '@driftwatch/sdk';

// convenience: read from process.env
const config = loadDriftWatchConfigFromEnv();

// or build one however your app already manages config
const config = DriftWatchConfigSchema.parse({
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

**This deployment targets Qwen Cloud** (OpenAI-compatible endpoint) via
`@ai-sdk/openai`. Credentials come from `.env`, never hardcoded:

```ts
import { createOpenAI } from '@ai-sdk/openai';
const qwenCloud = createOpenAI({
  baseURL: process.env.QWEN_BASE_URL ?? 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  apiKey: process.env.QWEN_API_KEY ?? '',
});
export const modelClient = qwenCloud(process.env.MODEL ?? 'qwen3.7-max');
```
```bash
QWEN_API_KEY=... MODEL=qwen3.7-max pnpm dev
```

**Any other provider** — install exactly that one package, swap two lines:

```ts
// pnpm --filter @driftwatch/server add @ai-sdk/anthropic
import { anthropic } from '@ai-sdk/anthropic';
export const modelClient = anthropic(process.env.MODEL ?? 'claude-3-5-sonnet-latest');
```

Same pattern for `@ai-sdk/google`, or point `createOpenAI`'s `baseURL` at any
OpenAI-compatible endpoint (Ollama, vLLM, Together, Groq, DeepSeek, ...).

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
POST /run ──▶ Fastify (auto-instrumented)                    @driftwatch/server
                 └─ runAgentTask(...)                         @driftwatch/sdk
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

## Autopilot: perceive → reason → act

Drift detection is only the *perceive* step. Autopilot closes the loop with
two independent control loops:

- **Loop 1 — inline guardrails** (SDK, synchronous). `runAgentTask` enforces
  per-request token/cost caps *inside* the `generateText` loop via a
  `stopWhen` condition, alongside the step-count limit. A runaway request
  aborts before it can even pollute the drift windows. Set
  `AGENT_MAX_TOKENS_PER_TASK` / `AGENT_MAX_COST_USD`; `AGENT_ON_EXCEED=stop|flag`.
- **Loop 2 — drift-triggered remediation** (server, async). A scheduler
  periodically runs drift detection, feeds the report through a **pure policy
  engine** (`evaluatePolicies`, in the SDK) to produce action intents, then:
  - **notify** actions (Slack / Telegram / webhook) fire immediately;
  - **control** actions (pause / rollback / throttle / switch_model) create an
    **approval** and post Approve/Reject to every channel.

```
scheduler tick ── leader lock (SET NX PX) ── detectBehavioralDrift
   └─ evaluatePolicies(report, policy)  → ActionIntent[]         (pure, SDK)
        ├─ notify_*  → Slack / Telegram / webhook                (immediate)
        └─ control_* → Approval → resolve() from console | Slack | Telegram
                          └─ executeControlAction → mutate shared state
```

**Approvals are channel-agnostic and multi-process-safe.** Every pending
approval lives in a shared store (Redis in prod, in-memory for dev). Resolution
is atomic and idempotent, so the console, a Slack button, and a Telegram button
all resolve the *same* approval — first one wins, the rest are no-ops. Approve
a pause from your phone in Telegram; the console reflects it on its next poll. A
`SET NX PX` leader lock ensures exactly one process runs each drift cycle even
when you scale out. Unanswered approvals fall back to a safe default (reject)
after `AUTOPILOT_APPROVAL_TIMEOUT_MS`.

**Shadow mode** (`AUTOPILOT_MODE=shadow`, the default) runs the whole loop but
executes nothing — intended actions are logged, not taken. The full demo/CI
path is `AUTOPILOT_ENABLED=1 AUTOPILOT_MODE=shadow DRIFT_DRY_RUN=1`, which drives
perceive→reason→act off fixtures with zero external side effects.

**Control plane + console.** A bearer-gated API (`/state`, `/drift/history`,
`/approvals`, `/approvals/:id/resolve`, `/actions/log`, `/control/*`,
`/drift/scan`) exposes the shared state; the React console in
`packages/console` polls it and is served from the server at `/console/`. The
Slack/Telegram webhooks (`/integrations/*`) carry their own signature
verification, not the bearer token. Policies are configured via
`AUTOPILOT_POLICIES` (inline JSON) or `AUTOPILOT_POLICIES_FILE`.

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
cd /path/to/drift-watch
cp packages/server/.env.example packages/server/.env
# fill in QWEN_API_KEY (Qwen Cloud) — or edit packages/server/src/config/model-client.ts for another provider
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

### 5. Autopilot + console (optional)

Run the full perceive→reason→act loop safely off fixtures, then open the
operator console:

```bash
# drive the whole loop off fixtures, execute nothing (logs intended actions):
AUTOPILOT_ENABLED=1 AUTOPILOT_MODE=shadow DRIFT_DRY_RUN=1 pnpm dev

# build + open the console (polls the API with your AUTH_TOKEN):
pnpm --filter @driftwatch/console build   # then browse http://localhost:3000/console/
# or run the console dev server with hot reload + API proxy:
pnpm --filter @driftwatch/console dev
```

Wire Slack/Telegram (see [`docs/configuration.md`](./docs/configuration.md#notification--approval-channels))
to approve actions from anywhere — including your phone. Set `REDIS_URL` for
multi-process deployments.

### 6. Docker

Build context is the workspace root (the server's Dockerfile uses
`pnpm deploy` to pull in the SDK as real files, not a workspace symlink):

```bash
docker build -f packages/server/Dockerfile -t driftwatch-server .
docker run --rm -p 3000:3000 --env-file packages/server/.env driftwatch-server
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
- The **control-plane API** (`/state`, `/approvals`, `/control/*`, ...) reuses
  the exact same bearer gate as `/run`. The **Slack/Telegram webhooks**
  (`/integrations/*`) instead verify their own provider signatures — Slack's
  HMAC `X-Slack-Signature` (with a 5-minute replay window) and Telegram's
  `X-Telegram-Bot-Api-Secret-Token`, both compared in constant time. Approval
  resolution is atomic, so a duplicate or forged callback can't double-execute
  an action.

## Using the SDK standalone

`@driftwatch/sdk` doesn't require the reference server at all:

```ts
import {
  runAgentTask,
  detectBehavioralDrift,
  bootstrapTelemetry,
  loadDriftWatchConfigFromEnv,
} from '@driftwatch/sdk';
import { anthropic } from '@ai-sdk/anthropic';
import { tool } from 'ai';
import { z } from 'zod';

const config = loadDriftWatchConfigFromEnv();
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
- `config/schema.ts` — `DriftWatchConfigSchema` + `loadDriftWatchConfigFromEnv`.
- `model-client.ts` — the `ModelClient` type + helpers to read provider/model
  identity off an injected client.
- `agent/runner.ts` — `runAgentTask`: takes `modelClient`, `tools`, `maxSteps`
  as parameters; returns task id, skills used, and token usage per call. Also
  enforces the inline token/cost guardrails (Loop 1) via a `stopWhen` budget.
- `drift/detector.ts` — `detectBehavioralDrift`, AI-over-traces drift layer
  with dry-run fixtures.
- `autopilot/policy.ts` — `evaluatePolicies`: the **pure** policy engine
  mapping a drift report → action intents (notify vs. control), with
  severity/threshold conditions and cooldown.
- `autopilot/types.ts` — `ActionType`, `ActionIntent`, `Approval`,
  `AgentRuntimeState`, and the `StateStore` / `Notifier` / `ApprovalGateway`
  interfaces the server implements.
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
- `config/model-client.ts` — **the one file to edit** for a real provider
  (wired to Qwen Cloud by default).
- `config/server-config.ts` — `ServerConfig` schema (port, auth, body limits,
  autopilot + notifier settings).
- `config/policy-loader.ts` — loads the policy from `AUTOPILOT_POLICIES` /
  `AUTOPILOT_POLICIES_FILE`, with a built-in default.
- `tools.ts` — demo skills.
- `telemetry-bootstrap.ts` — `--import` preload that loads config and calls
  `bootstrapTelemetry`.
- `routes/auth.ts` — the shared bearer / local-network gate.
- `routes/agent.ts` — `/run` + `/drift`.
- `routes/console.ts` — the bearer-gated control-plane API.
- `routes/integrations.ts` — Slack + Telegram webhooks (own signature checks).
- `state/redis-store.ts` + `state/memory-store.ts` — the `StateStore`
  implementations (multi-process Redis, or in-memory fallback).
- `notify/` — Slack / Telegram / webhook notifiers.
- `autopilot/actions.ts`, `autopilot/approval-service.ts`,
  `autopilot/scheduler.ts`, `autopilot/index.ts` — control-action executor,
  approval lifecycle, the autonomous loop, and the composition root.
- `server.ts` — Fastify surface, composition root (wires all of the above).
- `cli/drift.ts` — `pnpm drift` / `pnpm drift:dry-run`.
- `scripts/seed-traffic.ts` — traffic generator for demos.

**`packages/console/src/`** (the operator console):
- `App.tsx` — the SPA: approvals queue, drift feed, action log, health strip.
- `api.ts` — typed API client (bearer token in `localStorage`).
- `ui.tsx` — small shared presentational primitives.

## Naming

This project was built under the working name "AgentPulse" before settling
on DriftWatch (`@driftwatch/sdk` / `@driftwatch/server`) as its published
identity — `agentpulse`/`agent-pulse` were already taken on npm. If you spot
a stray "AgentPulse" or `agentpulse` anywhere (an old log line, a comment,
an external link), it's a leftover from that phase, not a second product.

## License

MIT — see [LICENSE](./LICENSE).
