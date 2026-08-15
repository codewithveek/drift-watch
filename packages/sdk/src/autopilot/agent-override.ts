/**
 * Layered agent configuration: a code-declared baseline, plus console-authored
 * overrides that win.
 *
 * ## The problem this solves
 *
 * Once an SDK client declares guardrails and tool policies in code AND the
 * console can edit them, there are two writers on one value — the classic
 * infrastructure-as-code drift problem, and getting it wrong is what makes
 * people stop trusting a tool. The three available answers:
 *
 *   - *Code wins.* Every redeploy resets to what is in code. Simple, GitOps-
 *     friendly, and it retires the live-editing capability entirely: an operator
 *     tightening a spend cap during an incident would have it silently reverted
 *     by the next deploy.
 *   - *Console wins after first registration.* Live edits survive, but changing
 *     a guardrail in code then does nothing, with no feedback. The failure is
 *     invisible and extremely hard to debug.
 *   - *Layered* (this module). Code declares the baseline, console edits are
 *     stored separately and take precedence, and the UI can show "overridden
 *     from code" with a revert button. Both writers keep working and neither
 *     silently loses.
 *
 * ## Why overrides are stored per-field, not as a merged blob
 *
 * Only the fields an operator actually changed are present. That is what lets
 * resolution distinguish "explicitly set to none" from "not overridden" — a
 * single merged record could not, and `toolPolicies: []` (deliberately ungate
 * this agent) would be indistinguishable from "no opinion", which is the
 * difference between a gate and no gate.
 *
 * Clearing the whole override is "revert to code": a delete, not a diff.
 */
import type { AgentConfig } from '../config/schema.js';
import type { ToolCallPolicyRule } from './tool-call-policy.js';
import type { AgentDefinition } from './types.js';

/**
 * Console-authored edits layered over an agent's code-declared baseline.
 *
 * Every configuration field is optional and absent means "not overridden".
 * Identity fields (`name`, `owner`, `serviceName`) are deliberately NOT here —
 * they are descriptive rather than governing, nobody needs to change an agent's
 * name mid-incident, and keeping them on the baseline means the registry's
 * identity has exactly one writer.
 */
export interface AgentOverride {
  agentId: string;
  guardrails?: Partial<AgentConfig>;
  toolNames?: string[];
  toolPolicies?: ToolCallPolicyRule[];
  driftDetectionEnabled?: boolean;
  updatedAt: number;
  /** Principal id that made the edit. Joins to the audit log. */
  updatedBy: string;
}

/** Fields an override may carry, in the order the console shows them. */
export const OVERRIDABLE_FIELDS = [
  'guardrails',
  'toolNames',
  'toolPolicies',
  'driftDetectionEnabled',
] as const;

export type OverridableField = (typeof OVERRIDABLE_FIELDS)[number];

/**
 * Applies an override to a baseline, producing the agent definition everything
 * downstream should actually use.
 *
 * `guardrails` merges per-field so overriding `maxCostUsd` does not silently
 * discard a `maxSteps` the code declared. `toolPolicies` and `toolNames`
 * REPLACE wholesale, because a list composes by "which entries apply" — merging
 * two rule lists would make it impossible to remove a rule, and merging two
 * allow-lists would make it impossible to narrow one, which is the direction
 * that matters for a security control.
 */
export function applyAgentOverride(
  baseline: AgentDefinition,
  override: AgentOverride | undefined,
): AgentDefinition {
  if (!override) return baseline;
  return {
    ...baseline,
    ...(override.guardrails !== undefined
      ? { guardrails: { ...baseline.guardrails, ...override.guardrails } }
      : {}),
    ...(override.toolNames !== undefined ? { toolNames: override.toolNames } : {}),
    ...(override.toolPolicies !== undefined ? { toolPolicies: override.toolPolicies } : {}),
    ...(override.driftDetectionEnabled !== undefined
      ? { driftDetectionEnabled: override.driftDetectionEnabled }
      : {}),
  };
}

/**
 * Which fields an override is currently changing.
 *
 * Drives the console's "overridden from code" markers. Returned in
 * OVERRIDABLE_FIELDS order rather than object-key order so the UI is stable
 * across edits.
 */
export function overriddenFields(override: AgentOverride | undefined): OverridableField[] {
  if (!override) return [];
  return OVERRIDABLE_FIELDS.filter((field) => override[field] !== undefined);
}

/**
 * True when an override no longer changes anything and should be deleted rather
 * than stored.
 *
 * A row of all-undefined fields would keep an agent marked "overridden" in the
 * console forever while having no effect — the state that makes an operator
 * distrust the badge.
 */
export function isEmptyOverride(override: AgentOverride): boolean {
  return overriddenFields(override).length === 0;
}
