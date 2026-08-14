import { z } from 'zod';
import { AGENT_ID_PATTERN } from '@driftwatch/sdk';
/**
 * Typed config for the parts of this server that are specific to *this*
 * Fastify app rather than the SDK (HTTP port/host, auth, body limits). Mirrors
 * the pattern used by @driftwatch/sdk's own config/schema.ts: nothing reads
 * `process.env` except `loadServerConfigFromEnv`, and every function that
 * needs one of these values takes it as a typed parameter instead.
 */

export const ServerConfigSchema = z.object({
  port: z.coerce.number().int().positive().default(3000),
  host: z.string().default('0.0.0.0'),
  logLevel: z.string().default('info'),
  bodyLimitBytes: z.coerce.number().int().positive().default(128 * 1024),
  trustProxy: z.boolean().default(false),
  /**
   * DEPRECATED break-glass credential. Human operators now log in with a
   * username and password (see auth/auth.ts); this remains only so a deployment
   * that has not yet created its admin, or one whose key store was lost on
   * restart, is still reachable. Leave it unset once an admin exists.
   */
  authToken: z.string().default(''),

  // --- built-in auth --------------------------------------------------------
  /** Email/username of the admin created on first boot, when no such user exists. */
  adminUser: z.string().default(''),
  /** That admin's initial password. At least 12 characters; changed on first login. */
  adminPassword: z.string().default(''),
  /**
   * Signs session cookies. MUST be stable across restarts and identical across
   * replicas — changing it logs everyone out at once. Generated ephemerally
   * with a warning when unset outside production, so `pnpm dev` needs no setup.
   */
  authSecret: z.string().default(''),
  /**
   * Public origin this deployment is reached at, e.g. https://dw.acme.com. Used
   * as better-auth's baseURL and trusted origin, and to decide whether session
   * cookies get the Secure attribute. Must be the address in the user's address
   * bar, not the container's internal one, or the cookie is set for the wrong
   * host and login silently fails.
   */
  baseUrl: z.string().default(''),
  maxPromptBytes: z.coerce.number().int().positive().default(8192),
  /** Use built-in drift fixtures instead of querying the metrics backend. */
  driftDryRun: z.boolean().default(false),
  /** Max requests per client (by IP, or by bearer token when set) per rateLimitWindowMs on /run and /drift. */
  rateLimitMax: z.coerce.number().int().positive().default(100),
  rateLimitWindowMs: z.coerce.number().int().positive().default(60_000),

  // --- Fleet identity (this server's own auto-registered default agent) ---
  /**
   * Registry id for the one agent this server auto-registers at boot if the
   * registry is empty — what keeps existing single-agent deployments working
   * with zero new required config. Must match AGENT_ID_PATTERN
   * (`^[a-zA-Z0-9_-]+$`) since it's composed into Redis/cooldown keys.
   */
  agentId: z.string().regex(AGENT_ID_PATTERN).default('default'),
  /** Empty = derive from OTEL_SERVICE_NAME (driftWatchConfig.telemetry.serviceName) at use-site. */
  agentName: z.string().default(''),

  // --- state store ----------------------------------------------------------
  /**
   * Postgres connection URL. This is the durable, production backend: it is the
   * only one that survives a restart with API keys, audit events and drift
   * history intact, and it implements every StateStore method including the
   * leader lock — so setting this makes Redis unnecessary rather than
   * complementary. Takes precedence over `redisUrl` when both are set.
   */
  databaseUrl: z.string().default(''),
  /**
   * Redis connection URL. Still supported for deployments already running it.
   * Empty (and no databaseUrl) = in-memory store, single-process/dev only.
   */
  redisUrl: z.string().default(''),

  // --- Autopilot (Loop 2) -------------------------------------------------
  /** Master switch for the autonomous drift→remediation scheduler. */
  autopilotEnabled: z.boolean().default(false),
  /** enforce = execute/queue actions; shadow = log intended actions only. */
  autopilotMode: z.enum(['enforce', 'shadow']).default('shadow'),
  /** How often the scheduler runs a drift cycle. */
  scanIntervalMs: z.coerce.number().int().positive().default(60_000),
  /** Dedup/cooldown window so the same action doesn't re-fire in a storm. */
  cooldownMs: z.coerce.number().int().positive().default(300_000),
  /** How long a pending approval waits before the safe default applies. */
  approvalTimeoutMs: z.coerce.number().int().positive().default(600_000),
  /** Safe default when an approval times out. */
  approvalTimeoutDecision: z.enum(['approved', 'rejected']).default('rejected'),
  /**
   * How long a pre-execution tool-call approval (Loop 3) waits before the
   * safe default applies. Deliberately separate from approvalTimeoutMs: that
   * one is designed for a background scan cycle where nothing is waiting on
   * it, while this wait sits SYNCHRONOUSLY inside an in-flight
   * /agents/:agentId/run request (and any reverse proxy in front of it,
   * most of which default to 30-60s) — a much shorter default keeps that
   * connection from timing out before the approval resolves.
   */
  toolCallApprovalTimeoutMs: z.coerce.number().int().positive().default(120_000),
  /** Safe default when a tool-call approval times out — fail-closed (deny) by default. */
  toolCallApprovalTimeoutDecision: z.enum(['approved', 'rejected']).default('rejected'),
  /**
   * Model id an approved `switch_model` action switches the agent to. Must be
   * a key in model-client.ts's `modelRegistry`. Defaults to MODEL_FALLBACK, so
   * setting that one var enables the whole feature. Empty = switch_model is a
   * no-op.
   */
  switchModelTo: z.string().default(''),

  // --- Notification channels ---------------------------------------------
  slackWebhookUrl: z.string().default(''),
  /** Slack app signing secret — verifies X-Slack-Signature on interactions. */
  slackSigningSecret: z.string().default(''),
  telegramBotToken: z.string().default(''),
  telegramChatId: z.string().default(''),
  /** Telegram secret token — verified on the webhook header. */
  telegramSecretToken: z.string().default(''),
  webhookUrl: z.string().default(''),

  // --- Policy definition (parsed separately from JSON/file) ---------------
  /** Inline policy JSON. Takes precedence over policiesFile when both set. */
  policiesJson: z.string().default(''),
  /** Path to a policies.json file. */
  policiesFile: z.string().default(''),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

export function loadServerConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  return ServerConfigSchema.parse({
    port: env.PORT,
    host: env.HOST,
    logLevel: env.LOG_LEVEL,
    bodyLimitBytes: env.BODY_LIMIT,
    trustProxy: env.TRUST_PROXY === '1',
    authToken: env.AUTH_TOKEN,
    adminUser: env.DW_USER,
    adminPassword: env.DW_PASSWORD,
    authSecret: env.DW_AUTH_SECRET || env.BETTER_AUTH_SECRET,
    baseUrl: env.DW_BASE_URL,
    maxPromptBytes: env.MAX_PROMPT_BYTES,
    driftDryRun: env.DRIFT_DRY_RUN === '1',
    rateLimitMax: env.RATE_LIMIT_MAX,
    rateLimitWindowMs: env.RATE_LIMIT_WINDOW_MS,
    agentId: env.AGENT_ID,
    agentName: env.AGENT_NAME,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    autopilotEnabled: env.AUTOPILOT_ENABLED === '1',
    autopilotMode: env.AUTOPILOT_MODE,
    scanIntervalMs: env.AUTOPILOT_SCAN_INTERVAL_MS,
    cooldownMs: env.AUTOPILOT_COOLDOWN_MS,
    approvalTimeoutMs: env.AUTOPILOT_APPROVAL_TIMEOUT_MS,
    approvalTimeoutDecision: env.AUTOPILOT_APPROVAL_TIMEOUT_DECISION,
    toolCallApprovalTimeoutMs: env.TOOL_CALL_APPROVAL_TIMEOUT_MS,
    toolCallApprovalTimeoutDecision: env.TOOL_CALL_APPROVAL_TIMEOUT_DECISION,
    switchModelTo: env.AUTOPILOT_SWITCH_MODEL_TO || env.MODEL_FALLBACK,
    slackWebhookUrl: env.SLACK_WEBHOOK_URL,
    slackSigningSecret: env.SLACK_SIGNING_SECRET,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    telegramChatId: env.TELEGRAM_CHAT_ID,
    telegramSecretToken: env.TELEGRAM_SECRET_TOKEN,
    webhookUrl: env.DRIFT_WEBHOOK_URL,
    policiesJson: env.AUTOPILOT_POLICIES,
    policiesFile: env.AUTOPILOT_POLICIES_FILE,
  });
}

