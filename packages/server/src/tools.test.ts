import { describe, it, expect } from 'vitest';
import {
  createAgentRuntime,
  DriftWatchConfigSchema,
  MemoryStateStore,
  type AgentDefinition,
  type ToolCallPolicyRule,
} from '@driftwatch/sdk';
import { allToolNames, buildAgentTools } from './tools.js';

const config = DriftWatchConfigSchema.parse({});

function runtimeFor(overrides: Partial<AgentDefinition> = {}) {
  const agent: AgentDefinition = { id: 'agent-1', name: 'Agent One', createdAt: 0, ...overrides };
  return createAgentRuntime({ agent, config, store: new MemoryStateStore() });
}

const denyWeather: ToolCallPolicyRule[] = [
  { tool: 'get_weather', action: 'deny', severity: 'medium', reason: 'blocked' },
];

describe('allToolNames', () => {
  it('lists the known tools', () => {
    expect(allToolNames).toEqual(['get_weather', 'search_docs']);
  });
});

describe('buildAgentTools', () => {
  it('returns only the requested tools when toolNames is given', () => {
    const tools = buildAgentTools({ runtime: runtimeFor(), toolNames: ['get_weather'] });
    expect(Object.keys(tools)).toEqual(['get_weather']);
  });

  it('returns every registered tool when toolNames is omitted', () => {
    const tools = buildAgentTools({ runtime: runtimeFor() });
    expect(Object.keys(tools).sort()).toEqual([...allToolNames].sort());
  });

  it('silently skips unknown tool names rather than throwing', () => {
    const tools = buildAgentTools({
      runtime: runtimeFor(),
      toolNames: ['get_weather', 'not_a_real_tool'],
    });
    expect(Object.keys(tools)).toEqual(['get_weather']);
  });

  it('builds a fresh ToolSet per call (not a shared/cached object)', () => {
    const first = buildAgentTools({ runtime: runtimeFor() });
    const second = buildAgentTools({ runtime: runtimeFor({ id: 'agent-2' }) });
    expect(first.get_weather).not.toBe(second.get_weather);
  });

  it('a tool executes normally for an agent with no tool policies', async () => {
    const tools = buildAgentTools({ runtime: runtimeFor() });
    const result = await tools.get_weather.execute!({ city: 'Lagos' }, {} as never);
    expect(result).toMatchObject({ city: 'Lagos' });
  });

  it('a deny rule makes the built tool throw instead of executing', async () => {
    const tools = buildAgentTools({ runtime: runtimeFor({ toolPolicies: denyWeather }) });
    await expect(tools.get_weather.execute!({ city: 'Lagos' }, {} as never)).rejects.toThrow(
      'blocked',
    );
  });

  it('a policy scoped to a different tool leaves this tool unaffected', async () => {
    const tools = buildAgentTools({
      runtime: runtimeFor({
        toolPolicies: [{ tool: 'search_docs', action: 'deny', severity: 'medium' }],
      }),
    });
    const result = await tools.get_weather.execute!({ city: 'Lagos' }, {} as never);
    expect(result).toMatchObject({ city: 'Lagos' });
  });
});
