import type { ToolCallPolicyRule } from '@/api';

/**
 * Display helpers for tool-call policy rules.
 *
 * These mirror the SDK's evaluation semantics for READING purposes only —
 * nothing here gates anything. The one property worth preserving exactly is
 * strictest-wins: if the console showed a tool as "requires approval" while the
 * server would deny it, the operator's model of the system would be wrong in
 * the direction that matters.
 */

/** The comparison operators a rule's `condition` supports, plus "no condition". */
export const OPERATORS = [
  { value: 'any', label: 'is present' },
  { value: 'equals', label: '=' },
  { value: 'gt', label: '>' },
  { value: 'gte', label: '≥' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '≤' },
  { value: 'exists', label: 'exists' },
] as const;

export type Operator = (typeof OPERATORS)[number]['value'];

/** Renders a rule's condition the way it reads in the policy, e.g. `amountUsd > 100`. */
export function describeCondition(rule: ToolCallPolicyRule): string | null {
  if (!rule.field) return null;
  const entries = Object.entries(rule.condition ?? {});
  if (entries.length === 0) return `${rule.field} is present`;
  const [op, value] = entries[0];
  const label = OPERATORS.find((o) => o.value === op)?.label ?? op;
  return op === 'exists'
    ? `${rule.field} ${value ? 'exists' : 'is absent'}`
    : `${rule.field} ${label} ${value}`;
}

export type GateAction = ToolCallPolicyRule['action'];

export interface ToolGate {
  /** Null when no rule touches this tool — the call runs unchecked. */
  action: GateAction | null;
  /** Every rule that applies, including wildcard ones. */
  rules: ToolCallPolicyRule[];
}

const STRICTNESS: Record<GateAction, number> = { require_approval: 1, deny: 2 };

/** What would happen to a call to `tool`, given the agent's resolved rule set. */
export function gateFor(tool: string, rules: readonly ToolCallPolicyRule[]): ToolGate {
  const applicable = rules.filter((rule) => rule.tool === tool || rule.tool === '*');
  const action = applicable.reduce<GateAction | null>(
    (strictest, rule) =>
      strictest === null || STRICTNESS[rule.action] > STRICTNESS[strictest] ? rule.action : strictest,
    null,
  );
  return { action, rules: applicable };
}

export const GATE_LABEL: Record<GateAction, string> = {
  deny: 'Denied',
  require_approval: 'Needs approval',
};
