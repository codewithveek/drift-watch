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

const { withSkillExecutionSpan, ToolCallDeniedError } = await import('./instrument.js');

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

  it('a policyGate that allows behaves exactly as if it were absent', async () => {
    const result = await withSkillExecutionSpan({
      skillName: 'get_weather',
      skillInput: { city: 'Lagos' },
      policyGate: async () => ({ allowed: true }),
      executeSkill: async () => 'ok',
    });
    expect(result).toBe('ok');
    expect(addMock).toHaveBeenCalledWith(1, { tool: 'get_weather', outcome: 'ok' });
  });

  it('a policyGate that denies throws ToolCallDeniedError, records outcome:denied, and never calls executeSkill', async () => {
    const executeSkill = vi.fn(async () => 'should not run');
    await expect(
      withSkillExecutionSpan({
        skillName: 'refund_payment',
        skillInput: { amount: 50000 },
        agentId: 'agent-a',
        policyGate: async () => ({ allowed: false, reason: 'amount exceeds auto-approve threshold' }),
        executeSkill,
      }),
    ).rejects.toThrow(ToolCallDeniedError);

    expect(executeSkill).not.toHaveBeenCalled();
    expect(addMock).toHaveBeenCalledWith(1, {
      tool: 'refund_payment',
      outcome: 'denied',
      agent_id: 'agent-a',
    });
    // A denial must not touch the duration histogram — there was no execution to time.
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('regression: time spent inside a slow policyGate is excluded from agent.tool.duration (must not contaminate Loop 2\'s p95 drift signal)', async () => {
    await withSkillExecutionSpan({
      skillName: 'get_weather',
      skillInput: {},
      policyGate: () => new Promise((resolve) => setTimeout(() => resolve({ allowed: true }), 50)),
      executeSkill: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return 'ok';
      },
    });

    expect(recordMock).toHaveBeenCalledTimes(1);
    const [durationMs] = recordMock.mock.calls[0];
    // Only executeSkill's ~5ms should be timed, not the gate's ~50ms wait.
    expect(durationMs).toBeLessThan(40);
  });
});
