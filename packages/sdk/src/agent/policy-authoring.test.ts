/**
 * Type-level tests for policy authoring, plus the one runtime conversion.
 *
 * The `@ts-expect-error` assertions below are the point of this file, and they
 * are only real because tsconfig.test.json puts test files back in front of tsc
 * (the build config excludes them). If any of these stops being an error, the
 * line itself becomes an error — which is exactly the alarm we want.
 */
import { describe, expect, it } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { toRuntimeRule, type Paths, type PolicyRule, type ValueAtPath } from './policy-authoring.js';

const TOOLS = {
  issue_refund: tool({
    description: 'Issue a refund for an order',
    inputSchema: z.object({
      orderId: z.string(),
      amountUsd: z.number(),
      customer: z.object({ tier: z.string(), region: z.string() }),
    }),
    execute: async () => ({ ok: true }),
  }),
  lookup_order: tool({
    description: 'Look up an order',
    inputSchema: z.object({ orderId: z.string() }),
    execute: async () => ({ found: true }),
  }),
};

type Tools = typeof TOOLS;
type Rule = PolicyRule<Tools>;

describe('tool names', () => {
  it('accepts a declared tool', () => {
    const rule: Rule = { tool: 'issue_refund', action: 'deny' };
    expect(rule.tool).toBe('issue_refund');
  });

  it('accepts the wildcard', () => {
    const rule: Rule = { tool: '*', action: 'require_approval' };
    expect(rule.tool).toBe('*');
  });

  it('REJECTS a misspelled tool name', () => {
    // The whole reason tool names are strict: this rule would parse, store and
    // evaluate cleanly while gating nothing at all.
    // @ts-expect-error - 'issue_refnud' is not a declared tool
    const rule: Rule = { tool: 'issue_refnud', action: 'deny' };
    expect(rule).toBeDefined();
  });
});

describe('field paths', () => {
  it('accepts a top-level field', () => {
    const rule: Rule = { tool: 'issue_refund', field: 'amountUsd', action: 'deny' };
    expect(rule.field).toBe('amountUsd');
  });

  it('accepts a nested field', () => {
    const rule: Rule = { tool: 'issue_refund', field: 'customer.tier', action: 'deny' };
    expect(rule.field).toBe('customer.tier');
  });

  it('still accepts an unsuggested path, because extraction is depth-limited', () => {
    // Loose on purpose — see the module docblock. A wrong path fails open into
    // "field absent", which is observable; a wrong tool name fails silent.
    const rule: Rule = { tool: 'issue_refund', field: 'deeply.nested.unknown.path', action: 'deny' };
    expect(rule.field).toBe('deeply.nested.unknown.path');
  });
});

describe('conditions', () => {
  it('allows numeric comparisons on a numeric field', () => {
    const rule: Rule = {
      tool: 'issue_refund',
      field: 'amountUsd',
      condition: { gt: 100 },
      action: 'require_approval',
    };
    expect(rule.condition).toEqual({ gt: 100 });
  });

  it('allows a range', () => {
    const rule: Rule = {
      tool: 'issue_refund',
      field: 'amountUsd',
      condition: { gte: 100, lt: 1000 },
      action: 'require_approval',
    };
    expect(rule.condition).toEqual({ gte: 100, lt: 1000 });
  });

  it('allows equals and exists on a string field', () => {
    const rule: Rule = {
      tool: 'issue_refund',
      field: 'customer.tier',
      condition: { equals: 'enterprise' },
      action: 'require_approval',
    };
    expect(rule.condition).toEqual({ equals: 'enterprise' });
  });

  it('REJECTS a numeric comparison on a string field', () => {
    // The runtime coerces gt operands with Number(), so this compares against
    // NaN and can never fire — a rule that looks enforced and is not.
    const rule: Rule = {
      tool: 'issue_refund',
      field: 'customer.tier',
      // @ts-expect-error - gt is not available on a string field
      condition: { gt: 100 },
      action: 'require_approval',
    };
    expect(rule).toBeDefined();
  });

  it('does NOT catch a mistyped equals operand — a known limit of the loose field path', () => {
    /*
     * Documenting real behaviour rather than asserting a guarantee we do not
     * provide.
     *
     * `FieldPath` includes `(string & {})` so that depth-limited extraction
     * cannot reject a legitimately deeper path. That escape hatch produces a
     * union member where the path is an arbitrary string, so `ValueAtPath`
     * resolves to `unknown` and `equals` widens to accept anything. Any literal
     * that fits that member type-checks.
     *
     * Operator AVAILABILITY survives this, which is the catch worth having:
     * `{ gt: … }` does not exist on the loose member either, so numeric
     * comparisons on a string field are still rejected (see the test above).
     * Making this case an error would mean making `field` strict, which trades a
     * cosmetic mismatch — caught by zod at runtime — for false rejections of
     * valid deep paths.
     */
    const rule: Rule = {
      tool: 'issue_refund',
      field: 'amountUsd',
      condition: { equals: '100' },
      action: 'require_approval',
    };
    expect(rule.condition).toEqual({ equals: '100' });
  });
});

describe('Paths', () => {
  it('extracts top-level and nested keys', () => {
    type Extracted = Paths<{ a: string; b: { c: number } }>;
    const a: Extracted = 'a';
    const bc: Extracted = 'b.c';
    const b: Extracted = 'b';
    expect([a, b, bc]).toEqual(['a', 'b', 'b.c']);
  });

  it('resolves the type at a path', () => {
    type Input = { amountUsd: number; customer: { tier: string } };
    const amount: ValueAtPath<Input, 'amountUsd'> = 10;
    const tier: ValueAtPath<Input, 'customer.tier'> = 'gold';
    expect([amount, tier]).toEqual([10, 'gold']);
  });
});

describe('toRuntimeRule', () => {
  it('defaults severity rather than making the author state one', () => {
    expect(toRuntimeRule<Tools>({ tool: 'issue_refund', action: 'deny' })).toEqual({
      tool: 'issue_refund',
      action: 'deny',
      severity: 'medium',
    });
  });

  it('preserves an explicit severity, field, condition and reason', () => {
    expect(
      toRuntimeRule<Tools>({
        tool: 'issue_refund',
        field: 'amountUsd',
        condition: { gt: 500 },
        action: 'require_approval',
        severity: 'high',
        reason: 'Large refunds need a human',
      }),
    ).toEqual({
      tool: 'issue_refund',
      field: 'amountUsd',
      condition: { gt: 500 },
      action: 'require_approval',
      severity: 'high',
      reason: 'Large refunds need a human',
    });
  });

  it('omits absent optionals rather than emitting undefined values', () => {
    // These cross the wire as JSON; `{"field": undefined}` would serialise to a
    // missing key anyway, but an explicit undefined breaks `in` checks and
    // strict schema round-tripping on the way back.
    const runtime = toRuntimeRule<Tools>({ tool: '*', action: 'deny' });
    expect(Object.keys(runtime).sort()).toEqual(['action', 'severity', 'tool']);
  });
});

describe('an agent with no declared tools', () => {
  it('falls back to accepting any tool name', () => {
    // Policies can target tools registered by another process, so `never` here
    // would make every rule uncompilable.
    type Untyped = PolicyRule<Record<string, never>>;
    const rule: Untyped = { tool: 'anything_at_all', action: 'deny' };
    expect(rule.tool).toBe('anything_at_all');
  });
});
