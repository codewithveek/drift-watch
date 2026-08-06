# DriftWatch

**A self-observing AI agent SDK.** Every tool call and model step an agent
makes is traced as OpenTelemetry into any OTel-compatible backend. A model
watches that telemetry for **behavioral drift** — shifts in tool-call mix,
error rate, latency, or token spend — and a policy-driven **autopilot** turns
drift into action (notify, pause, rollback, throttle), with a human in the
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

## Add it to your agent

`@driftwatch/sdk` is the product — a library you drop into an existing
[AI SDK](https://ai-sdk.dev) agent. It bundles no provider SDKs and reads no
environment variables on its own; every function takes typed config and
clients as parameters.

```bash
npm install @driftwatch/sdk ai zod
npm install @ai-sdk/openai   # or any AI SDK provider you already use
```

The example below is runnable. The tool calls a public API that needs no key;
only the model needs a key (`OPENAI_API_KEY` here). Telemetry must start in its
own file, loaded before your code with `--import` — OpenTelemetry instruments
modules by patching them as they load, so it has to run first or it misses them.

```ts
// telemetry.ts — preload; must run before anything else imports
import 'dotenv/config'; // load .env into process.env before anything reads it
import { bootstrapTelemetry, loadDriftWatchConfigFromEnv } from '@driftwatch/sdk';

bootstrapTelemetry(loadDriftWatchConfigFromEnv().telemetry);
```

```ts
// agent.ts — your application code
import { runAgentTask } from '@driftwatch/sdk';
import { openai } from '@ai-sdk/openai';
import { tool } from 'ai';
import { z } from 'zod';

// A tool the agent can call. This one hits GitHub's public API — no key needed.
const getRepo = tool({
  description: 'Get public information about a GitHub repository',
  inputSchema: z.object({ owner: z.string(), repo: z.string() }),
  execute: async ({ owner, repo }) => {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: { 'user-agent': 'driftwatch-demo' },
    });
    const data = await res.json();
    return { stars: data.stargazers_count, language: data.language };
  },
});

const result = await runAgentTask({
  prompt: 'How many stars does vercel/next.js have, and what language is it in?',
  modelClient: openai('gpt-4o-mini'), // any AI SDK provider; needs its API key
  tools: { get_repo: getRepo },
});

console.log(result.responseText);
// → "vercel/next.js has 129,304 stars and is written in JavaScript."
console.log(result.skillsUsed, result.tokenUsage);
// → [ 'get_repo' ] { inputTokens: 812, outputTokens: 94, totalTokens: 906 }
```

`dotenv/config` in `telemetry.ts` loads a `.env` file for you, so put your key
there instead of on the command line — the run command below then works the
same on macOS, Linux, and Windows:

```bash
# .env
OPENAI_API_KEY=sk-...
```

```bash
npx tsx --import ./telemetry.ts ./agent.ts
```

With no `OTEL_EXPORTER_OTLP_ENDPOINT` set, telemetry defaults to
`http://localhost:4318` and simply logs a connection failure if nothing is
listening there — the agent still runs. Point it at an OTel Collector to see
the trace. Add `detectBehavioralDrift` for drift verdicts, and `ApprovalService` /
`AutopilotScheduler` for the full notify/approve/act loop. See the
[SDK guide](https://drift-watch-docs.vercel.app/docs/sdk).

## See it work in 2 minutes

The repo also contains a ready-to-run reference server and console — the fastest
way to see the SDK's output without writing any code:

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

# get a drift report (fixtures work with DRIFT_DRY_RUN=1, no Prometheus needed)
curl localhost:3000/drift -H "authorization: Bearer $AUTH_TOKEN"
```

Full walkthrough: [Quickstart](https://drift-watch-docs.vercel.app/docs/quickstart).

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

## What it emits

Everything an agent does becomes queryable telemetry:

| Signal | Type | Answers |
|---|---|---|
| `agent.run` span | trace | one per task — id, skills used, exact token spend |
| `gen_ai.step` / `tool.*` spans | traces | the full decision chain |
| `agent.tool.calls{tool,outcome}` | counter | how often each tool is called, ok vs error |
| `agent.tool.duration{tool}` | histogram | latency regressions per tool |
| `agent.tokens{model,provider,function_id,type}` | counter | token spend by provider/model/task-type |

The drift detector reads these back out of a Prometheus-compatible backend to
compute drift; the same signals make clean dashboard panels. See the
[Prometheus guide](https://drift-watch-docs.vercel.app/docs/prometheus).

## The packages

| Package | What it is |
|---|---|
| **[`@driftwatch/sdk`](./packages/sdk)** | **The product.** Telemetry, drift detection, guardrails, and the full Autopilot orchestration engine (`ApprovalService`, `AutopilotScheduler`, `MemoryStateStore`, and `RedisStateStore` at the isolated `@driftwatch/sdk/redis` subpath). Zero provider SDKs, zero required dependencies. |
| **[`@driftwatch/autopilot`](./packages/autopilot)** | Concrete Slack, Telegram, and webhook notifiers, plus inbound-webhook verification. A companion to the SDK — bring it in only if you use those channels. |
| **[`@driftwatch/server`](./packages/server)** | A reference Fastify service built on `@driftwatch/sdk` and `@driftwatch/autopilot`: `/run` and `/drift`, the control-plane API, and shared state. The fastest way to try DriftWatch, or a blueprint for building your own. |
| **[`@driftwatch/console`](./packages/console)** | The operator web console for the reference server. Served at `/console/`. |

## Bring your own model and tools

The SDK owns the observability and control machinery. You bring:

- **A model client** — any [AI SDK](https://ai-sdk.dev) provider (OpenAI,
  Anthropic, Google, Bedrock, Mistral, or any OpenAI-compatible endpoint like
  Ollama/vLLM/Together/Groq/DeepSeek). No provider is bundled or picked for you.
- **Tools** — your own skills (DB lookups, HTTP calls, vector search), wrapped so
  every call is traced and counted.

## Documentation

Full documentation: **[drift-watch-docs.vercel.app](https://drift-watch-docs.vercel.app)**.
The site is a [Fumadocs](https://fumadocs.dev) app in
[`packages/docs`](./packages/docs) (`pnpm --filter @driftwatch/docs dev` to run
it locally).

| | |
|---|---|
| [Quickstart](https://drift-watch-docs.vercel.app/docs/quickstart) | Run the reference server with Docker, first drift report |
| [How it works](https://drift-watch-docs.vercel.app/docs/architecture) | The perceive → reason → act loop |
| [SDK](https://drift-watch-docs.vercel.app/docs/sdk) · [Server](https://drift-watch-docs.vercel.app/docs/server) · [Console](https://drift-watch-docs.vercel.app/docs/console) | Per-package guides |
| [Prometheus & OpenTelemetry](https://drift-watch-docs.vercel.app/docs/prometheus) | Connect a backend, read the data |
| [Alerts & Actions](https://drift-watch-docs.vercel.app/docs/alerts-and-actions) | Policies, channels, approvals |
| [Configuration](https://drift-watch-docs.vercel.app/docs/configuration) · [Deployment](https://drift-watch-docs.vercel.app/docs/deployment) · [Security](https://drift-watch-docs.vercel.app/docs/security) | Env vars, production, hardening |

## License

MIT — see [LICENSE](./LICENSE).
