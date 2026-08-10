import { describe, it, expect } from 'vitest';
import { AGENT_ID_PATTERN, generateAgentSlug, resolveToolCallPolicies, type AgentDefinition } from './types.js';
import type { ToolCallPolicyRule } from './tool-call-policy.js';

describe('generateAgentSlug', () => {
  it('slugifies the name and appends a 6-hex-char suffix', () => {
    expect(generateAgentSlug('Payment Agent')).toMatch(/^payment-agent-[0-9a-f]{6}$/);
  });

  it('produces a different id on each call for the same name (collision avoidance)', () => {
    const first = generateAgentSlug('Payment Agent');
    const second = generateAgentSlug('Payment Agent');
    expect(first).not.toBe(second);
  });

  it('falls back to just the suffix when the name slugifies to nothing', () => {
    const slug = generateAgentSlug('!!!');
    expect(slug).toMatch(/^[0-9a-f]{6}$/);
  });

  it('always matches AGENT_ID_PATTERN', () => {
    expect(AGENT_ID_PATTERN.test(generateAgentSlug('Finance Reconciliation Agent (v2)'))).toBe(true);
    expect(AGENT_ID_PATTERN.test(generateAgentSlug('日本語 Agent'))).toBe(true);
  });

  it('caps the slugified name portion at 40 characters before the suffix', () => {
    const longName = 'a'.repeat(100);
    const slug = generateAgentSlug(longName);
    // 40 chars of 'a' + '-' + 6 hex chars
    expect(slug).toMatch(/^a{40}-[0-9a-f]{6}$/);
  });
});

function agent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return { id: 'agent-1', name: 'Agent One', createdAt: 0, ...overrides };
}

function policy(overrides: Partial<ToolCallPolicyRule> & Pick<ToolCallPolicyRule, 'tool' | 'action'>): ToolCallPolicyRule {
  return { condition: {}, severity: 'medium', ...overrides };
}

describe('resolveToolCallPolicies', () => {
  it('returns an empty list when neither the agent nor a source has any policies', () => {
    expect(resolveToolCallPolicies(agent())).toEqual([]);
  });

  it('returns just the agent\'s own policies when there is no source', () => {
    const own = [policy({ tool: 'refund_payment', action: 'deny' })];
    expect(resolveToolCallPolicies(agent({ toolPolicies: own }))).toEqual(own);
  });

  it('returns just the source\'s policies when the agent has none of its own', () => {
    const sourcePolicies = [policy({ tool: 'refund_payment', action: 'require_approval' })];
    const source = agent({ id: 'source-agent', toolPolicies: sourcePolicies });
    expect(resolveToolCallPolicies(agent({ toolPoliciesSource: 'source-agent' }), source)).toEqual(
      sourcePolicies,
    );
  });

  it('unions the source\'s and the agent\'s own policies — both apply, not an override', () => {
    const sourcePolicies = [policy({ tool: 'refund_payment', action: 'require_approval' })];
    const ownPolicies = [policy({ tool: 'delete_account', action: 'deny' })];
    const source = agent({ id: 'source-agent', toolPolicies: sourcePolicies });
    const resolved = resolveToolCallPolicies(
      agent({ toolPoliciesSource: 'source-agent', toolPolicies: ownPolicies }),
      source,
    );
    expect(resolved).toEqual([...sourcePolicies, ...ownPolicies]);
  });

  it('is independent of guardrails resolution — a toolPoliciesSource does not imply anything about guardrails', () => {
    const source = agent({ id: 'source-agent', guardrails: { maxTokensPerTask: 999 } });
    const resolved = resolveToolCallPolicies(agent({ toolPoliciesSource: 'source-agent' }), source);
    // source has no toolPolicies, only guardrails — resolveToolCallPolicies must not pick those up
    expect(resolved).toEqual([]);
  });
});
