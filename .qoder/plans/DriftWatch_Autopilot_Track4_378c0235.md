# DriftWatch Autopilot — Track 4 (Enterprise Workflow Automation)

## Summary
Turn DriftWatch from a passive observability library into an **autonomous SRE agent for AI agents**: perceive (existing OTel/drift detection) → reason (Qwen drift judge) → act (policy-driven remediation) with human-in-the-loop approval. Two control loops: **inline guardrails** (synchronous, per-request token/cost caps) and **drift-triggered remediation** (async, aggregate). State is Redis-backed for multi-process; approvals are channel-agnostic (console + Slack + Telegram). Model provider is Qwen Cloud via the existing BYO-model seam.

## Architectural principles (preserved)
- **SDK stays pure:** no provider SDKs, no `process.env`, no external I/O. SDK owns guardrail enforcement, policy evaluation, and TypeScript interfaces for actions/approvals/state store.
- **Server owns I/O:** Redis, Slack/Telegram/webhook notifiers, scheduler, webhook routes, static console.
- Same typed-Zod-config pattern already used across the repo.

## 1. Qwen Cloud model client (`packages/server`)
- Add `@ai-sdk/openai` dependency to the server package.
- Rewrite `src/config/model-client.ts` to use `createOpenAI({ baseURL: QWEN_BASE_URL, apiKey: QWEN_API_KEY })` with `MODEL` default `qwen-max` (OpenAI-compatible endpoint). Secrets read from `.env` only — never hardcoded.
- Update `.env.example` with `QWEN_BASE_URL`, `QWEN_API_KEY`, `MODEL`.

## 2. Inline guardrails — Loop 1 (`packages/sdk`)
- Extend `AgentConfigSchema` (`config/schema.ts`): `maxTokensPerTask`, `maxCostPerTaskUsd` (optional), `onExceed` (`stop` | `flag`), plus optional `pricePer1kInput`/`pricePer1kOutput` for cost derivation. Wire into `loadDriftWatchConfigFromEnv`.
- In `agent/runner.ts`: add a token-budget `stopWhen` condition (sums cumulative usage across steps) alongside the existing `stepCountIs(maxSteps)`; annotate the root span + `AgentTaskResult` with `guardrailTriggered` + reason. This aborts a runaway request *before* the drift loop could ever see it.
- Unit test the stop condition (budget crossed → stops; under budget → completes).

## 3. Policy engine + action model — Loop 2 (`packages/sdk`, pure)
- New `src/autopilot/policy.ts`: `PolicyConfigSchema` (Zod) — array of `{ when: {severity?, tokenSpendDeltaPct?, errorRate?, p95DeltaPct?}, do: ActionType[] }`, plus dedup/cooldown window and `mode` (`enforce` | `shadow`).
- `evaluatePolicies(driftReport, policyConfig) => ActionIntent[]` — pure function mapping a `DriftReport` (from existing `detectBehavioralDrift`) to intended actions. Classifies actions as **notify** (auto) vs **control** (needs approval).
- New `src/autopilot/types.ts`: `ActionType`, `ActionIntent`, `Approval`, `AgentRuntimeState`, and `StateStore` / `Notifier` / `ApprovalGateway` interfaces (implemented in server).
- Unit tests: severity ladder, threshold conditions, notify-vs-control classification, cooldown suppression.

## 4. Shared state + multi-process (`packages/server`)
- Add `ioredis`. New `src/state/redis-store.ts` implementing SDK's `StateStore`: agent runtime state (`running`/`paused`/`throttled`), active prompt/model **version pointer** (for rollback), pending approvals, drift-verdict history (capped list), action/audit log, dedup keys, and a **leader lock** (`SET NX PX`) so only one process runs each drift cycle.
- `src/state/memory-store.ts`: in-memory fallback for single-process/dev (no Redis required to run).
- Store selected by presence of `REDIS_URL`.

## 5. Remediation actions + notifiers (`packages/server`)
- `src/notify/`: `slack.ts` (Block Kit message with Approve/Reject buttons), `telegram.ts` (inline-keyboard buttons), `webhook.ts` (POST verdict JSON). Fire-and-forget with timeout; failures logged, never block the loop.
- `src/autopilot/actions.ts`: execute control actions by mutating shared state — `pause_agent`, `resume_agent`, `rollback` (swap version pointer to last-known-good), `throttle` (tighten rate limit). Every action appended to the audit log.
- Control actions require an **Approval** unless policy marks them auto.

## 6. Channel-agnostic approvals (console + Slack + Telegram)
- `src/autopilot/approval-service.ts`: create/resolve approvals in the shared store; on `resolve(id, decision, actor)` (idempotent) it executes the pending control action via §5 and records the actor/channel. Timeout → configurable safe default (default: reject).
- Webhook routes with their **own** auth (not the bearer):
  - `POST /integrations/slack/actions` — verify `X-Slack-Signature` (HMAC + timestamp window), parse interaction payload, resolve approval.
  - `POST /integrations/telegram/webhook` — verify secret-token header, parse `callback_query`, resolve, then `answerCallbackQuery`.
- Because resolution mutates shared Redis state, any process (or the console) sees the result — no cross-process handoff needed.

## 7. Scheduler — the autonomous loop (`packages/server`)
- `src/autopilot/scheduler.ts`: on `AUTOPILOT_ENABLED`, every `SCAN_INTERVAL_MS` acquire the leader lock, run `detectBehavioralDrift`, `evaluatePolicies`, dispatch notify actions immediately, and create approvals for control actions. Respects `mode: shadow` (log intended actions, execute none).
- Started from `server.ts` after routes register; stopped in the existing ordered-shutdown hook.

## 8. Control-plane API (`packages/server`, bearer-gated)
New routes in a `src/routes/console.ts` (reusing the existing `isRequestAuthorized` gate):
- `GET /state` (agent health, active version, live token spend), `GET /drift/history`, `GET /approvals`, `POST /approvals/:id/resolve`, `GET /actions/log`, `POST /control/{pause,resume,rollback}`, `POST /drift/scan` (manual trigger).

## 9. React console (`packages/console`, new workspace package)
- Vite + React + Tailwind SPA. Views: **Pending Approvals queue** (Approve/Reject — the Track-4 demo centerpiece), **Drift verdict feed**, **Action/audit log**, **Agent health strip** (state + active model/version + token-vs-budget sparkline), deep-link to SigNoz for charts.
- Polls the API with the bearer token; served in prod via `@fastify/static` from the server (Vite dev proxy in development).

## 10. Config, env, wiring
- Extend `ServerConfigSchema`: `redisUrl`, `autopilotEnabled`, `scanIntervalMs`, `mode`, `approvalTimeoutMs`, `slackWebhookUrl`/`slackSigningSecret`, `telegramBotToken`/`telegramChatId`/`telegramSecretToken`, `webhookUrl`, and the policy definition (JSON env or `policies.json` file path).
- Update `.env.example`, `docker-compose.override.yml` (add Redis), and the server composition root (`server.ts`) to construct the store, notifiers, approval service, and scheduler.

## Test Plan
- **Unit (Vitest):** guardrail stop condition; policy evaluation (ladder, thresholds, cooldown); approval resolution idempotency + timeout; Slack/Telegram signature verification; memory-store behavior.
- **Route tests:** extend `routes/agent.test.ts` style for `/approvals`, `/control/*`, and integration webhooks (valid + forged signatures).
- **Shadow/dry-run demo path:** `AUTOPILOT_ENABLED=1 mode=shadow DRIFT_DRY_RUN=1` drives the full loop off fixtures — notify + approval creation without external side effects — for CI and the demo.
- `pnpm typecheck` + `pnpm test` green across all three packages.

## Docs
- Update root `README.md`, `docs/architecture.md`, `docs/configuration.md`, `docs/deployment.md`, `docs/security.md` to cover the Autopilot loop, Qwen wiring, guardrails, policies, approvals, and the console.

## Assumptions
- Qwen Cloud exposes an OpenAI-compatible endpoint; user supplies `QWEN_BASE_URL`/`QWEN_API_KEY` in `.env`.
- Redis available in prod/multi-process; in-memory store is the zero-dependency dev/demo fallback.
- Slack app (interactivity enabled) and Telegram bot are provisioned by the user; the build wires verification + handlers and documents the setup.
- Cost caps use a simple configured per-1k-token price (not a live pricing API).
