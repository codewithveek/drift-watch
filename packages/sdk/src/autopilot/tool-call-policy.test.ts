import { describe, it, expect } from 'vitest';
import {
  evaluateToolCallPolicy,
  getByPath,
  ToolCallPolicyRuleSchema,
  type ToolCallPolicyRule,
} from './tool-call-policy.js';

function rule(overrides: Partial<ToolCallPolicyRule> & Pick<ToolCallPolicyRule, 'tool' | 'action'>): ToolCallPolicyRule {
  return { severity: 'medium', ...overrides };
}

describe('getByPath', () => {
  it('walks a nested dot-path', () => {
    expect(getByPath({ customer: { ssn: '123-45-6789' } }, 'customer.ssn')).toBe('123-45-6789');
  });

  it('returns undefined for a missing top-level field', () => {
    expect(getByPath({ amount: 5 }, 'missing')).toBeUndefined();
  });

  it('returns undefined when a middle segment is missing/non-object', () => {
    expect(getByPath({ amount: 5 }, 'amount.nested')).toBeUndefined();
    expect(getByPath(null, 'amount')).toBeUndefined();
    expect(getByPath('not-an-object', 'amount')).toBeUndefined();
  });
});

describe('rule authoring shape', () => {
  it('a rule literal without `condition` compiles and behaves as "always matches this tool"', () => {
    // No `condition` key at all — this must typecheck (it is the same shape the
    // HTTP API accepts) and match every call to that tool.
    const wholeToolRule: ToolCallPolicyRule = {
      tool: 'issue_refund',
      action: 'deny',
      severity: 'high',
    };
    expect(evaluateToolCallPolicy('issue_refund', { amountUsd: 5 }, [wholeToolRule]).action).toBe('deny');
    expect(evaluateToolCallPolicy('get_weather', {}, [wholeToolRule]).action).toBe('allow');
  });

  it('a field-scoped rule without `condition` matches whenever the field is present', () => {
    const rule: ToolCallPolicyRule = {
      tool: 'lookup_customer',
      field: 'ssn',
      action: 'require_approval',
      severity: 'high',
    };
    expect(evaluateToolCallPolicy('lookup_customer', { ssn: '123' }, [rule]).action).toBe(
      'require_approval',
    );
    expect(evaluateToolCallPolicy('lookup_customer', { name: 'Ada' }, [rule]).action).toBe('allow');
  });

  it('parses from JSON without `condition` (wire shape == authoring shape)', () => {
    const parsed = ToolCallPolicyRuleSchema.parse({
      tool: 'issue_refund',
      action: 'deny',
      severity: 'high',
    });
    expect(parsed.condition).toBeUndefined();
    expect(evaluateToolCallPolicy('issue_refund', {}, [parsed]).action).toBe('deny');
  });
});

describe('evaluateToolCallPolicy', () => {
  it('allows when no rule matches', () => {
    const verdict = evaluateToolCallPolicy('get_weather', { city: 'Lagos' }, [
      rule({ tool: 'refund_payment', action: 'deny' }),
    ]);
    expect(verdict).toEqual({ action: 'allow' });
  });

  it('denies on a whole-tool rule (no field) matching by tool name alone', () => {
    const denyRule = rule({ tool: 'refund_payment', action: 'deny', reason: 'never auto-refund' });
    const verdict = evaluateToolCallPolicy('refund_payment', { amount: 5 }, [denyRule]);
    expect(verdict).toEqual({ action: 'deny', matchedRule: denyRule });
  });

  it('matches a "*" wildcard tool rule against any tool', () => {
    const denyRule = rule({ tool: '*', action: 'deny' });
    expect(evaluateToolCallPolicy('get_weather', {}, [denyRule]).action).toBe('deny');
    expect(evaluateToolCallPolicy('search_docs', {}, [denyRule]).action).toBe('deny');
  });

  it('requires approval when a field-scoped condition matches', () => {
    const approvalRule = rule({
      tool: 'refund_payment',
      field: 'amount',
      condition: { gt: 1000 },
      action: 'require_approval',
    });
    expect(evaluateToolCallPolicy('refund_payment', { amount: 5000 }, [approvalRule]).action).toBe(
      'require_approval',
    );
    expect(evaluateToolCallPolicy('refund_payment', { amount: 10 }, [approvalRule]).action).toBe('allow');
  });

  it('an empty condition on a field-scoped rule matches whenever the field is present', () => {
    const approvalRule = rule({ tool: 'lookup_customer', field: 'ssn', action: 'require_approval' });
    expect(evaluateToolCallPolicy('lookup_customer', { ssn: '123' }, [approvalRule]).action).toBe(
      'require_approval',
    );
    expect(evaluateToolCallPolicy('lookup_customer', { name: 'Ada' }, [approvalRule]).action).toBe('allow');
  });

  it('exists:false matches when the field is absent or null', () => {
    const approvalRule = rule({
      tool: 'search_docs',
      field: 'internalOnly',
      condition: { exists: false },
      action: 'require_approval',
    });
    expect(evaluateToolCallPolicy('search_docs', { query: 'x' }, [approvalRule]).action).toBe(
      'require_approval',
    );
    expect(evaluateToolCallPolicy('search_docs', { internalOnly: true }, [approvalRule]).action).toBe(
      'allow',
    );
  });

  it('equals matches an exact value', () => {
    const denyRule = rule({
      tool: 'set_role',
      field: 'role',
      condition: { equals: 'admin' },
      action: 'deny',
    });
    expect(evaluateToolCallPolicy('set_role', { role: 'admin' }, [denyRule]).action).toBe('deny');
    expect(evaluateToolCallPolicy('set_role', { role: 'viewer' }, [denyRule]).action).toBe('allow');
  });

  it('strictest-wins regardless of array order: deny beats require_approval beats allow', () => {
    const approvalRule = rule({
      tool: 'refund_payment',
      field: 'amount',
      condition: { gt: 100 },
      action: 'require_approval',
    });
    const denyRule = rule({
      tool: 'refund_payment',
      field: 'amount',
      condition: { gt: 10000 },
      action: 'deny',
    });

    // deny listed first
    expect(
      evaluateToolCallPolicy('refund_payment', { amount: 50000 }, [denyRule, approvalRule]).action,
    ).toBe('deny');
    // deny listed last — order must not matter
    expect(
      evaluateToolCallPolicy('refund_payment', { amount: 50000 }, [approvalRule, denyRule]).action,
    ).toBe('deny');
    // only the approval-tier rule matches
    expect(evaluateToolCallPolicy('refund_payment', { amount: 500 }, [approvalRule, denyRule]).action).toBe(
      'require_approval',
    );
  });

  it('reports the first matching rule within the winning tier as matchedRule', () => {
    const first = rule({ tool: 'refund_payment', action: 'deny', reason: 'first' });
    const second = rule({ tool: 'refund_payment', action: 'deny', reason: 'second' });
    const verdict = evaluateToolCallPolicy('refund_payment', {}, [first, second]);
    expect(verdict.matchedRule?.reason).toBe('first');
  });
});
