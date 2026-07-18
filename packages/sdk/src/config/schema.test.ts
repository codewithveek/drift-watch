import { describe, it, expect } from 'vitest';
import {
  DriftWatchConfigSchema,
  loadDriftWatchConfigFromEnv,
} from './schema.js';

describe('DriftWatchConfigSchema', () => {
  it('fills in sensible defaults when given an empty object', () => {
    const config = DriftWatchConfigSchema.parse({});
    expect(config).toEqual({
      telemetry: {
        otlpEndpoint: 'http://localhost:4318',
        serviceName: 'driftwatch',
        serviceVersion: '0.1.0',
        environment: 'development',
        capturePayloads: true,
      },
      agent: { maxSteps: 8 },
      driftDetection: { signozBaseUrl: 'http://localhost:8080', signozApiKey: '' },
    });
  });

  it('accepts a fully custom, non-env-sourced config object', () => {
    const config = DriftWatchConfigSchema.parse({
      telemetry: { serviceName: 'checkout-agent', environment: 'production' },
      agent: { maxSteps: 20 },
      driftDetection: { signozBaseUrl: 'https://signoz.internal', signozApiKey: 'secret' },
    });
    expect(config.telemetry.serviceName).toBe('checkout-agent');
    expect(config.telemetry.environment).toBe('production');
    expect(config.agent.maxSteps).toBe(20);
    expect(config.driftDetection.signozBaseUrl).toBe('https://signoz.internal');
  });
});

describe('loadDriftWatchConfigFromEnv', () => {
  it('reads from a supplied env-like object rather than process.env', () => {
    const config = loadDriftWatchConfigFromEnv({
      OTEL_SERVICE_NAME: 'from-env',
      AGENT_MAX_STEPS: '15',
      SIGNOZ_URL: 'https://signoz.example.com',
    } as NodeJS.ProcessEnv);

    expect(config.telemetry.serviceName).toBe('from-env');
    expect(config.agent.maxSteps).toBe(15);
    expect(config.driftDetection.signozBaseUrl).toBe('https://signoz.example.com');
  });

  it('falls back to schema defaults for unset env vars', () => {
    const config = loadDriftWatchConfigFromEnv({} as NodeJS.ProcessEnv);
    expect(config.agent.maxSteps).toBe(8);
    expect(config.telemetry.serviceName).toBe('driftwatch');
    expect(config.telemetry.capturePayloads).toBe(true);
  });

  it('disables payload capture only when OTEL_CAPTURE_PAYLOADS is exactly "0"', () => {
    expect(
      loadDriftWatchConfigFromEnv({ OTEL_CAPTURE_PAYLOADS: '0' } as NodeJS.ProcessEnv)
        .telemetry.capturePayloads,
    ).toBe(false);
    expect(
      loadDriftWatchConfigFromEnv({} as NodeJS.ProcessEnv).telemetry.capturePayloads,
    ).toBe(true);
  });
});
