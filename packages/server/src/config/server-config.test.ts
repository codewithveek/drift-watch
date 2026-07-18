import { describe, it, expect } from 'vitest';
import { ServerConfigSchema, loadServerConfigFromEnv } from './server-config.js';

describe('ServerConfigSchema', () => {
  it('fills in sensible defaults when given an empty object', () => {
    const config = ServerConfigSchema.parse({});
    expect(config).toEqual({
      port: 3000,
      host: '0.0.0.0',
      logLevel: 'info',
      bodyLimitBytes: 131072,
      trustProxy: false,
      authToken: '',
      maxPromptBytes: 8192,
      driftDryRun: false,
      rateLimitMax: 30,
      rateLimitWindowMs: 60_000,
      redisUrl: '',
      autopilotEnabled: false,
      autopilotMode: 'shadow',
      scanIntervalMs: 60_000,
      cooldownMs: 300_000,
      approvalTimeoutMs: 600_000,
      approvalTimeoutDecision: 'rejected',
      slackWebhookUrl: '',
      slackSigningSecret: '',
      telegramBotToken: '',
      telegramChatId: '',
      telegramSecretToken: '',
      webhookUrl: '',
      policiesJson: '',
      policiesFile: '',
    });
  });
});

describe('loadServerConfigFromEnv', () => {
  it('reads booleans correctly from "1"/absent rather than JS string truthiness', () => {
    const config = loadServerConfigFromEnv({
      TRUST_PROXY: '1',
      DRIFT_DRY_RUN: '0',
    } as NodeJS.ProcessEnv);
    expect(config.trustProxy).toBe(true);
    expect(config.driftDryRun).toBe(false);
  });

  it('coerces numeric env vars', () => {
    const config = loadServerConfigFromEnv({
      PORT: '4000',
      MAX_PROMPT_BYTES: '4096',
    } as NodeJS.ProcessEnv);
    expect(config.port).toBe(4000);
    expect(config.maxPromptBytes).toBe(4096);
  });
});
