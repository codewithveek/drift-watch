# DriftWatch

**A self-observing AI agent platform.** Every tool call and model step an agent
makes is traced as OpenTelemetry into a backend like [SigNoz](https://signoz.io).
A model watches that telemetry for **behavioral drift** — shifts in tool-call
mix, error rate, latency, or token spend — and a policy-driven **autopilot**
turns drift into action (notify, pause, rollback, throttle), with a human in the
loop for anything destructive.

> **In one line:** instrument an agent's decisions as telemetry, run a model over
> that telemetry to notice when it starts behaving differently, and act on it —
> safely.

## Why it matters

Agents fail quietly. A model update, a prompt tweak, or a shifting workload can
change *how* an agent behaves — which tools it reaches for, how much it spends,
how often it errors — long before anything throws an exception. Traditional
monitoring sees the crash; it doesn't see the agent that started calling the
wrong tool 75% of the time, or quietly tripled its token bill.

DriftWatch makes agent behavior **visible**, tells you when it changes enough to
**matter**, and can **step in** before a quiet regression becomes an incident.

## What you get

- **Full decision traces.** Look up any task by id and see every model step and
  tool call it made, with latency, outcome, and exact token spend.
- **Behavioral drift detection.** An LLM-over-traces judge compares two time
  windows and returns a schema-typed verdict: did it drift, how severe, why, and
  what to do.
- **Guardrails.** A hard per-request token/cost cap that aborts a runaway call
  mid-loop.
- **Autopilot.** Drift → policy → action, with approvals you can resolve from
  Slack, Telegram, or the console.
- **An operator console.** Live agent health, the drift feed, the approvals
  queue, and a full audit log — served by the server, nothing extra to deploy.

## Run it

```bash
git clone https://github.com/codewithveek/drift-watch.git && cd drift-watch
cp packages/server/.env.example packages/server/.env    # set QWEN_API_KEY + AUTH_TOKEN
docker build -f packages/server/Dockerfile -t driftwatch .
docker run --rm -p 3000:3000 --env-file packages/server/.env driftwatch
```

```bash
# send the agent a task
curl -XPOST localhost:3000/run \
  -H "authorization: Bearer $AUTH_TOKEN" -H 'content-type: application/json' \
  -d '{"prompt":"weather in Lagos, then search docs for onboarding"}'

# get a drift report (fixtures work with DRIFT_DRY_RUN=1, no SigNoz needed)
curl localhost:3000/drift -H "authorization: Bearer $AUTH_TOKEN"
```

Full walkthrough: **[docs/quickstart.md](./docs/quickstart.md)**.

## What it emits

Everything an agent does becomes queryable telemetry:

| Signal | Type | Answers |
|---|---|---|
| `agent.run` span | trace | one per task — id, skills used, exact token spend |
| `gen_ai.step` / `tool.*` spans | traces | the full decision chain |
| `agent.tool.calls{tool,outcome}` | counter | how often each tool is called, ok vs error |
| `agent.tool.duration{tool}` | histogram | latency regressions per tool |
| `agent.tokens{model,provider,function_id,type}` | counter | token spend by provider/model/task-type |

The drift detector reads these back out of SigNoz to compute drift; the same
signals make clean dashboard panels. See
**[docs/signoz.md](./docs/signoz.md)**.

## Bring your own model and tools

DriftWatch owns the observability and control machinery. You bring:

- **A model client** — any [AI SDK](https://ai-sdk.dev) provider (OpenAI,
  Anthropic, Google, Bedrock, Mistral, or any OpenAI-compatible endpoint like
  Ollama/vLLM/Together/Groq/DeepSeek). No provider is bundled or picked for you.
- **Tools** — your own skills (DB lookups, HTTP calls, vector search), wrapped so
  every call is traced and counted.

Both are single, well-marked extension points — see
[docs/server.md](./docs/server.md).

## The three packages

| Package | What it is |
|---|---|
| **[`@driftwatch/sdk`](./packages/sdk)** | The reusable library — telemetry, drift detection, guardrails, and the pure policy engine. Bundles no provider SDKs; every function takes typed config and clients as parameters. [Use it standalone](./docs/sdk.md) in your own agent. |
| **[`@driftwatch/server`](./packages/server)** | The reference Fastify service built on the SDK: `/run` and `/drift`, the autopilot loop, the control-plane API, notifiers, and shared state. [Deploy this](./docs/deployment.md) to run DriftWatch. |
| **[`@driftwatch/console`](./packages/console)** | The operator web console. Served by the server at `/console/`. |

## Documentation

| | |
|---|---|
| [Quickstart](./docs/quickstart.md) | Run with Docker, first drift report |
| [How it works](./docs/architecture.md) | The perceive → reason → act loop |
| [SDK](./docs/sdk.md) · [Server](./docs/server.md) · [Console](./docs/console.md) | Per-package guides |
| [SigNoz & OpenTelemetry](./docs/signoz.md) | Connect a backend, read the data |
| [Alerts & Actions](./docs/alerts-and-actions.md) | Policies, channels, approvals |
| [Configuration](./docs/configuration.md) · [Deployment](./docs/deployment.md) · [Security](./docs/security.md) | Env vars, production, hardening |

## License

MIT — see [LICENSE](./LICENSE).
