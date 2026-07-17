/**
 * Typed configuration for the SDK. Nothing in this package reads
 * `process.env` directly except `loadAgentPulseConfigFromEnv` below, and
 * that function is entirely optional — every SDK function takes its config
 * as a plain typed object, so a consumer can build one however they like:
 * from `process.env`, from a parsed `.env` via dotenv, from their own
 * app-level config/schema library (convict, env-var, t3-env, ...), or just
 * a literal object in tests.
 *
 *   // env-based (convenience default)
 *   const config = loadAgentPulseConfigFromEnv();
 *
 *   // or bring your own, validated against the same schema
 *   const config = AgentPulseConfigSchema.parse({
 *     telemetry: { serviceName: 'my-agent' },
 *     agent: { maxSteps: 12 },
 *   });
 */
import { z } from 'zod';

export const TelemetryConfigSchema = z.object({
  /** OTLP/HTTP collector endpoint, e.g. a SigNoz collector. */
  otlpEndpoint: z.string().default('http://localhost:4318'),
  /** Service name reported on every span/metric (OTel `service.name`). */
  serviceName: z.string().default('agentpulse'),
  serviceVersion: z.string().default('0.1.0'),
  /** Free-form deployment environment label, e.g. "production". */
  environment: z.string().default('development'),
});
export type TelemetryConfig = z.infer<typeof TelemetryConfigSchema>;

export const AgentConfigSchema = z.object({
  /** Upper bound on the generateText tool-use loop's step count. */
  maxSteps: z.coerce.number().int().positive().default(8),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const DriftDetectionConfigSchema = z.object({
  /** Base URL of the SigNoz query-service API (not the collector). */
  signozBaseUrl: z.string().default('http://localhost:8080'),
  signozApiKey: z.string().default(''),
});
export type DriftDetectionConfig = z.infer<typeof DriftDetectionConfigSchema>;

export const AgentPulseConfigSchema = z.object({
  telemetry: TelemetryConfigSchema.default({}),
  agent: AgentConfigSchema.default({}),
  driftDetection: DriftDetectionConfigSchema.default({}),
});
export type AgentPulseConfig = z.infer<typeof AgentPulseConfigSchema>;

/**
 * Convenience loader for the common case: build a validated
 * `AgentPulseConfig` straight from `process.env`. Pass a custom env-like
 * object (e.g. a parsed `.env` file, or a subset object in tests) via the
 * `env` parameter instead of relying on the `process.env` default.
 */
export function loadAgentPulseConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AgentPulseConfig {
  return AgentPulseConfigSchema.parse({
    telemetry: {
      otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
      serviceName: env.OTEL_SERVICE_NAME,
      serviceVersion: env.npm_package_version,
      environment: env.NODE_ENV,
    },
    agent: {
      maxSteps: env.AGENT_MAX_STEPS,
    },
    driftDetection: {
      signozBaseUrl: env.SIGNOZ_URL,
      signozApiKey: env.SIGNOZ_API_KEY,
    },
  });
}
