import { z } from 'zod';
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
  /** Bearer token required on /run and /drift. Empty string = local-only mode. */
  authToken: z.string().default(''),
  maxPromptBytes: z.coerce.number().int().positive().default(8192),
  /** Use built-in drift fixtures instead of querying SigNoz. */
  driftDryRun: z.boolean().default(false),
  /** Max requests per client (by IP, or by bearer token when set) per rateLimitWindowMs on /run and /drift. */
  rateLimitMax: z.coerce.number().int().positive().default(100),
  rateLimitWindowMs: z.coerce.number().int().positive().default(60_000),

  // --- Autopilot (Loop 2) -------------------------------------------------
  /** Redis connection URL. Empty = in-memory store (single-process/dev). */
  redisUrl: z.string().default(''),
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
    maxPromptBytes: env.MAX_PROMPT_BYTES,
    driftDryRun: env.DRIFT_DRY_RUN === '1',
    rateLimitMax: env.RATE_LIMIT_MAX,
    rateLimitWindowMs: env.RATE_LIMIT_WINDOW_MS,
    redisUrl: env.REDIS_URL,
    autopilotEnabled: env.AUTOPILOT_ENABLED === '1',
    autopilotMode: env.AUTOPILOT_MODE,
    scanIntervalMs: env.AUTOPILOT_SCAN_INTERVAL_MS,
    cooldownMs: env.AUTOPILOT_COOLDOWN_MS,
    approvalTimeoutMs: env.AUTOPILOT_APPROVAL_TIMEOUT_MS,
    approvalTimeoutDecision: env.AUTOPILOT_APPROVAL_TIMEOUT_DECISION,
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

