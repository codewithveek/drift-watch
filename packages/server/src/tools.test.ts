import { describe, it, expect, vi } from 'vitest';
import { allToolNames, buildAgentTools } from './tools.js';
import type { StateStore, NotifierRegistry } from '@driftwatch/sdk';

function fakePolicyGateContext(overrides: Partial<Parameters<typeof buildAgentTools>[0]['policyGateContext']> = {}) {
  const store = { getAgentDefinition: vi.fn(async () => undefined) } as unknown as StateStore;
  const notifiers: NotifierRegistry = { list: [] };
  return {
    toolPolicies: [],
    store,
    notifiers,
    approvalTimeoutMs: 1000,
    timeoutDecision: 'rejected' as const,
    ...overrides,
  };
}

describe('allToolNames', () => {
  it('lists the known tools', () => {
    expect(allToolNames).toEqual(['get_weather', 'search_docs']);
  });
});

describe('buildAgentTools', () => {
  it('returns only the requested tools when toolNames is given', () => {
    const tools = buildAgentTools({ toolNames: ['get_weather'], agentId: 'agent-1' });
    expect(Object.keys(tools)).toEqual(['get_weather']);
  });

  it('returns every registered tool when toolNames is omitted', () => {
    const tools = buildAgentTools({ agentId: 'agent-1' });
    expect(Object.keys(tools).sort()).toEqual([...allToolNames].sort());
  });

  it('silently skips unknown tool names rather than throwing', () => {
    const tools = buildAgentTools({ toolNames: ['get_weather', 'not_a_real_tool'], agentId: 'agent-1' });
    expect(Object.keys(tools)).toEqual(['get_weather']);
  });

  it('builds a fresh ToolSet per call (not a shared/cached object)', () => {
    const first = buildAgentTools({ agentId: 'agent-1' });
    const second = buildAgentTools({ agentId: 'agent-2' });
    expect(first.get_weather).not.toBe(second.get_weather);
  });

  it('a tool call succeeds normally when policyGateContext is omitted', async () => {
    const tools = buildAgentTools({ agentId: 'agent-1' });
    const result = await tools.get_weather.execute!({ city: 'Lagos' }, {} as never);
    expect(result).toMatchObject({ city: 'Lagos' });
  });

  it('a tool call succeeds normally when toolPolicies is empty (no policyGate built at all)', async () => {
    const tools = buildAgentTools({ agentId: 'agent-1', policyGateContext: fakePolicyGateContext() });
    const result = await tools.get_weather.execute!({ city: 'Lagos' }, {} as never);
    expect(result).toMatchObject({ city: 'Lagos' });
  });

  it('a deny rule makes the built tool throw instead of executing', async () => {
    const tools = buildAgentTools({
      agentId: 'agent-1',
      policyGateContext: fakePolicyGateContext({
        toolPolicies: [{ tool: 'get_weather', condition: {}, action: 'deny', severity: 'medium', reason: 'blocked' }],
      }),
    });
    await expect(tools.get_weather.execute!({ city: 'Lagos' }, {} as never)).rejects.toThrow('blocked');
  });

  it('a policy scoped to a different tool leaves this tool unaffected', async () => {
    const tools = buildAgentTools({
      agentId: 'agent-1',
      policyGateContext: fakePolicyGateContext({
        toolPolicies: [{ tool: 'search_docs', condition: {}, action: 'deny', severity: 'medium' }],
      }),
    });
    const result = await tools.get_weather.execute!({ city: 'Lagos' }, {} as never);
    expect(result).toMatchObject({ city: 'Lagos' });
  });
});
