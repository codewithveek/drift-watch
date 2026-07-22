# Configuration reference

DriftWatch has two typed, Zod-validated config objects — one owned by the
SDK, one owned by the reference server — plus one file that isn't
env-driven at all (`model-client.ts`). Nothing else in the codebase reads
`process.env` directly; every function takes its config as a plain typed
parameter, so you can build one however your app already manages config
(env, a parsed `.env`, a literal object in tests, `convict`/`t3-env`/etc).

## SDK config — `DriftWatchConfig`

Schema: [`packages/sdk/src/config/schema.ts`](../packages/sdk/src/config/schema.ts).
Env loader: `loadDriftWatchConfigFromEnv()`.

```ts
import { DriftWatchConfigSchema, loadDriftWatchConfigFromEnv } from '@driftwatch/sdk';

const config = loadDriftWatchConfigFromEnv(); // convenience: reads process.env

// or build one however you want, validated against the same schema:
const config = DriftWatchConfigSchema.parse({
  telemetry: { serviceName: 'checkout-agent', environment: 'production' },
  agent: { maxSteps: 12 },
  driftDetection: { signozBaseUrl: 'https://signoz.internal' },
});
```

### `telemetry`

| Env var | Field | Default | Notes |
|---|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `otlpEndpoint` | `http://localhost:4318` | OTLP/HTTP collector base URL (traces at `/v1/traces`, metrics at `/v1/metrics`). |
| `OTEL_SERVICE_NAME` | `serviceName` | `driftwatch` | Reported as OTel `service.name` on every span/metric. |
| — (`npm_package_version`) | `serviceVersion` | `0.1.0` | Set automatically by npm/pnpm when run via a package script. |
| `NODE_ENV` | `environment` | `development` | Free-form deployment label (`deployment.environment` resource attribute). |
| `OTEL_CAPTURE_PAYLOADS` | `capturePayloads` | `true` (set env to exactly `0` to disable) | Whether raw prompt text and tool-call inputs get attached to spans. See [security.md](./security.md#telemetry-payload-capture). |

### `agent`

| Env var | Field | Default | Notes |
|---|---|---|---|
| `AGENT_MAX_STEPS` | `maxSteps` | `8` | Upper bound on the `generateText` tool-use loop's step count — also your hard cap on cost per `/run` call. |

### `driftDetection`

| Env var | Field | Default | Notes |
|---|---|---|---|
| `SIGNOZ_URL` | `signozBaseUrl` | `http://localhost:8080` | SigNoz **query-service** API base (not the OTLP collector port). |
| `SIGNOZ_API_KEY` | `signozApiKey` | `''` | Sent as the `SIGNOZ-API-KEY` header. Generate in SigNoz UI → Settings → API Keys. |

## Server config — `ServerConfig`

Schema: [`packages/server/src/config/server-config.ts`](../packages/server/src/config/server-config.ts).
Specific to the reference Fastify app, not the SDK — kept separate
deliberately.

| Env var | Field | Default | Notes |
|---|---|---|---|
| `PORT` | `port` | `3000` | |
| `HOST` | `host` | `0.0.0.0` | |
| `LOG_LEVEL` | `logLevel` | `info` | Fastify/pino log level. |
| `BODY_LIMIT` | `bodyLimitBytes` | `131072` (128 KiB) | Hard cap on request body size. |
| `TRUST_PROXY` | `trustProxy` | `false` (`'1'` → `true`) | Enable when the server sits behind a reverse proxy/load balancer — otherwise `request.ip` and the local-network auth fallback see the proxy's address, not the client's. |
| `AUTH_TOKEN` | `authToken` | `''` | Bearer token required on `/run` and `/drift`. Empty = local-only mode. See [security.md](./security.md#authentication). |
| `MAX_PROMPT_BYTES` | `maxPromptBytes` | `8192` | Per-request prompt size cap, independent of `BODY_LIMIT`. |
| `DRIFT_DRY_RUN` | `driftDryRun` | `false` (`'1'` → `true`) | `/drift` uses built-in fixtures instead of querying SigNoz. |
| `RATE_LIMIT_MAX` | `rateLimitMax` | `30` | Max requests per client per window on `/run` and `/drift`. |
| `RATE_LIMIT_WINDOW_MS` | `rateLimitWindowMs` | `60000` | Window size in ms for the above. |

Boolean env vars are parsed as `=== '1'`, not JS truthiness — `DRIFT_DRY_RUN=0`
is falsy, but so is `DRIFT_DRY_RUN=false` (any value other than the literal
string `'1'` is `false`). Same for `OTEL_CAPTURE_PAYLOADS`, but inverted:
only the literal string `'0'` disables it, anything else (including unset)
keeps the default `true`.

## Inline guardrails — `agent` (SDK, per-request)

Synchronous, per-`/run` caps enforced *inside* the `generateText` loop, so a
runaway request aborts before the async drift loop could ever see it. Fields
live on `DriftWatchConfig.agent`
([`packages/sdk/src/config/schema.ts`](../packages/sdk/src/config/schema.ts)).

| Env var | Field | Default | Notes |
|---|---|---|---|
| `AGENT_MAX_TOKENS_PER_TASK` | `maxTokensPerTask` | `0` (off) | Abort a single run once cumulative tokens (summed across steps) cross this cap. |
| `AGENT_MAX_COST_USD` | `maxCostUsd` | `0` (off) | Optional USD cap per run, derived from the per-1k prices below. |
| `AGENT_PRICE_PER_1K_INPUT` | `pricePer1kInput` | `0` | Price per 1k input tokens, used to derive cost. |
| `AGENT_PRICE_PER_1K_OUTPUT` | `pricePer1kOutput` | `0` | Price per 1k output tokens, used to derive cost. |
| `AGENT_ON_EXCEED` | `onExceed` | `stop` | `stop` halts the loop; `flag` finishes the run but marks `guardrailTriggered` on the result + root span. |

## Autopilot — `ServerConfig` (Loop 2)

The drift-triggered remediation loop and its channels. All server-owned.

| Env var | Field | Default | Notes |
|---|---|---|---|
| `REDIS_URL` | `redisUrl` | `''` | When set, shared state (approvals, agent state, history, leader lock) lives in Redis so multiple processes coordinate. Unset = in-memory single-process store. |
| `AUTOPILOT_ENABLED` | `autopilotEnabled` | `false` (`'1'` → `true`) | Master switch for the autonomous scheduler. |
| `AUTOPILOT_MODE` | `autopilotMode` | `shadow` | `shadow` logs intended actions only; `enforce` dispatches notifications and queues control actions for approval. |
| `AUTOPILOT_SCAN_INTERVAL_MS` | `scanIntervalMs` | `60000` | How often the scheduler runs a drift cycle (also the leader-lock TTL). |
| `AUTOPILOT_COOLDOWN_MS` | `cooldownMs` | `300000` | Dedup window so the same action doesn't re-fire in a storm. |
| `AUTOPILOT_APPROVAL_TIMEOUT_MS` | `approvalTimeoutMs` | `600000` | How long a pending control-action approval waits before the safe default applies. |
| `AUTOPILOT_APPROVAL_TIMEOUT_DECISION` | `approvalTimeoutDecision` | `rejected` | Safe default applied on approval timeout. |
| `AUTOPILOT_POLICIES` | `policiesJson` | `''` | Inline policy JSON (array of `{when, do}` rules). Takes precedence over the file. |
| `AUTOPILOT_POLICIES_FILE` | `policiesFile` | `''` | Path to a `policies.json` file. Falls back to a built-in default when both are empty. |

### Notification / approval channels

Approvals are **channel-agnostic** — the same pending approval can be resolved
from the console, a Slack button, or a Telegram button, because all three
mutate the one shared store. See [alerts-and-actions.md](./alerts-and-actions.md)
and [security.md](./security.md#integration-webhook-authentication).

| Env var | Field | Notes |
|---|---|---|
| `SLACK_WEBHOOK_URL` | `slackWebhookUrl` | Incoming-webhook URL for posting Block Kit messages with Approve/Reject buttons. |
| `SLACK_SIGNING_SECRET` | `slackSigningSecret` | Verifies `X-Slack-Signature` (HMAC + timestamp window) on `POST /integrations/slack/actions`. |
| `TELEGRAM_BOT_TOKEN` | `telegramBotToken` | Bot token used to send inline-keyboard messages and `answerCallbackQuery`. |
| `TELEGRAM_CHAT_ID` | `telegramChatId` | Chat the bot posts approval prompts to. |
| `TELEGRAM_SECRET_TOKEN` | `telegramSecretToken` | Verified against `X-Telegram-Bot-Api-Secret-Token` on `POST /integrations/telegram/webhook`. |
| `DRIFT_WEBHOOK_URL` | `webhookUrl` | Generic webhook that receives the raw drift verdict as JSON (notify-only, no buttons). |

### Policy format

A policy is an array of rules; each rule's `when` conditions are ANDed, and
matching rules contribute their `do` actions. Actions split into **notify**
(`notify_slack`/`notify_telegram`/`notify_webhook` — dispatched automatically)
and **control** (`pause_agent`/`resume_agent`/`rollback`/`throttle`/`switch_model`
— which require an approval). Evaluation is a pure function in
[`packages/sdk/src/autopilot/policy.ts`](../packages/sdk/src/autopilot/policy.ts).

```json
[
  { "when": { "severity": "high" }, "do": ["notify_slack", "notify_telegram", "pause_agent"] },
  { "when": { "severity": "medium" }, "do": ["notify_slack", "notify_webhook"] },
  { "when": { "tokenSpendDeltaPct": 100 }, "do": ["notify_webhook"] }
]
```



## Model client

Not part of either schema above — deliberately not env-var driven for
*which provider*, only for *which model string*. There is exactly one file
to touch: [`packages/server/src/config/model-client.ts`](../packages/server/src/config/model-client.ts).

**This deployment targets Qwen Cloud** (OpenAI-compatible endpoint) via
`@ai-sdk/openai`'s `createOpenAI` factory. Credentials come from `.env`,
never hardcoded:

```ts
import { createOpenAI } from '@ai-sdk/openai';
const qwenCloud = createOpenAI({
  baseURL: process.env.QWEN_BASE_URL ?? 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  apiKey: process.env.QWEN_API_KEY ?? '',
});
export const modelClient = qwenCloud(process.env.MODEL ?? 'qwen3.7-max');
```

Set `QWEN_API_KEY` (and optionally `MODEL`) in your `.env`. To use a different
provider, see [server.md → Model client](./server.md#the-model-client).

| Env var | Default | Notes |
|---|---|---|
| `QWEN_BASE_URL` | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | Qwen Cloud OpenAI-compatible base URL. |
| `QWEN_API_KEY` | `''` | Your Qwen Cloud API key. Required to make real model calls. |
| `MODEL` | `qwen3.7-max` | Model id — e.g. `qwen3.7-max` / `qwen-plus` / `qwen-turbo`. |

**Any other provider** — install exactly that one package, swap two lines:

```ts
// pnpm --filter @driftwatch/server add @ai-sdk/anthropic
import { anthropic } from '@ai-sdk/anthropic';
export const modelClient = anthropic(process.env.MODEL ?? 'claude-3-5-sonnet-latest');
```

Same pattern for `@ai-sdk/google` or any OpenAI-compatible endpoint
(Ollama, vLLM, Together, Groq, DeepSeek, ...) — just change `baseURL`.

The server calls `assertModelClientIsConfigured` at startup and refuses to
boot without a `modelClient` — there's no implicit fallback beyond what you
put in this file.

## Skills (tools)

Also not env-driven — `runAgentTask` takes `tools` as a plain parameter.
The reference server's demo skills live in
[`packages/server/src/tools.ts`](../packages/server/src/tools.ts)
(`get_weather`, `search_docs`); swap in your own DB lookups, HTTP calls,
vector search, following the same `tool()` + `withSkillExecutionSpan`
pattern so calls still show up in metrics.

## Full `.env.example`

See [`packages/server/.env.example`](../packages/server/.env.example) for
every variable above in one file, ready to copy to `packages/server/.env`.
