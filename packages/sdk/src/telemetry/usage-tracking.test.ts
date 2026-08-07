import { describe, it, expect, vi, beforeEach } from 'vitest';

const addMock = vi.fn();

vi.mock('@opentelemetry/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opentelemetry/api')>();
  return {
    ...actual,
    metrics: {
      ...actual.metrics,
      getMeter: () => ({
        createCounter: () => ({ add: addMock }),
      }),
    },
  };
});

// Imported AFTER the mock so the module's lazy singleton binds to the fake meter.
const { recordTokenUsageMetric } = await import('./usage-tracking.js');

beforeEach(() => {
  addMock.mockClear();
});

describe('recordTokenUsageMetric', () => {
  it('records separate input/output increments with model/provider/function_id labels', () => {
    recordTokenUsageMetric({
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      providerName: 'qwen',
      modelIdentifier: 'qwen3.7-max',
      functionId: 'agent-run',
    });

    expect(addMock).toHaveBeenCalledTimes(2);
    expect(addMock).toHaveBeenCalledWith(100, {
      model: 'qwen3.7-max',
      provider: 'qwen',
      function_id: 'agent-run',
      type: 'input',
    });
    expect(addMock).toHaveBeenCalledWith(20, {
      model: 'qwen3.7-max',
      provider: 'qwen',
      function_id: 'agent-run',
      type: 'output',
    });
  });

  it('skips a direction entirely when its token count is zero', () => {
    recordTokenUsageMetric({
      usage: { inputTokens: 50, outputTokens: 0, totalTokens: 50 },
      providerName: 'qwen',
      modelIdentifier: 'qwen3.7-max',
      functionId: 'drift-judge',
    });
    expect(addMock).toHaveBeenCalledTimes(1);
    expect(addMock).toHaveBeenCalledWith(50, expect.objectContaining({ type: 'input' }));
  });

  it('adds agent_id when agentId is provided — this is the whole point of the relocation: two different agents produce two differently-labeled records', () => {
    recordTokenUsageMetric({
      usage: { inputTokens: 10, outputTokens: 0, totalTokens: 10 },
      providerName: 'qwen',
      modelIdentifier: 'qwen3.7-max',
      functionId: 'agent-run',
      agentId: 'agent-a',
    });
    recordTokenUsageMetric({
      usage: { inputTokens: 10, outputTokens: 0, totalTokens: 10 },
      providerName: 'qwen',
      modelIdentifier: 'qwen3.7-max',
      functionId: 'agent-run',
      agentId: 'agent-b',
    });

    expect(addMock).toHaveBeenCalledWith(10, expect.objectContaining({ agent_id: 'agent-a' }));
    expect(addMock).toHaveBeenCalledWith(10, expect.objectContaining({ agent_id: 'agent-b' }));
  });

  it('omits agent_id/service_name entirely when not provided (no empty-label cardinality)', () => {
    recordTokenUsageMetric({
      usage: { inputTokens: 10, outputTokens: 0, totalTokens: 10 },
      providerName: 'qwen',
      modelIdentifier: 'qwen3.7-max',
      functionId: 'agent-run',
    });
    const [, attributes] = addMock.mock.calls.at(-1)!;
    expect(attributes).not.toHaveProperty('agent_id');
    expect(attributes).not.toHaveProperty('service_name');
  });
});
