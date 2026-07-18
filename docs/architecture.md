# Architecture

## Request flow

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

## The Autopilot loop (Loop 2)

Drift detection is the *perceive* step. Autopilot closes the loop —
**perceive → reason → act** — with a human in the loop for anything
destructive. There are two independent control loops:

- **Loop 1 — inline guardrails** (SDK, synchronous). Per-`/run` token/cost
  caps enforced *inside* the `generateText` loop via a `stopWhen` condition
  that sums cumulative usage across steps, alongside `stepCountIs(maxSteps)`.
  A runaway request aborts *before* it can pollute the drift windows. See
  [configuration.md](./configuration.md#inline-guardrails--agent-sdk-per-request).
- **Loop 2 — drift-triggered remediation** (server, asynchronous, aggregate).

```
scheduler tick (every SCAN_INTERVAL_MS)
  └─ acquire leader lock (SET NX PX)  ← only one process runs the cycle
      └─ detectBehavioralDrift()  →  DriftReport
          └─ evaluatePolicies(report, policy)  →  ActionIntent[]   (pure, SDK)
              ├─ notify_*   → dispatched immediately (Slack/Telegram/webhook)
              └─ control_*  → ApprovalService.requestApproval()
                                 └─ posts Approve/Reject to every channel
                                     └─ resolve(id, decision)  ← console | Slack | Telegram
                                         └─ executeControlAction()  → mutate shared state
```

**Pure vs. I/O split is preserved.** The SDK owns `evaluatePolicies` (a pure
function mapping a `DriftReport` to `ActionIntent[]`) and the
`StateStore`/`Notifier`/`ApprovalGateway` *interfaces*. The server implements
them: Redis/memory store, Slack/Telegram/webhook notifiers, the scheduler,
and the webhook routes.

**Channel-agnostic approvals.** A control action (pause, rollback, throttle,
switch_model) creates an `Approval` in the shared store and posts a prompt to
every configured channel. Resolution is idempotent and atomic (Redis Lua CAS,
or a guarded write in the memory store), so whichever channel acts first wins
and the rest are no-ops — the console, a Slack button, and a Telegram button
all resolve the *same* approval. A pending approval that isn't answered within
`AUTOPILOT_APPROVAL_TIMEOUT_MS` resolves to `AUTOPILOT_APPROVAL_TIMEOUT_DECISION`
(default: reject).

**Multi-process safety.** With `REDIS_URL` set, N server processes share one
store and coordinate via a `SET NX PX` leader lock keyed to the scan interval,
so exactly one process runs each drift cycle while all of them can serve the
console API and resolve approvals. Without Redis, an in-memory store is the
zero-dependency single-process fallback for dev/demo.

**Shadow mode.** `AUTOPILOT_MODE=shadow` runs the full loop but executes
nothing — intended actions are logged to the audit log as `shadowed`. This is
the safe default and the CI/demo path (`AUTOPILOT_ENABLED=1 AUTOPILOT_MODE=shadow
DRIFT_DRY_RUN=1` drives the entire loop off fixtures with no external side
effects).

### Control plane + console

A bearer-gated API (`src/routes/console.ts`, reusing the same
`isRequestAuthorized` gate as `/run`) exposes the shared state: `GET /state`,
`GET /drift/history`, `GET /approvals`, `POST /approvals/:id/resolve`,
`GET /actions/log`, `POST /control/{pause,resume,rollback}`, and
`POST /drift/scan` (manual trigger). The React console
([`packages/console`](../packages/console)) is a Vite SPA that polls this API
with the bearer token — Pending Approvals queue, drift verdict feed,
action/audit log, and an agent-health strip. It's served in production from
the server at `/console/` via `@fastify/static`.

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
  `loadDriftWatchConfigFromEnv()` is a convenience default, not a
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
