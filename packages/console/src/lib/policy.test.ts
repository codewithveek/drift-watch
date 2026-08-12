import { describe, it, expect } from 'vitest';
import { describeCondition, gateFor } from './policy.js';
import type { ToolCallPolicyRule } from '@/api';

const rule = (partial: Partial<ToolCallPolicyRule>): ToolCallPolicyRule => ({
  tool: 'create_refund',
  action: 'require_approval',
  severity: 'medium',
  ...partial,
});

describe('describeCondition', () => {
  it('has nothing to say about a whole-tool rule', () => {
    expect(describeCondition(rule({ field: undefined }))).toBeNull();
  });

  it('reads a field-only rule as a presence check', () => {
    expect(describeCondition(rule({ field: 'amountUsd' }))).toBe('amountUsd is present');
  });

  it('renders comparisons the way the policy reads', () => {
    expect(describeCondition(rule({ field: 'amountUsd', condition: { gt: 100 } }))).toBe(
      'amountUsd > 100',
    );
    expect(describeCondition(rule({ field: 'role', condition: { equals: 'admin' } }))).toBe(
      'role = admin',
    );
    expect(describeCondition(rule({ field: 'netDays', condition: { lte: 30 } }))).toBe(
      'netDays ≤ 30',
    );
  });

  it('reads `exists: false` as absence rather than as "exists false"', () => {
    expect(describeCondition(rule({ field: 'memo', condition: { exists: false } }))).toBe(
      'memo is absent',
    );
  });
});

describe('gateFor', () => {
  it('reports no gate when nothing matches', () => {
    expect(gateFor('send_email', [rule({ tool: 'create_refund' })])).toEqual({
      action: null,
      rules: [],
    });
  });

  it('includes wildcard rules', () => {
    const wildcard = rule({ tool: '*', action: 'deny' });
    const gate = gateFor('send_email', [wildcard]);
    expect(gate.action).toBe('deny');
    expect(gate.rules).toEqual([wildcard]);
  });

  it('is strictest-wins, in either rule order', () => {
    // Showing "needs approval" for a call the server would DENY would leave
    // the operator's model of the system wrong in the dangerous direction.
    const deny = rule({ action: 'deny' });
    const approve = rule({ action: 'require_approval' });
    expect(gateFor('create_refund', [approve, deny]).action).toBe('deny');
    expect(gateFor('create_refund', [deny, approve]).action).toBe('deny');
  });

  it('keeps every applicable rule so the UI can explain the gate', () => {
    const a = rule({ field: 'amountUsd', condition: { gt: 100 } });
    const b = rule({ tool: '*', action: 'deny' });
    expect(gateFor('create_refund', [a, b]).rules).toEqual([a, b]);
  });
});
