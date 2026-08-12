/**
 * Per-agent risk scoring for the fleet's "needs attention" ordering.
 *
 * This is a display-layer heuristic, not a control-plane decision — nothing is
 * gated on it. It exists so an operator opening the console sees the agent
 * worth looking at first, instead of an alphabetical list.
 *
 * The score is deliberately explainable: every point comes from a named signal
 * that is rendered next to the agent, so "High" is never something the UI just
 * asserts. If the ordering ever looks wrong, the reason is on screen.
 */
import type { AgentSummary } from '@/lib/fleet';

export type RiskLevel = 'low' | 'medium' | 'high';

export interface RiskSignal {
  label: string;
  weight: number;
}

export interface RiskAssessment {
  score: number;
  level: RiskLevel;
  /** Heaviest first — the list is truncated in tight layouts. */
  signals: RiskSignal[];
}

const DAY_MS = 86_400_000;

/**
 * Weights, in the order an operator would rank the same facts by hand.
 *
 * A gated tool call outranks everything because it is holding a live HTTP
 * request open: every second it waits is latency the agent's caller is paying.
 * A control approval is urgent but not blocking. Drift is a trend signal, so it
 * only counts inside a 24h window — a high-severity verdict from last week says
 * something about last week.
 */
const WEIGHT = {
  pendingToolCall: 3,
  pendingApproval: 2,
  recentHighVerdict: 3,
  recentMediumVerdict: 1,
  paused: 2,
  throttled: 1,
} as const;

const THRESHOLD = { high: 6, medium: 2 } as const;

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

export function assessRisk(agent: AgentSummary, now: number = Date.now()): RiskAssessment {
  const signals: RiskSignal[] = [];

  if (agent.pendingToolCalls > 0) {
    signals.push({
      label: `${plural(agent.pendingToolCalls, 'tool call')} blocking a live request`,
      weight: agent.pendingToolCalls * WEIGHT.pendingToolCall,
    });
  }

  if (agent.pendingApprovals > 0) {
    signals.push({
      label: `${plural(agent.pendingApprovals, 'control action')} awaiting approval`,
      weight: agent.pendingApprovals * WEIGHT.pendingApproval,
    });
  }

  const recent = agent.history.filter((entry) => now - entry.at <= DAY_MS);
  const high = recent.filter((entry) => entry.severity === 'high').length;
  const medium = recent.filter((entry) => entry.severity === 'medium').length;

  if (high > 0) {
    signals.push({
      label: `${plural(high, 'high-severity verdict')} in 24h`,
      weight: high * WEIGHT.recentHighVerdict,
    });
  }
  if (medium > 0) {
    signals.push({
      label: `${plural(medium, 'medium-severity verdict')} in 24h`,
      weight: medium * WEIGHT.recentMediumVerdict,
    });
  }

  if (agent.state.status === 'paused') {
    signals.push({ label: 'Paused — not serving traffic', weight: WEIGHT.paused });
  } else if (agent.state.status === 'throttled') {
    signals.push({ label: 'Throttled', weight: WEIGHT.throttled });
  }

  signals.sort((a, b) => b.weight - a.weight);
  const score = signals.reduce((sum, signal) => sum + signal.weight, 0);

  return {
    score,
    level: score >= THRESHOLD.high ? 'high' : score >= THRESHOLD.medium ? 'medium' : 'low',
    signals,
  };
}

/** Fleet ordered by risk, heaviest first. Ties keep registration order stable. */
export function byRiskDescending(
  agents: readonly AgentSummary[],
  now: number = Date.now(),
): { agent: AgentSummary; risk: RiskAssessment }[] {
  return agents
    .map((agent) => ({ agent, risk: assessRisk(agent, now) }))
    .sort((a, b) => b.risk.score - a.risk.score);
}
