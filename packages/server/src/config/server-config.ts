import { z } from 'zod';
/**
 * Typed config for the parts of this server that are specific to *this*
 * Fastify app rather than the SDK (HTTP port/host, auth, body limits). Mirrors
 * the pattern used by @agentpulse/sdk's own config/schema.ts: nothing reads
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
  rateLimitMax: z.coerce.number().int().positive().default(30),
  rateLimitWindowMs: z.coerce.number().int().positive().default(60_000),
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
  });
}
