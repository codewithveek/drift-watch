# The Server — `@driftwatch/server`

The server is a ready-to-run HTTP service built on the [SDK](./sdk.md). It gives
you an agent endpoint, a drift endpoint, the autopilot loop, the control-plane
API, and the operator console — all wired together. It's the fastest way to put
a self-observing agent behind an API, and the reference for how the SDK pieces
fit.

Run it with Docker ([quickstart](./quickstart.md)); this page is about what it
exposes and the two things you customize: the **model client** and your
**tools**.

## HTTP surface

### Agent & drift (bearer-gated)

| Endpoint | Purpose |
|---|---|
| `POST /run` | Execute an agent task. Body `{ "prompt": "…" }`. Returns the output plus a `usage` summary (task id, steps, skills used, token spend, provider, model). |
| `GET /drift` | Run drift detection now and return the two window stats + the model's verdict. Uses SigNoz, or fixtures when `DRIFT_DRY_RUN=1`. |

Both require `Authorization: Bearer <AUTH_TOKEN>` (or, if `AUTH_TOKEN` is unset,
a caller on your private network — see [security.md](./security.md#authentication)).

```bash
curl -XPOST localhost:3000/run \
  -H "authorization: Bearer $AUTH_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"prompt":"weather in Lagos"}'
```

### Control plane (bearer-gated)

Backs the console; also usable directly. Same bearer gate as `/run`.

| Endpoint | Purpose |
|---|---|
| `GET /state` | Agent status, autopilot mode, guardrail settings |
| `GET /drift/history` | Recent drift verdicts |
| `GET /approvals` | Pending approvals |
| `POST /approvals/:id/resolve` | Approve/reject an approval |
| `GET /actions/log` | Audit log of every action taken or shadowed |
| `POST /control/{pause,resume,rollback}` | Manual control actions |
| `POST /drift/scan` | Trigger a drift cycle on demand |

### Integrations (provider-signed)

| Endpoint | Purpose |
|---|---|
| `POST /integrations/slack/actions` | Slack Approve/Reject button callbacks |
| `POST /integrations/telegram/webhook` | Telegram button callbacks |

These are called by Slack/Telegram, not your operators, so they verify their own
provider signatures instead of the bearer token. See
[alerts-and-actions.md](./alerts-and-actions.md#channels).

### Health

| Endpoint | Purpose |
|---|---|
| `GET /health` | Unauthenticated liveness — `{"ok":true}`. For load balancers and orchestrators. |

## The model client

DriftWatch does not pick a provider for you. There is exactly **one file** that
chooses the model: `packages/server/src/config/model-client.ts`. The server uses
whatever it exports for both the agent and the drift judge.

The default targets **Qwen Cloud** (an OpenAI-compatible endpoint), with
credentials from the environment:

```ts
import { createOpenAI } from '@ai-sdk/openai';
const qwenCloud = createOpenAI({
  baseURL: process.env.QWEN_BASE_URL ?? 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  apiKey: process.env.QWEN_API_KEY ?? '',
});
export const modelClient = qwenCloud(process.env.MODEL ?? 'qwen3.7-max');
```

| Env var | Default | Notes |
|---|---|---|
| `QWEN_API_KEY` | — | Required for real model calls |
| `QWEN_BASE_URL` | Qwen intl endpoint | Any OpenAI-compatible base URL |
| `MODEL` | `qwen3.7-max` | Model id |

**To use a different provider**, install that one package and change two lines:

```ts
// pnpm --filter @driftwatch/server add @ai-sdk/anthropic
import { anthropic } from '@ai-sdk/anthropic';
export const modelClient = anthropic(process.env.MODEL ?? 'claude-sonnet-4-5');
```

The same pattern works for `@ai-sdk/google`, or point `createOpenAI`'s `baseURL`
at any OpenAI-compatible endpoint (Ollama, vLLM, Together, Groq, DeepSeek, …).

> **What works:** anything the [Vercel AI SDK](https://ai-sdk.dev) supports —
> OpenAI, Anthropic, Google, Bedrock, Mistral, Cohere, and every
> OpenAI-compatible endpoint. **What doesn't:** raw provider SDKs, LangChain,
> LlamaIndex, CrewAI — the tool and telemetry conventions are AI SDK–native.
> The drift judge needs a model capable of tool-calling / JSON output; very
> small local models may struggle.

The server refuses to start without a configured `modelClient` — there is no
silent fallback. If you switch providers before a Docker build, add the package
to the lockfile first so `--frozen-lockfile` succeeds.

## Your tools (skills)

`runAgentTask` takes tools as a parameter; the server supplies them in
`packages/server/src/tools.ts`. The two demo tools (`get_weather`,
`search_docs`) exist to show the pattern — replace them with your own:

```ts
import { tool } from 'ai';
import { z } from 'zod';
import { withSkillExecutionSpan } from '@driftwatch/sdk';

export const tools = {
  refund_order: tool({
    description: 'Issue a refund for an order',
    inputSchema: z.object({ orderId: z.string(), amount: z.number() }),
    execute: (input) =>
      withSkillExecutionSpan({
        skillName: 'refund_order',
        skillInput: input,
        executeSkill: async () => issueRefund(input),   // your logic
      }),
  }),
};
```

Wrapping `execute` in `withSkillExecutionSpan` is what makes each call show up as
a `tool.<name>` span and in the `agent.tool.*` metrics — which is what drift
detection watches. A tool that skips the wrapper still runs, but is invisible to
observability and drift.

## Configuration

The server has its own settings (port, auth, body limits, rate limits) on top of
the SDK's config, plus the autopilot and channel settings. Every variable is in
[configuration.md](./configuration.md); the shipped
[`.env.example`](../packages/server/.env.example) lists them all with comments.

The essentials to set before exposing it:

- `AUTH_TOKEN` — required for any non-local deployment.
- `QWEN_API_KEY` (or your provider's key).
- `OTEL_EXPORTER_OTLP_ENDPOINT` / `SIGNOZ_URL` + keys — to send/read telemetry
  ([signoz.md](./signoz.md)).
- `TRUST_PROXY=1` — if behind a reverse proxy or load balancer.

See the [production checklist](./deployment.md#production-checklist) before going
live.
