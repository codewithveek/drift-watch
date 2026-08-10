/**
 * `createAgentRuntime` — optional ergonomic layer over the SDK's primitives.
 *
 * Everything here is sugar. `runAgentTask`, `withSkillExecutionSpan`,
 * `gateToolCall`, `resolveAgentConfig` and `resolveToolCallPolicies` remain
 * public and fully usable on their own — the reference server deliberately
 * still uses them directly, because it has concerns this layer shouldn't
 * absorb (404-on-unknown-agent, model switching, dual source lookups).
 *
 * What it removes is plumbing, not decisions. Wiring one gated tool by hand
 * means repeating `agentId` on the span and on the gate, repeating the tool's
 * name in two places that must match exactly (a silent-policy-miss footgun if
 * they drift apart), and re-spreading a resolved `AgentConfig` into the
 * near-identical `AgentGuardrails` shape. Binding the agent context once
 * makes all of that structural.
 *
 * ## Static vs. live agent definitions
 *
 * `agent` accepts either a definition or a function returning one:
 *
 *   createAgentRuntime({ agent: myDefinition })                        // static
 *   createAgentRuntime({ agent: () => store.getAgentDefinition(id) })  // live
 *
 * This is deliberately explicit rather than inferred. A snapshot is right for
 * an embedded agent whose config is fixed at startup — no store required, no
 * per-run I/O. A resolver is right when a control plane can edit guardrails or
 * tool policies at runtime, and you need the next run to pick that up. Making
 * it a visible choice at the call site avoids the trap of an API that looks
 * live but silently froze at construction.
 */
import type { ToolSet } from 'ai';
import type { ModelClient } from '../model-client.js';
import type { DriftWatchConfig } from '../config/schema.js';
import { resolveAgentConfig, toAgentGuardrails } from '../config/schema.js';
import type { AgentDefinition, StateStore } from '../autopilot/types.js';
import { resolveToolCallPolicies } from '../autopilot/types.js';
import type { NotifierRegistry, DispatchLogger } from '../autopilot/notify-dispatch.js';
import { gateToolCall } from '../autopilot/tool-call-gate.js';
import { withSkillExecutionSpan } from '../telemetry/instrument.js';
import { runAgentTask, type AgentTaskResult } from './runner.js';

/** A definition, or a function resolving one per run (see the module docblock). */
export type AgentSource =
  | AgentDefinition
  | (() => AgentDefinition | Promise<AgentDefinition>);

export interface CreateAgentRuntimeOptions {
  agent: AgentSource;
  /** Deployment-wide defaults the agent's own `guardrails` merge over. */
  config: DriftWatchConfig;
  /**
   * Needed only if a `require_approval` tool policy can fire, and to resolve
   * a `guardrailsSource` / `toolPoliciesSource` reference. Omit entirely for a
   * self-contained agent with no control plane.
   */
  store?: StateStore;
  notifiers?: NotifierRegistry;
  /** Defaults to 120s — how long a gated tool call waits for a human. */
  approvalTimeoutMs?: number;
  /** Defaults to 'rejected' (fail closed). */
  timeoutDecision?: 'approved' | 'rejected';
  logger?: DispatchLogger;
}

/** The AI SDK passes this as `execute`'s second argument. */
export interface SkillCallOptions {
  abortSignal?: AbortSignal;
}

export interface RunOptions {
  prompt: string;
  modelClient: ModelClient;
  tools: ToolSet;
  /** Overrides the resolved `maxSteps` for this one run. */
  maxSteps?: number;
}

export interface AgentRuntime {
  /**
   * Wraps a tool's `execute` with this agent's telemetry span and policy gate.
   * Drop it straight into the AI SDK's own `tool()` so its schema inference is
   * completely untouched:
   *
   *   issue_refund: tool({
   *     description: 'Issue a refund',
   *     inputSchema: z.object({ orderId: z.string(), amountUsd: z.number() }),
   *     execute: runtime.skill('issue_refund', async (input) => ({ ok: true })),
   *   })
   *
   * The name is given once and drives both the span and policy matching, so
   * they can't drift apart.
   */
  skill<Input, Output>(
    name: string,
    execute: (input: Input) => Promise<Output>,
  ): (input: Input, options?: SkillCallOptions) => Promise<Output>;
  /** Runs a task with this agent's resolved config, guardrails and identity. */
  run(options: RunOptions): Promise<AgentTaskResult>;
  /** The agent definition as of now — resolves the source if it's a function. */
  resolveAgent(): Promise<AgentDefinition>;
}

export function createAgentRuntime(options: CreateAgentRuntimeOptions): AgentRuntime {
  const {
    agent: agentSource,
    config,
    store,
    notifiers,
    approvalTimeoutMs,
    timeoutDecision,
    logger,
  } = options;

  async function resolveAgent(): Promise<AgentDefinition> {
    return typeof agentSource === 'function' ? await agentSource() : agentSource;
  }

  /**
   * Looks up a single-hop reference field. Returns undefined when there's no
   * reference or no store to resolve it with — resolution then simply falls
   * back to the agent's own values, which is the correct degradation.
   */
  async function resolveReferenced(refId: string | undefined): Promise<AgentDefinition | undefined> {
    if (!refId || !store) return undefined;
    return store.getAgentDefinition(refId);
  }

  return {
    resolveAgent,

    skill(name, executeSkill) {
      return async (input, toolCallOptions) => {
        // Resolve identity + policies BEFORE the span starts. Two reasons: the
        // span/metrics need the real agent id (resolving inside would be too
        // late to label them), and a live agent source means a store
        // round-trip here that must not be counted as tool execution time —
        // agent.tool.duration feeds the drift detector's p95 signal.
        const agent = await resolveAgent();
        const rules = resolveToolCallPolicies(
          agent,
          await resolveReferenced(agent.toolPoliciesSource),
        );

        return withSkillExecutionSpan({
          skillName: name,
          skillInput: input,
          agentId: agent.id,
          serviceName: agent.serviceName,
          executeSkill: async () => executeSkill(input),
          // No rules -> no gate closure at all, so an ungated agent pays
          // nothing for the feature existing.
          policyGate:
            rules.length > 0
              ? (skillInput) =>
                  gateToolCall({
                    tool: name,
                    input: skillInput,
                    agentId: agent.id,
                    rules,
                    store,
                    notifiers,
                    approvalTimeoutMs,
                    timeoutDecision,
                    abortSignal: toolCallOptions?.abortSignal,
                    logger,
                  })
              : undefined,
        });
      };
    },

    async run({ prompt, modelClient, tools, maxSteps }) {
      const agent = await resolveAgent();
      const resolved = resolveAgentConfig(
        agent,
        config,
        await resolveReferenced(agent.guardrailsSource),
      );

      return runAgentTask({
        prompt,
        modelClient,
        tools,
        maxSteps: maxSteps ?? resolved.maxSteps,
        // Derived from the resolved config rather than hand-spread by the
        // caller — this mapping is mechanical and has no decisions in it.
        guardrails: toAgentGuardrails(resolved),
        agentId: agent.id,
        serviceName: agent.serviceName,
      });
    },
  };
}
