/**
 * Tool-call policy engine — Loop 3: pre-execution, per-tool-call gating.
 *
 * Distinct from `policy.ts` (Loop 2, post-hoc/aggregate: a whole DriftReport
 * in, ActionIntents out, evaluated on a scan cycle). This module inspects one
 * tool call's name + arguments BEFORE it executes and decides whether it may
 * proceed, must be denied outright, or must pause for a human decision. Pure
 * decision layer, same spirit as `evaluatePolicies` — no I/O, no approval
 * creation, no notification. See `tool-call-gate.ts` for the orchestration
 * that acts on this module's verdict.
 */
import { z } from 'zod';
import type { DriftSeverity } from './types.js';

export const ToolCallConditionSchema = z.object({
  gt: z.union([z.number(), z.string()]).optional(),
  gte: z.union([z.number(), z.string()]).optional(),
  lt: z.union([z.number(), z.string()]).optional(),
  lte: z.union([z.number(), z.string()]).optional(),
  equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
  /** Fire whenever the field is present (non-undefined/non-null), regardless of value. */
  exists: z.boolean().optional(),
});
export type ToolCallCondition = z.infer<typeof ToolCallConditionSchema>;

export const ToolCallPolicyRuleSchema = z.object({
  /** Tool name this rule applies to, or '*' to match every tool. */
  tool: z.string(),
  /** Dot-path into the tool's input, e.g. 'amount' or 'customer.ssn'. Omit to gate the whole tool regardless of input shape. */
  field: z.string().optional(),
  /** Empty (default) = matches whenever `field` is present (or always, if `field` is omitted). */
  condition: ToolCallConditionSchema.default({}),
  action: z.enum(['deny', 'require_approval']),
  /** Drives notification severity/UI treatment — reuses the same scale as drift verdicts. */
  severity: z.enum(['none', 'low', 'medium', 'high']),
  reason: z.string().optional(),
});
export type ToolCallPolicyRule = z.infer<typeof ToolCallPolicyRuleSchema>;

export type ToolCallGateAction = 'allow' | 'deny' | 'require_approval';

export interface ToolCallPolicyVerdict {
  action: ToolCallGateAction;
  matchedRule?: ToolCallPolicyRule;
}

/** Strictest-wins ordering when multiple rules match the same call. */
const ACTION_STRICTNESS: Record<ToolCallGateAction, number> = {
  allow: 0,
  require_approval: 1,
  deny: 2,
};

/** Walks a dot-path (e.g. 'customer.ssn') into a plain object. Returns undefined on any missing/non-object segment. */
export function getByPath(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function conditionIsEmpty(condition: ToolCallCondition): boolean {
  return (
    condition.gt === undefined &&
    condition.gte === undefined &&
    condition.lt === undefined &&
    condition.lte === undefined &&
    condition.equals === undefined &&
    condition.exists === undefined
  );
}

function conditionMatches(condition: ToolCallCondition, value: unknown): boolean {
  if (conditionIsEmpty(condition)) return value !== undefined;
  if (condition.exists !== undefined) {
    return condition.exists ? value !== undefined && value !== null : value === undefined || value === null;
  }
  if (condition.equals !== undefined && value !== condition.equals) return false;
  const numericValue = typeof value === 'number' ? value : Number(value);
  if (condition.gt !== undefined && !(numericValue > Number(condition.gt))) return false;
  if (condition.gte !== undefined && !(numericValue >= Number(condition.gte))) return false;
  if (condition.lt !== undefined && !(numericValue < Number(condition.lt))) return false;
  if (condition.lte !== undefined && !(numericValue <= Number(condition.lte))) return false;
  return true;
}

function ruleMatches(rule: ToolCallPolicyRule, tool: string, input: unknown): boolean {
  if (rule.tool !== '*' && rule.tool !== tool) return false;
  if (rule.field === undefined) return true;
  return conditionMatches(rule.condition, getByPath(input, rule.field));
}

/**
 * Evaluates every rule against one tool call and combines matches by
 * strictest-wins (deny > require_approval > allow). Within the winning tier,
 * the first matching rule in array order is reported as `matchedRule` —
 * mirrors `policy.ts`'s "first rule to introduce an action wins its reason"
 * convention.
 */
export function evaluateToolCallPolicy(
  tool: string,
  input: unknown,
  rules: ToolCallPolicyRule[],
): ToolCallPolicyVerdict {
  let best: ToolCallPolicyVerdict = { action: 'allow' };
  for (const rule of rules) {
    if (!ruleMatches(rule, tool, input)) continue;
    if (ACTION_STRICTNESS[rule.action] > ACTION_STRICTNESS[best.action]) {
      best = { action: rule.action, matchedRule: rule };
    }
  }
  return best;
}

// Re-exported for callers that want the shared severity scale without a
// separate import from drift/detector.js.
export type { DriftSeverity };
