/**
 * Inline guardrails — Loop 1 of DriftWatch's two control loops.
 *
 * These run *synchronously, inside a single agent run*, so a runaway request
 * (a prompt that loops the model into burning tokens) is halted the moment it
 * crosses a per-task budget — long before the aggregate drift loop (Loop 2,
 * see ../drift/detector.ts) could ever notice.
 *
 * Pure and dependency-light on purpose: this module reads no env and does no
 * I/O. The caller threads an `AgentGuardrails` (built from AgentConfig) into
 * `runAgentTask`.
 */
import { type StopCondition, type ToolSet, type LanguageModelUsage } from 'ai';

export interface AgentGuardrails {
  /** Abort once cumulative tokens cross this cap. 0 disables the check. */
  maxTokensPerTask: number;
  /** Abort once estimated USD cost crosses this cap. 0 disables the check. */
  maxCostUsd: number;
  pricePer1kInput: number;
  pricePer1kOutput: number;
  /** 'stop' halts the loop at the breach; 'flag' finishes but marks it. */
  onExceed: 'stop' | 'flag';
}

export interface CumulativeUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface GuardrailBreach {
  breached: boolean;
  reason?: string;
}

/** Estimate USD cost from cumulative usage and the configured per-1k prices. */
export function estimateCostUsd(
  usage: CumulativeUsage,
  guardrails: AgentGuardrails,
): number {
  return (
    (usage.inputTokens / 1000) * guardrails.pricePer1kInput +
    (usage.outputTokens / 1000) * guardrails.pricePer1kOutput
  );
}

/**
 * Decide whether the given cumulative usage has crossed any enabled cap.
 * A cap of 0 means "not configured" and is skipped.
 */
export function evaluateGuardrailBreach(
  usage: CumulativeUsage,
  guardrails: AgentGuardrails,
): GuardrailBreach {
  if (
    guardrails.maxTokensPerTask > 0 &&
    usage.totalTokens >= guardrails.maxTokensPerTask
  ) {
    return {
      breached: true,
      reason: `token budget exceeded: ${usage.totalTokens} >= ${guardrails.maxTokensPerTask}`,
    };
  }

  if (guardrails.maxCostUsd > 0) {
    const costUsd = estimateCostUsd(usage, guardrails);
    if (costUsd >= guardrails.maxCostUsd) {
      return {
        breached: true,
        reason: `cost budget exceeded: $${costUsd.toFixed(4)} >= $${guardrails.maxCostUsd}`,
      };
    }
  }

  return { breached: false };
}

/** Sum usage across every step the model has taken so far. */
export function sumStepUsage(
  steps: ReadonlyArray<{ usage?: LanguageModelUsage }>,
): CumulativeUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  for (const step of steps) {
    const stepInput = step.usage?.inputTokens ?? 0;
    const stepOutput = step.usage?.outputTokens ?? 0;
    inputTokens += stepInput;
    outputTokens += stepOutput;
    totalTokens += step.usage?.totalTokens ?? stepInput + stepOutput;
  }
  return { inputTokens, outputTokens, totalTokens };
}

/**
 * Build the `stopWhen` conditions that enforce the token/cost caps mid-loop.
 * Only meaningful under `onExceed: 'stop'`; under `'flag'` the run is allowed
 * to complete and the breach is reported after the fact (see runner.ts).
 * Returns an empty array when no cap is enabled.
 */
export function buildTokenBudgetStopConditions(
  guardrails: AgentGuardrails,
): StopCondition<ToolSet>[] {
  const hasEnabledCap =
    guardrails.maxTokensPerTask > 0 || guardrails.maxCostUsd > 0;
  if (guardrails.onExceed !== 'stop' || !hasEnabledCap) return [];

  return [
    ({ steps }) => evaluateGuardrailBreach(sumStepUsage(steps), guardrails).breached,
  ];
}
