import { describe, it, expect } from 'vitest';
import { allToolNames, buildAgentTools } from './tools.js';

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
});
