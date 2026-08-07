import { describe, it, expect, vi, beforeEach } from 'vitest';

const addMock = vi.fn();
const recordMock = vi.fn();

vi.mock('@opentelemetry/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opentelemetry/api')>();
  return {
    ...actual,
    metrics: {
      ...actual.metrics,
      getMeter: () => ({
        createCounter: () => ({ add: addMock }),
        createHistogram: () => ({ record: recordMock }),
      }),
    },
  };
});

const { withSkillExecutionSpan } = await import('./instrument.js');

beforeEach(() => {
  addMock.mockClear();
  recordMock.mockClear();
});

describe('withSkillExecutionSpan', () => {
  it('labels the calls counter and duration histogram with tool/outcome, no agent labels when agentId is omitted', async () => {
    await withSkillExecutionSpan({
      skillName: 'get_weather',
      skillInput: { city: 'Lagos' },
      executeSkill: async () => 'ok',
    });

    expect(addMock).toHaveBeenCalledWith(1, { tool: 'get_weather', outcome: 'ok' });
    expect(recordMock).toHaveBeenCalledTimes(1);
    const [, durationAttrs] = recordMock.mock.calls[0];
    expect(durationAttrs).toEqual({ tool: 'get_weather' });
  });

  it('two different agentIds produce two differently-labeled call records — the core co-located-agents claim', async () => {
    await withSkillExecutionSpan({
      skillName: 'get_weather',
      skillInput: {},
      agentId: 'agent-a',
      executeSkill: async () => 'ok',
    });
    await withSkillExecutionSpan({
      skillName: 'get_weather',
      skillInput: {},
      agentId: 'agent-b',
      executeSkill: async () => 'ok',
    });

    expect(addMock).toHaveBeenCalledWith(1, { tool: 'get_weather', outcome: 'ok', agent_id: 'agent-a' });
    expect(addMock).toHaveBeenCalledWith(1, { tool: 'get_weather', outcome: 'ok', agent_id: 'agent-b' });
  });

  it('labels the error-outcome increment with agent_id too when the skill throws', async () => {
    await expect(
      withSkillExecutionSpan({
        skillName: 'get_weather',
        skillInput: {},
        agentId: 'agent-a',
        executeSkill: async () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');

    expect(addMock).toHaveBeenCalledWith(1, {
      tool: 'get_weather',
      outcome: 'error',
      agent_id: 'agent-a',
    });
  });

  it('includes service_name alongside agent_id when both are provided', async () => {
    await withSkillExecutionSpan({
      skillName: 'search_docs',
      skillInput: {},
      agentId: 'agent-a',
      serviceName: 'checkout-svc',
      executeSkill: async () => 'ok',
    });

    expect(addMock).toHaveBeenCalledWith(1, {
      tool: 'search_docs',
      outcome: 'ok',
      agent_id: 'agent-a',
      service_name: 'checkout-svc',
    });
  });
});
