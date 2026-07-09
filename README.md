# agent-drift-watch

An AI agent that **observes itself**. Every tool call and LLM request is traced
via OpenTelemetry into SigNoz, and an AI layer on top of those traces flags
**behavioral drift** — shifts in tool-call mix, error rate, latency, or token
spend between time windows.

Provider-agnostic: runs on OpenAI, Anthropic, Google, or the Vercel AI Gateway
by changing two environment variables — no code changes.

Built for the **Agents of SigNoz** hackathon (Jul 20–26, 2026), Track 01 —
AI & Agent Observability.

## The idea, in one line

> Instrument an agent's decisions as telemetry, then run an LLM over that
> telemetry to notice when the agent starts behaving differently.

## Pick any provider (this is the "usable by anyone" part)

Set two env vars. No code edits.

```bash
# turnkey: one key, any model, no provider packages needed
AI_PROVIDER=gateway    MODEL=anthropic/claude-opus-4.8   AI_GATEWAY_API_KEY=...

AI_PROVIDER=openai     MODEL=gpt-5.2            OPENAI_API_KEY=...
AI_PROVIDER=anthropic  MODEL=claude-opus-4-6   ANTHROPIC_API_KEY=...
AI_PROVIDER=google     MODEL=gemini-3-flash    GOOGLE_GENERATIVE_AI_API_KEY=...
```

Provider packages are optional deps, imported dynamically — install only the one
you use. The `gateway` path needs no provider package at all.

## Architecture

```
POST /run ──▶ Fastify (auto-instrumented)
                 └─ span: agent.run
                     ├─ AI SDK generateText loop (experimental_telemetry)
                     │    ├─ span: llm step        (model, tokens — from AI SDK)
                     │    ├─ span: tool.get_weather (latency, outcome — our metric)
                     │    └─ span: llm step
                          │
                          ▼  OTLP/HTTP :4318
                       SigNoz collector ──▶ ClickHouse ──▶ SigNoz UI
                          │
GET /drift ──▶ detector ─┘  queries two windows, diffs them,
                            generateObject → schema-typed drift verdict
```

## Custom signals we emit (on top of AI SDK's built-in LLM spans)

| Signal | Type | Answers |
|---|---|---|
| `agent.tool.calls{tool,outcome}` | counter | "how often does xyz tool get called?" |
| `agent.tool.duration{tool}` | histogram | latency regressions per tool |
| `agent.run` / `tool.*` / llm spans | traces | the full decision chain |

The AI SDK's `experimental_telemetry` emits the LLM/step spans (model, tokens)
natively — we don't hand-instrument those anymore.

## Run it

```bash
# 1. bring up SigNoz (UI on :8080)
git clone https://github.com/SigNoz/signoz && cd signoz/deploy/docker
docker compose up -d

# 2. run the agent (loads OTel first via --import)
cd /path/to/agent-drift-watch
npm install
AI_PROVIDER=anthropic MODEL=claude-opus-4-6 ANTHROPIC_API_KEY=sk-... npm run dev

# 3. drive traffic, then look in SigNoz -> Traces
curl -XPOST localhost:3000/run -H 'content-type: application/json' \
  -d '{"prompt":"weather in Lagos, then search docs for onboarding"}'

# 4. drift report
curl localhost:3000/drift
```

## Judging-criteria hooks

- **Best Use of SigNoz** — traces + custom metrics + query_range API; extend
  with a saved dashboard and a high-severity drift alert rule.
- **SigNoz MCP** (bonus) — point a coding agent at SigNoz's MCP so it debugs
  against the same trace data. Distinct feature the sponsor highlights.
- **Best Blogs side-track** — the writeup of this build qualifies.

## Files

- `src/telemetry/otel.ts` — OTel SDK bootstrap. **Must** load before app code.
- `src/telemetry/instrument.ts` — `withToolSpan` (labelled tool metrics).
- `src/agent/model.ts` — provider-agnostic model resolver.
- `src/agent/tools.ts` — AI SDK `tool()` defs with Zod schemas.
- `src/agent/runner.ts` — `generateText` agent loop.
- `src/drift/detector.ts` — AI-over-traces drift layer (`generateObject`).
- `src/routes/agent.ts` + `src/server.ts` — Fastify surface.
