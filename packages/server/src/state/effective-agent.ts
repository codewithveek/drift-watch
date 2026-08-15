/**
 * The one way to read an agent's configuration as it is ACTUALLY in force.
 *
 * `StateStore.getAgentDefinition` returns the code-declared baseline; console
 * edits live in a separate override record. Everything that acts on an agent's
 * configuration — running a task, gating a tool call, scanning for drift,
 * rendering the console — must read the two layered together, or the system
 * quietly disagrees with itself: an operator tightens a spend cap during an
 * incident, the console shows it applied, and the next run ignores it because
 * that path happened to read the baseline directly.
 *
 * Hence a single named helper rather than an `applyAgentOverride` call at each
 * site: the failure mode of forgetting one is invisible, and grepping for this
 * function is how you audit that nothing reads the baseline by accident.
 *
 * The baseline remains directly readable, deliberately, for the two callers
 * that genuinely want it: the edit form (which must show what the CODE says, so
 * an operator can see what they are overriding) and the sync endpoint (which
 * writes it).
 */
import { applyAgentOverride, type AgentDefinition, type StateStore } from '@driftwatch/sdk';

/** The agent with overrides applied, or undefined when it is not registered. */
export async function getEffectiveAgent(
  store: StateStore,
  agentId: string,
): Promise<AgentDefinition | undefined> {
  const baseline = await store.getAgentDefinition(agentId);
  if (!baseline) return undefined;
  return applyAgentOverride(baseline, await store.getAgentOverride(agentId));
}

/**
 * Every registered agent, with overrides applied.
 *
 * Fetches overrides concurrently rather than in a loop — a fleet-wide drift
 * cycle calls this on every tick, and serialising one round-trip per agent
 * would make the scan time grow linearly with fleet size for no reason.
 */
export async function listEffectiveAgents(store: StateStore): Promise<AgentDefinition[]> {
  const baselines = await store.listAgents();
  const overrides = await Promise.all(
    baselines.map((baseline) => store.getAgentOverride(baseline.id)),
  );
  return baselines.map((baseline, index) => applyAgentOverride(baseline, overrides[index]));
}
