/**
 * Demo skills (AI SDK tools) for this reference server. These are NOT part
 * of @driftwatch/sdk — the SDK's runAgentTask takes `tools` as a parameter
 * precisely so real deployments bring their own (DB lookups, HTTP calls,
 * vector search, ...). This file shows the pattern: `tool()` wrapping
 * `withSkillExecutionSpan` so every call still emits the SDK's labelled
 * tool-call counter + latency histogram, and (when a per-agent tool-call
 * policy is configured) `withSkillExecutionSpan`'s `policyGate` hook so a
 * call can be denied or paused for approval before it ever runs.
 *
 * Each entry is a FACTORY (agentId, serviceName, policyGate?) => Tool, not a
 * built Tool — a Tool's `execute` closure is already constructed by the time
 * a flat registry object exists, so there's no way to inject per-call agent
 * context into an already-built Tool from outside. Building fresh per
 * request (cheap — no I/O, just object construction) is what lets
 * withSkillExecutionSpan see which agent is calling it, and is also what
 * makes `buildAgentTools` below able to filter by AgentDefinition.toolNames.
 */
import { tool, type Tool, type ToolSet } from 'ai';
import { z } from 'zod';
import {
  withSkillExecutionSpan,
  gateToolCall,
  type ToolCallPolicyRule,
  type StateStore,
  type NotifierRegistry,
} from '@driftwatch/sdk';

function simulateLatency(minimumMs: number, maximumMs: number): Promise<void> {
  const delayMs = minimumMs + Math.random() * (maximumMs - minimumMs);
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

type PolicyGate = (skillInput: unknown, abortSignal?: AbortSignal) => Promise<{ allowed: boolean; reason?: string }>;

const toolFactories: Record<
  string,
  (agentId: string, serviceName: string | undefined, policyGate: PolicyGate | undefined) => Tool
> = {
  get_weather: (agentId, serviceName, policyGate) =>
    tool({
      description: 'Get current weather for a city',
      inputSchema: z.object({
        city: z.string().describe('City name'),
      }),
      execute: (skillInput, toolCallOptions) =>
        withSkillExecutionSpan({
          skillName: 'get_weather',
          skillInput,
          agentId,
          serviceName,
          policyGate: policyGate
            ? (input) => policyGate(input, toolCallOptions?.abortSignal)
            : undefined,
          executeSkill: async () => {
            // simulate variable latency so drift detection has signal to chew on
            await simulateLatency(50, 250);
            return {
              city: skillInput.city,
              tempC: 20 + Math.round(Math.random() * 10),
            };
          },
        }),
    }),

  search_docs: (agentId, serviceName, policyGate) =>
    tool({
      description: 'Search internal documentation for a query',
      inputSchema: z.object({
        query: z.string().describe('Search query'),
      }),
      execute: (skillInput, toolCallOptions) =>
        withSkillExecutionSpan({
          skillName: 'search_docs',
          skillInput,
          agentId,
          serviceName,
          policyGate: policyGate
            ? (input) => policyGate(input, toolCallOptions?.abortSignal)
            : undefined,
          executeSkill: async () => {
            await simulateLatency(30, 150);
            return {
              query: skillInput.query,
              hits: Math.floor(Math.random() * 5),
            };
          },
        }),
    }),
};

/** Every tool name this server knows about — the validation set for agent registration/edit. */
export const allToolNames = Object.keys(toolFactories);

export interface PolicyGateContext {
  toolPolicies: ToolCallPolicyRule[];
  store: StateStore;
  notifiers: NotifierRegistry;
  approvalTimeoutMs: number;
  timeoutDecision: 'approved' | 'rejected';
}

/**
 * Builds the ToolSet for one agent's run: `toolNames` filters which tools it
 * gets (omit = every registered tool, today's pre-fleet behavior); each
 * tool is constructed fresh so its execute() carries this specific
 * agentId/serviceName into withSkillExecutionSpan. `policyGateContext` is
 * omitted (or has an empty `toolPolicies`) for the common case of an agent
 * with no configured tool-call policies — zero extra work per call then.
 */
export function buildAgentTools(options: {
  toolNames?: string[];
  agentId: string;
  serviceName?: string;
  policyGateContext?: PolicyGateContext;
}): ToolSet {
  const { toolNames, agentId, serviceName, policyGateContext } = options;
  const selected = toolNames ?? allToolNames;
  const result: ToolSet = {};
  for (const name of selected) {
    const factory = toolFactories[name];
    if (!factory) continue;
    const policyGate: PolicyGate | undefined =
      policyGateContext && policyGateContext.toolPolicies.length > 0
        ? (input, abortSignal) =>
            gateToolCall({
              tool: name,
              input,
              agentId,
              rules: policyGateContext.toolPolicies,
              store: policyGateContext.store,
              notifiers: policyGateContext.notifiers,
              approvalTimeoutMs: policyGateContext.approvalTimeoutMs,
              timeoutDecision: policyGateContext.timeoutDecision,
              abortSignal,
            })
        : undefined;
    result[name] = factory(agentId, serviceName, policyGate);
  }
  return result;
}
