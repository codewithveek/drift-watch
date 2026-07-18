# Architecture

## Request flow

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

## What gets traced

Every `/run` call opens one root span, `agent.run`
([`packages/sdk/src/agent/runner.ts`](../packages/sdk/src/agent/runner.ts)),
carrying:

- `agent.task_id` — a UUID generated per call, so you can pull a task's full
  trace by id.
- `agent.prompt` — the first 512 bytes of the prompt (only when
  `capturePayloads` is enabled — see [security.md](./security.md)).
- `agent.steps`, `agent.skills_used` — how many `generateText` steps ran and
  which tools got called.
- `gen_ai.provider`, `gen_ai.request.model`, `gen_ai.usage.*` — provider,
  model, and token counts, read straight off the injected `ModelClient`
  rather than tracked separately.

Inside that span, the AI SDK's own `experimental_telemetry` integration
(registered by `bootstrapTelemetry` via
[`telemetry/ai-sdk-otel.ts`](../packages/sdk/src/telemetry/ai-sdk-otel.ts))
emits a `gen_ai.step` span per LLM call, and each tool call gets wrapped by
[`withSkillExecutionSpan`](../packages/sdk/src/telemetry/instrument.ts) into
a `tool.<name>` span plus two metrics:

| Signal | Type | Answers |
|---|---|---|
| `agent.tool.calls{tool,outcome}` | counter | how often each skill gets called, split ok/error |
| `agent.tool.duration{tool}` | histogram | latency regressions per skill |
| `agent.tokens{model,provider,function_id,type}` | counter | token spend by provider/model/task-type (`agent-run` vs `drift-judge`) |
| `agent.run` span attrs | trace | per-task id, skills used, exact token spend |
| `gen_ai.step` / `tool.*` spans | traces | full decision chain |

Metric labels stay low-cardinality on purpose (tool name, outcome,
provider, model, function id) — no per-request or per-task id on a counter,
which would blow up cardinality. Per-task detail lives on span attributes
instead, searchable by `agent.task_id`.

## How drift detection works

[`detectBehavioralDrift`](../packages/sdk/src/drift/detector.ts) is the
"AI analysis over traces" layer, in three steps:

1. **Query two windows.** Baseline = 2h–1h ago, current = 1h ago–now (fixed
   in `queryLiveWindows`). Three SigNoz v4 `query_range` builder queries run
   per window: tool-call counts by tool+outcome, p95 tool latency, and total
   token spend (summing the `agent.tokens` counter).
2. **Compute deltas.** `parseWindowStats` reduces the raw SigNoz response
   into a `WindowStats` — total calls, error rate, p95 latency, token spend,
   and tool mix as fractions.
3. **Judge with an LLM.** `judgeDriftVerdict` calls `generateObject` against
   whichever `ModelClient` you injected, with a schema-typed
   `DriftVerdictSchema` (`drift: boolean`, `severity`, `reasons`,
   `recommended_action`) — no fragile JSON parsing of a free-text response.

**Dry-run mode** (`isDryRun: true`, or `DRIFT_DRY_RUN=1` on the server)
skips the SigNoz query entirely and uses `loadFixtureWindows()` — a
baseline and a "current" window with a 2.5x multiplier on error rate,
latency, and token spend, and an inverted tool mix. Useful for demos, CI,
or trying `/drift` before you've generated any real traffic.

## Bring-your-own-everything, by design

Three things the SDK deliberately does not own, and why:

- **Model client.** `runAgentTask` and `detectBehavioralDrift` both take a
  `ModelClient` (a plain AI SDK `LanguageModel`) as a parameter. The SDK
  never imports a provider package and never picks one based on an env var
  — see [`packages/sdk/src/model-client.ts`](../packages/sdk/src/model-client.ts).
  This keeps the SDK's dependency footprint at zero provider SDKs.
- **Tools.** `runAgentTask` takes `tools: ToolSet` as a parameter. The
  reference server's `get_weather`/`search_docs` in
  [`tools.ts`](../packages/server/src/tools.ts) exist to demonstrate the
  `tool()` + `withSkillExecutionSpan` pattern, not to be used in production.
- **Config.** Every setting is a typed, Zod-validated object passed into
  the function that needs it — see [configuration.md](./configuration.md).
  `loadAgentPulseConfigFromEnv()` is a convenience default, not a
  requirement.

## What this can and can't run on

- **Anything the Vercel AI SDK supports** — first class. OpenAI, Anthropic,
  Google, AWS Bedrock, Cohere, Mistral, every OpenAI-compatible endpoint
  (Ollama, vLLM, Together, Groq, DeepSeek, Fireworks), plus everything
  reachable via AI Gateway.
- **Raw Anthropic/OpenAI SDKs, LangChain, LlamaIndex, CrewAI, Mastra** —
  not supported without a rewrite. Skill definitions and telemetry both use
  AI SDK conventions (`tool()`, `generateText`).
- The drift judge calls `generateObject` (structured output); your model
  needs tool-calling or JSON-mode support. Very small local models may fail
  here.
