import { describe, it, expect } from 'vitest';
import {
  estimateCostUsd,
  evaluateGuardrailBreach,
  sumStepUsage,
  buildTokenBudgetStopConditions,
  type AgentGuardrails,
} from './guardrails.js';

const baseGuardrails: AgentGuardrails = {
  maxTokensPerTask: 0,
  maxCostUsd: 0,
  pricePer1kInput: 0,
  pricePer1kOutput: 0,
  onExceed: 'stop',
};

describe('evaluateGuardrailBreach', () => {
  it('does not breach when all caps are disabled (0)', () => {
    const breach = evaluateGuardrailBreach(
      { inputTokens: 10_000, outputTokens: 10_000, totalTokens: 20_000 },
      baseGuardrails,
    );
    expect(breach.breached).toBe(false);
  });

  it('breaches when the token cap is crossed', () => {
    const breach = evaluateGuardrailBreach(
      { inputTokens: 800, outputTokens: 400, totalTokens: 1200 },
      { ...baseGuardrails, maxTokensPerTask: 1000 },
    );
    expect(breach.breached).toBe(true);
    expect(breach.reason).toContain('token budget');
  });

  it('stays under the token cap', () => {
    const breach = evaluateGuardrailBreach(
      { inputTokens: 300, outputTokens: 200, totalTokens: 500 },
      { ...baseGuardrails, maxTokensPerTask: 1000 },
    );
    expect(breach.breached).toBe(false);
  });

  it('breaches when the cost cap is crossed', () => {
    const guardrails: AgentGuardrails = {
      ...baseGuardrails,
      maxCostUsd: 0.05,
      pricePer1kInput: 0.03,
      pricePer1kOutput: 0.06,
    };
    // 1000 in * 0.03 + 1000 out * 0.06 = 0.09 >= 0.05
    const breach = evaluateGuardrailBreach(
      { inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 },
      guardrails,
    );
    expect(breach.breached).toBe(true);
    expect(breach.reason).toContain('cost budget');
  });
});

describe('estimateCostUsd', () => {
  it('derives cost from per-1k prices', () => {
    const cost = estimateCostUsd(
      { inputTokens: 2000, outputTokens: 1000, totalTokens: 3000 },
      { ...baseGuardrails, pricePer1kInput: 0.01, pricePer1kOutput: 0.02 },
    );
    expect(cost).toBeCloseTo(0.04, 6);
  });
});

describe('sumStepUsage', () => {
  it('sums usage across steps and falls back to input+output', () => {
    const usage = sumStepUsage([
      { usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } as never },
      { usage: { inputTokens: 200, outputTokens: 25 } as never },
    ]);
    expect(usage.inputTokens).toBe(300);
    expect(usage.outputTokens).toBe(75);
    expect(usage.totalTokens).toBe(150 + 225);
  });
});

describe('buildTokenBudgetStopConditions', () => {
  it('returns no conditions when onExceed is flag', () => {
    const conditions = buildTokenBudgetStopConditions({
      ...baseGuardrails,
      maxTokensPerTask: 1000,
      onExceed: 'flag',
    });
    expect(conditions).toHaveLength(0);
  });

  it('returns no conditions when no cap is enabled', () => {
    expect(buildTokenBudgetStopConditions(baseGuardrails)).toHaveLength(0);
  });

  it('stops once summed step usage crosses the token cap', () => {
    const [condition] = buildTokenBudgetStopConditions({
      ...baseGuardrails,
      maxTokensPerTask: 1000,
    });
    expect(condition).toBeDefined();
    const steps = [
      { usage: { inputTokens: 400, outputTokens: 300, totalTokens: 700 } },
      { usage: { inputTokens: 300, outputTokens: 200, totalTokens: 500 } },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(condition({ steps } as any)).toBe(true);
  });
});
