import { describe, it, expect } from 'vitest';
import {
  evaluatePolicies,
  computeWindowDeltas,
  PolicyConfigSchema,
} from './policy.js';
import type { DriftReport, WindowStats } from '../drift/detector.js';

function windowStats(overrides: Partial<WindowStats> = {}): WindowStats {
  return {
    windowLabel: 'w',
    totalCalls: 100,
    errorRate: 0.02,
    p95LatencyMs: 180,
    tokenSpend: 40_000,
    toolMix: {},
    ...overrides,
  };
}

function driftReport(overrides: {
  severity?: DriftReport['verdict']['severity'];
  drift?: boolean;
  baseline?: Partial<WindowStats>;
  current?: Partial<WindowStats>;
}): DriftReport {
  return {
    baselineWindowStats: windowStats(overrides.baseline),
    currentWindowStats: windowStats(overrides.current),
    verdict: {
      drift: overrides.drift ?? true,
      severity: overrides.severity ?? 'high',
      reasons: ['token spend spiked', 'error rate up'],
      recommended_action: 'pause and investigate',
    },
    judgeTokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    providerName: 'qwen',
    modelIdentifier: 'qwen-max',
  };
}

describe('computeWindowDeltas', () => {
  it('computes percentage growth and current error rate', () => {
    const deltas = computeWindowDeltas(
      driftReport({
        baseline: { tokenSpend: 40_000, p95LatencyMs: 100 },
        current: { tokenSpend: 100_000, p95LatencyMs: 250, errorRate: 0.1 },
      }),
    );
    expect(deltas.tokenSpendDeltaPct).toBeCloseTo(150, 5);
    expect(deltas.p95DeltaPct).toBeCloseTo(150, 5);
    expect(deltas.currentErrorRate).toBeCloseTo(0.1, 5);
  });

  it('guards divide-by-zero baselines', () => {
    const deltas = computeWindowDeltas(
      driftReport({ baseline: { tokenSpend: 0 }, current: { tokenSpend: 500 } }),
    );
    expect(deltas.tokenSpendDeltaPct).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('evaluatePolicies', () => {
  it('fires actions when the severity ladder is met (>=)', () => {
    const config = PolicyConfigSchema.parse({
      rules: [{ when: { severity: 'medium' }, do: ['notify_slack', 'pause_agent'] }],
    });
    const intents = evaluatePolicies(driftReport({ severity: 'high' }), config);
    expect(intents.map((i) => i.type)).toEqual(['notify_slack', 'pause_agent']);
    expect(intents.find((i) => i.type === 'pause_agent')?.category).toBe('control');
    expect(intents.find((i) => i.type === 'notify_slack')?.category).toBe('notify');
  });

  it('does not fire when severity is below the threshold', () => {
    const config = PolicyConfigSchema.parse({
      rules: [{ when: { severity: 'high' }, do: ['pause_agent'] }],
    });
    expect(evaluatePolicies(driftReport({ severity: 'low' }), config)).toHaveLength(0);
  });

  it('fires on a token-spend delta threshold', () => {
    const config = PolicyConfigSchema.parse({
      rules: [{ when: { tokenSpendDeltaPct: 100 }, do: ['notify_telegram'] }],
    });
    const report = driftReport({
      severity: 'low',
      baseline: { tokenSpend: 10_000 },
      current: { tokenSpend: 30_000 },
    });
    expect(evaluatePolicies(report, config).map((i) => i.type)).toEqual([
      'notify_telegram',
    ]);
  });

  it('fires on an error-rate threshold', () => {
    const config = PolicyConfigSchema.parse({
      rules: [{ when: { errorRateAbove: 0.2 }, do: ['notify_webhook'] }],
    });
    const report = driftReport({ current: { errorRate: 0.25 } });
    expect(evaluatePolicies(report, config)).toHaveLength(1);
  });

  it('requires ALL specified conditions in a rule', () => {
    const config = PolicyConfigSchema.parse({
      rules: [
        { when: { severity: 'high', errorRateAbove: 0.9 }, do: ['pause_agent'] },
      ],
    });
    // severity ok, but error rate not met → no fire
    expect(evaluatePolicies(driftReport({ severity: 'high' }), config)).toHaveLength(0);
  });

  it('an empty condition matches only when drift is true', () => {
    const config = PolicyConfigSchema.parse({
      rules: [{ when: {}, do: ['notify_slack'] }],
    });
    expect(evaluatePolicies(driftReport({ drift: true }), config)).toHaveLength(1);
    expect(evaluatePolicies(driftReport({ drift: false }), config)).toHaveLength(0);
  });

  it('de-duplicates actions across overlapping rules', () => {
    const config = PolicyConfigSchema.parse({
      rules: [
        { when: { severity: 'low' }, do: ['notify_slack'] },
        { when: { severity: 'high' }, do: ['notify_slack', 'pause_agent'] },
      ],
    });
    const intents = evaluatePolicies(driftReport({ severity: 'high' }), config);
    expect(intents.map((i) => i.type)).toEqual(['notify_slack', 'pause_agent']);
  });
});
