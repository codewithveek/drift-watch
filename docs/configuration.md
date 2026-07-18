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

## Model client

Not part of either schema above — deliberately not env-var driven for
*which provider*, only for *which model string*. There is exactly one file
to touch: [`packages/server/src/config/model-client.ts`](../packages/server/src/config/model-client.ts).

**Zero-install default** (Vercel AI Gateway, bundled inside `ai`):

```ts
import { gateway } from 'ai';
export const modelClient = gateway(process.env.MODEL ?? 'anthropic/claude-3-5-sonnet');
```
```bash
AI_GATEWAY_API_KEY=... pnpm dev
```

**Any other provider** — install exactly that one package, swap two lines:

```ts
// pnpm --filter @driftwatch/server add @ai-sdk/anthropic
import { anthropic } from '@ai-sdk/anthropic';
export const modelClient = anthropic(process.env.MODEL ?? 'claude-3-5-sonnet-latest');
```

Same pattern for `@ai-sdk/openai` / `@ai-sdk/google`. For any
OpenAI-compatible endpoint (Ollama, vLLM, Together, Groq, DeepSeek, ...):

```ts
// pnpm --filter @driftwatch/server add @ai-sdk/openai
import { createOpenAI } from '@ai-sdk/openai';
const openaiCompatibleClient = createOpenAI({
  baseURL: process.env.OPENAI_BASE_URL, // e.g. http://localhost:11434/v1
  apiKey: process.env.OPENAI_API_KEY ?? 'not-used',
});
export const modelClient = openaiCompatibleClient(process.env.MODEL ?? 'llama3.1');
```

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
