import { describe, it, expect } from 'vitest';
import { AGENT_ID_PATTERN, generateAgentSlug } from './types.js';

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
