# AgentPulse

An AI agent that **observes itself**. Every skill (tool) call and LLM step is
traced via OpenTelemetry into [SigNoz](https://signoz.io), and an AI layer on
top of those traces flags **behavioral drift** — shifts in tool-call mix,
error rate, latency, or token spend between time windows.

**Bring your own model client.** AgentPulse does not bundle any AI provider
SDK. You construct a model with whichever AI SDK provider package you choose
(or none at all, via the built-in gateway default) and hand it to AgentPulse.
No installing OpenAI's SDK to talk to Anthropic, no dead weight in your
`node_modules` for providers you'll never call.

## The idea in one line

> Instrument an agent's decisions as telemetry, then run an LLM over that
> telemetry to notice when the agent starts behaving differently.

## Bring your own model client

There is exactly one file to touch: `src/config/model-client.ts`. AgentPulse
imports the `modelClient` it exports and uses it for both the agent and the
drift judge — nowhere else in the codebase chooses a provider.

**Zero-install default** (Vercel AI Gateway — bundled inside the `ai`
package itself):

```ts
import { gateway } from 'ai';
export const modelClient = gateway(process.env.MODEL ?? 'anthropic/claude-3-5-sonnet');
```
```bash
AI_GATEWAY_API_KEY=... npm run dev
```

**Any other provider** — install exactly that one package, swap two lines:

```ts
// npm install @ai-sdk/anthropic
import { anthropic } from '@ai-sdk/anthropic';
export const modelClient = anthropic(process.env.MODEL ?? 'claude-3-5-sonnet-latest');
```

Same pattern for `@ai-sdk/openai` and `@ai-sdk/google`. For any
OpenAI-compatible endpoint (Ollama, vLLM, Together, Groq, DeepSeek, ...):

```ts
// npm install @ai-sdk/openai
import { createOpenAI } from '@ai-sdk/openai';
const openaiCompatibleClient = createOpenAI({
  baseURL: process.env.OPENAI_BASE_URL, // e.g. http://localhost:11434/v1
  apiKey: process.env.OPENAI_API_KEY ?? 'not-used',
});
export const modelClient = openaiCompatibleClient(process.env.MODEL ?? 'llama3.1');
```

AgentPulse refuses to start without a `modelClient` — there's no implicit
fallback beyond what you put in this file.

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
POST /run ──▶ Fastify (auto-instrumented)
                 └─ span: agent.run (task id, skills used, token spend)
                     ├─ AI SDK generateText loop
                     │    ├─ span: gen_ai.step        (model, tokens, finish reason)
                     │    ├─ span: tool.get_weather   (latency, outcome)
                     │    └─ span: gen_ai.step
                          │
                          ▼  OTLP/HTTP :4318
                       SigNoz collector ──▶ ClickHouse ──▶ SigNoz UI
                          │
GET /drift ──▶ detector ─┘  queries two windows, diffs them,
                            generateObject → schema-typed drift verdict
```

## Tracking: tokens, tasks, skills, provider & model

Every `/run` call returns a `usage` object directly in the response — no trip
to SigNoz required to answer "how many tokens did that cost":

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

The same fields land on the `agent.run` root span in SigNoz (`agent.task_id`,
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

### 2. Configure a model client and run the agent

```bash
cd /path/to/agentpulse
cp .env.example .env    # fill in AI_GATEWAY_API_KEY (or edit src/config/model-client.ts for a direct provider)
npm install
npm run dev
```

### 3. Drive traffic

```bash
curl -XPOST localhost:3000/run -H 'content-type: application/json' \
  -d '{"prompt":"weather in Lagos, then search docs for onboarding"}'

# or seed 40 mixed requests
BASE_URL=http://localhost:3000 npm run seed 40
```

### 4. Drift report

```bash
# against real SigNoz data:
curl localhost:3000/drift

# without SigNoz, using built-in fixtures — great for demos + CI:
npm run drift:dry-run
```

### 5. Docker

```bash
docker build -t agentpulse .
docker run --rm -p 3000:3000 --env-file .env agentpulse
```

## Security

- `/run` and `/drift` are gated by a bearer token. Set `AUTH_TOKEN=<secret>` in
  `.env`; clients pass `Authorization: Bearer <secret>`.
- When `AUTH_TOKEN` is unset, the server refuses non-local IPs — model tokens
  cost money, so no anonymous production access by accident.
- `MAX_PROMPT_BYTES` (default 8 KiB) caps prompt size; `BODY_LIMIT` (128 KiB)
  caps overall request size.

## Files

- `src/config/model-client.ts` — **the one file to edit.** Bring-your-own
  model client.
- `src/agent/model-client.ts` — the `ModelClient` type + helpers to read
  provider/model identity off an injected client.
- `src/telemetry/otel.ts` — OTel SDK bootstrap + AI SDK integration
  registration. **Must** load before app code (`--import`).
- `src/telemetry/ai-sdk-otel.ts` — AI SDK v7 → OTel Telemetry bridge.
- `src/telemetry/instrument.ts` — `withSkillExecutionSpan` (labelled skill
  metrics).
- `src/telemetry/usage-tracking.ts` — shared token-usage summary + span
  attribute helpers.
- `src/agent/tools.ts` — AI SDK `tool()` (skill) defs with Zod schemas.
- `src/agent/runner.ts` — `generateText` agent loop; returns task id, skills
  used, and token usage per call.
- `src/drift/detector.ts` — AI-over-traces drift layer with dry-run fixtures.
- `src/routes/agent.ts` + `src/server.ts` — Fastify surface.
- `scripts/seed-traffic.ts` — traffic generator for demos.

## License

MIT — see [LICENSE](./LICENSE).
