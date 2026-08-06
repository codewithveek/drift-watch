/**
 * Policy engine — the pure decision layer of Autopilot (Loop 2).
 *
 * Given a DriftReport (from ../drift/detector.ts) and a validated PolicyConfig,
 * `evaluatePolicies` returns the list of ActionIntents that *should* happen.
 * It is a pure function: no I/O, no cooldown state (the scheduler applies
 * cooldown via the StateStore), no execution. This makes the whole decision
 * layer trivially testable.
 */
import { z } from 'zod';
import type { DriftReport } from '../drift/detector.js';
import {
  ACTION_TYPES,
  categorizeAction,
  type ActionIntent,
  type ActionType,
  type DriftSeverity,
} from './types.js';

const SEVERITY_ORDER: Record<DriftSeverity, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};

const ActionTypeSchema = z.enum(ACTION_TYPES);

export const PolicyConditionSchema = z.object({
  /** Minimum verdict severity that satisfies this condition. */
  severity: z.enum(['none', 'low', 'medium', 'high']).optional(),
  /** Fire when current-vs-baseline token spend grew by at least this %. */
  tokenSpendDeltaPct: z.number().optional(),
  /** Fire when the current window error rate is at or above this fraction. */
  errorRateAbove: z.number().optional(),
  /** Fire when current-vs-baseline p95 latency grew by at least this %. */
  p95DeltaPct: z.number().optional(),
});
export type PolicyCondition = z.infer<typeof PolicyConditionSchema>;

export const PolicyRuleSchema = z.object({
  when: PolicyConditionSchema.default({}),
  do: z.array(ActionTypeSchema).min(1),
});
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

export const PolicyConfigSchema = z.object({
  rules: z.array(PolicyRuleSchema).default([]),
  /** Suppress a repeat of the same action within this window (ms). */
  cooldownMs: z.coerce.number().int().nonnegative().default(300_000),
  /** enforce = execute approved actions; shadow = log intended actions only. */
  mode: z.enum(['enforce', 'shadow']).default('shadow'),
});
export type PolicyConfig = z.infer<typeof PolicyConfigSchema>;

export interface WindowDeltas {
  tokenSpendDeltaPct: number;
  p95DeltaPct: number;
  currentErrorRate: number;
}

/** Percentage growth of `current` over `baseline`, guarding divide-by-zero. */
function percentGrowth(baseline: number, current: number): number {
  if (baseline <= 0) return current > 0 ? Number.POSITIVE_INFINITY : 0;
  return ((current - baseline) / baseline) * 100;
}

export function computeWindowDeltas(report: DriftReport): WindowDeltas {
  const { baselineWindowStats, currentWindowStats } = report;
  return {
    tokenSpendDeltaPct: percentGrowth(
      baselineWindowStats.tokenSpend,
      currentWindowStats.tokenSpend,
    ),
    p95DeltaPct: percentGrowth(
      baselineWindowStats.p95LatencyMs,
      currentWindowStats.p95LatencyMs,
    ),
    currentErrorRate: currentWindowStats.errorRate,
  };
}

function conditionIsEmpty(condition: PolicyCondition): boolean {
  return (
    condition.severity === undefined &&
    condition.tokenSpendDeltaPct === undefined &&
    condition.errorRateAbove === undefined &&
    condition.p95DeltaPct === undefined
  );
}

function ruleMatches(
  rule: PolicyRule,
  report: DriftReport,
  deltas: WindowDeltas,
): boolean {
  const { when } = rule;
  const verdictSeverity = report.verdict.severity;

  // A rule with no explicit conditions applies whenever drift was detected.
  if (conditionIsEmpty(when)) return report.verdict.drift;

  if (
    when.severity !== undefined &&
    SEVERITY_ORDER[verdictSeverity] < SEVERITY_ORDER[when.severity]
  ) {
    return false;
  }
  if (
    when.tokenSpendDeltaPct !== undefined &&
    deltas.tokenSpendDeltaPct < when.tokenSpendDeltaPct
  ) {
    return false;
  }
  if (
    when.errorRateAbove !== undefined &&
    deltas.currentErrorRate < when.errorRateAbove
  ) {
    return false;
  }
  if (
    when.p95DeltaPct !== undefined &&
    deltas.p95DeltaPct < when.p95DeltaPct
  ) {
    return false;
  }
  return true;
}

/**
 * Map a drift report through the policy rules into a de-duplicated list of
 * action intents. The first rule to introduce an action wins its reason.
 */
export function evaluatePolicies(
  report: DriftReport,
  policyConfig: PolicyConfig,
): ActionIntent[] {
  const deltas = computeWindowDeltas(report);
  const intentsByAction = new Map<ActionType, ActionIntent>();

  for (const rule of policyConfig.rules) {
    if (!ruleMatches(rule, report, deltas)) continue;
    for (const action of rule.do) {
      if (intentsByAction.has(action)) continue;
      intentsByAction.set(action, {
        type: action,
        category: categorizeAction(action),
        severity: report.verdict.severity,
        reason: report.verdict.reasons.join('; ') || 'drift detected',
      });
    }
  }

  return Array.from(intentsByAction.values());
}
