/**
 * Demo skills (AI SDK tools) for this reference server. These are NOT part
 * of @driftwatch/sdk — the SDK's runAgentTask takes `tools` as a parameter
 * precisely so real deployments bring their own (DB lookups, HTTP calls,
 * vector search, ...). This file shows the pattern: each tool's `execute` is
 * wrapped by `runtime.skill(name, fn)`, which supplies the SDK's labelled
 * tool-call counter + latency histogram AND the pre-execution policy gate.
 *
 * Each entry is a FACTORY (runtime) => Tool, not a built Tool — a Tool's
 * `execute` closure is already constructed by the time a flat registry object
 * exists, so there's no way to inject per-call agent context into an
 * already-built Tool from outside. Building fresh per request (cheap — no
 * I/O, just object construction) is what lets the span and the policy gate
 * see which agent is calling, and is also what makes `buildAgentTools` below
 * able to filter by AgentDefinition.toolNames.
 *
 * Note the split of responsibilities: the SDK owns "wrap ONE tool with this
 * agent's context" (`runtime.skill`), while filtering a shared catalogue down
 * to the subset one agent may call stays here, because a registry of named
 * tools is this server's concern — a typical SDK consumer just writes their
 * tools inline and has nothing to filter.
 */
import { tool, type Tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { AgentRuntime } from '@driftwatch/sdk';

function simulateLatency(minimumMs: number, maximumMs: number): Promise<void> {
  const delayMs = minimumMs + Math.random() * (maximumMs - minimumMs);
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

const toolFactories: Record<string, (runtime: AgentRuntime) => Tool> = {
  get_weather: (runtime) =>
    tool({
      description: 'Get current weather for a city',
      inputSchema: z.object({
        city: z.string().describe('City name'),
      }),
      execute: runtime.skill('get_weather', async (input: { city: string }) => {
        // simulate variable latency so drift detection has signal to chew on
        await simulateLatency(50, 250);
        return { city: input.city, tempC: 20 + Math.round(Math.random() * 10) };
      }),
    }),

  search_docs: (runtime) =>
    tool({
      description: 'Search internal documentation for a query',
      inputSchema: z.object({
        query: z.string().describe('Search query'),
      }),
      execute: runtime.skill('search_docs', async (input: { query: string }) => {
        await simulateLatency(30, 150);
        return { query: input.query, hits: Math.floor(Math.random() * 5) };
      }),
    }),
};

/** Every tool name this server knows about — the validation set for agent registration/edit. */
export const allToolNames = Object.keys(toolFactories);

/**
 * Builds the ToolSet for one agent's run: `toolNames` filters which tools it
 * gets (omit = every registered tool, today's pre-fleet behavior); each tool
 * is constructed fresh against the supplied runtime, so its execute() carries
 * that agent's identity and tool-call policies.
 */
export function buildAgentTools(options: {
  runtime: AgentRuntime;
  toolNames?: string[];
}): ToolSet {
  const { runtime, toolNames } = options;
  const selected = toolNames ?? allToolNames;
  const result: ToolSet = {};
  for (const name of selected) {
    const factory = toolFactories[name];
    if (factory) result[name] = factory(runtime);
  }
  return result;
}
