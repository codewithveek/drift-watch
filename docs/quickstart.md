# Quickstart

Gets you from a clone to a drift report. Five steps.

## 1. Bring up SigNoz

DriftWatch's traces and metrics go to any OTLP/HTTP collector; the drift
detector queries a SigNoz-shaped query API specifically. Self-hosted SigNoz
is the fastest way to get both:

```bash
git clone https://github.com/SigNoz/signoz && cd signoz/deploy/docker
docker compose up -d   # UI on :8080
```

You don't strictly need this to try the server — see step 4's dry-run mode
— but you won't see real traces without it.

## 2. Install dependencies

```bash
git clone https://github.com/codewithveek/drift-watch.git driftwatch
cd driftwatch
pnpm install
```

Requires Node ≥22 and pnpm ≥9.

## 3. Configure a model client and run the server

```bash
cp packages/server/.env.example packages/server/.env
```

Edit `packages/server/.env` and fill in `QWEN_API_KEY` — this deployment
targets **Qwen Cloud**'s OpenAI-compatible endpoint via `@ai-sdk/openai`
(already a dependency). `QWEN_BASE_URL` and `MODEL` (default `qwen-max`)
have sensible defaults.

```bash
pnpm dev
```

Want a different provider instead (Anthropic, OpenAI, Google, or any
OpenAI-compatible endpoint like Ollama/vLLM/Together/Groq)? Edit the one
file: `packages/server/src/config/model-client.ts`. See
[configuration.md](./configuration.md#model-client) for the exact swap.

The server refuses to start with no `modelClient` configured — there's no
silent fallback.

## 4. Drive traffic

```bash
curl -XPOST localhost:3000/run -H 'content-type: application/json' \
  -d '{"prompt":"weather in Lagos, then search docs for onboarding"}'
```

Or seed a batch of 40 mixed requests (the seed script deliberately shifts
tool-call mix partway through, so the drift detector has something real to
catch):

```bash
BASE_URL=http://localhost:3000 pnpm seed 40
```

Each `/run` response includes token usage, step count, and which skills
(tools) were called — no trip to a tracing backend required:

```jsonc
{
  "output": "It's 24°C in Lagos. Found 3 onboarding docs.",
  "usage": {
    "taskId": "b3f1...e2",
    "stepCount": 3,
    "skillsUsed": ["get_weather", "search_docs"],
    "tokenUsage": { "inputTokens": 812, "outputTokens": 96, "totalTokens": 908 },
    "providerName": "anthropic",
    "modelIdentifier": "claude-3-5-sonnet-latest"
  }
}
```

## 5. Get a drift report

```bash
# against real SigNoz data (needs step 4's traffic + a live SigNoz):
curl localhost:3000/drift

# without SigNoz, using built-in fixtures — great for demos + CI:
pnpm drift:dry-run
```

The dry-run fixtures simulate a baseline window and a "current" window
where tool-call mix, error rate, latency, and token spend have all shifted
— enough for the LLM judge to flag drift without any infrastructure.

## Local-only by default

If you skip setting `AUTH_TOKEN` in `.env`, the server works fine on
localhost but refuses requests from outside your private network — see
[security.md](./security.md) before exposing this anywhere real.

## Try the autopilot loop

Run the full perceive→reason→act loop safely against fixtures — it evaluates
policies and logs the actions it *would* take, without executing any or
sending any messages:

```bash
AUTOPILOT_ENABLED=1 AUTOPILOT_MODE=shadow DRIFT_DRY_RUN=1 pnpm dev
```

Then open the operator console (approvals queue, drift feed, action log):

```bash
pnpm --filter @driftwatch/console dev   # dev server with API proxy + hot reload
# or in production it's served from the server at http://localhost:3000/console/
```

Paste your `AUTH_TOKEN` into the console's token field. See
[architecture.md](./architecture.md#the-autopilot-loop-loop-2) for how the loop
works and [configuration.md](./configuration.md#autopilot--serverconfig-loop-2)
for enabling Slack/Telegram approvals and Redis-backed multi-process state.

## What's next

- [configuration.md](./configuration.md) — every setting, env var by env var.
- [architecture.md](./architecture.md) — what's actually being traced and why.
- [deployment.md](./deployment.md) — Docker + docker-compose with SigNoz.
