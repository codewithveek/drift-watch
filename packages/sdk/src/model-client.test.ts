import { describe, it, expect } from 'vitest';
import {
  describeModelClient,
  assertModelClientIsConfigured,
} from './model-client.js';

describe('describeModelClient', () => {
  it('reports the gateway-shorthand string form under the gateway provider', () => {
    const descriptor = describeModelClient('anthropic/claude-3-5-sonnet');
    expect(descriptor).toEqual({
      providerName: 'gateway',
      modelIdentifier: 'anthropic/claude-3-5-sonnet',
    });
  });

  it('reads provider and modelId straight off a constructed model object', () => {
    const fakeModelClient = { provider: 'anthropic', modelId: 'claude-3-5-sonnet-latest' };
    const descriptor = describeModelClient(fakeModelClient as never);
    expect(descriptor).toEqual({
      providerName: 'anthropic',
      modelIdentifier: 'claude-3-5-sonnet-latest',
    });
  });
});

describe('assertModelClientIsConfigured', () => {
  it('throws a clear, actionable error when no model client is configured', () => {
    expect(() => assertModelClientIsConfigured(undefined)).toThrow(
      /No model client configured/,
    );
    expect(() => assertModelClientIsConfigured(null)).toThrow(
      /No model client configured/,
    );
  });

  it('does not throw when a model client is present', () => {
    expect(() => assertModelClientIsConfigured('anthropic/claude-3-5-sonnet')).not.toThrow();
  });
});
