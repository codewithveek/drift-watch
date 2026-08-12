import type { AgentStatus, Approval, ToolCallApproval } from '@/api';
import type { FleetSummary } from '@/lib/fleet';

/**
 * The decision queue.
 *
 * Both kinds of pending item — a gated tool call (Loop 3) and a proposed
 * control action (Loop 2) — are modelled as one list because an operator
 * triaging by urgency does not care which mechanism produced an item; they
 * care what expires first. Keeping them as a discriminated union rather than
 * flattening into a common record preserves the fields that make each kind
 * reviewable, which is the whole job of the review panel.
 */

/** Just enough agent identity for the queue to render and link. */
export interface QueueAgent {
  id: string;
  name: string;
  status: AgentStatus;
}

export type QueueItem =
  | { kind: 'toolCall'; agent: QueueAgent; item: ToolCallApproval }
  | { kind: 'approval'; agent: QueueAgent; item: Approval };

/** Stable identity across revalidations, so the open sheet survives a refresh. */
export const queueItemKey = (entry: QueueItem): string => `${entry.kind}:${entry.item.id}`;

/**
 * Flattens a fleet summary into one queue, soonest deadline first — the order
 * you actually have to work it in.
 */
export function buildQueue(fleet: FleetSummary): QueueItem[] {
  const entries: QueueItem[] = [];

  for (const summary of fleet.agents) {
    const agent: QueueAgent = {
      id: summary.definition.id,
      name: summary.definition.name,
      status: summary.state.status,
    };
    for (const item of summary.toolCalls) entries.push({ kind: 'toolCall', agent, item });
    for (const item of summary.approvals) entries.push({ kind: 'approval', agent, item });
  }

  return sortQueue(entries);
}

export function sortQueue(entries: QueueItem[]): QueueItem[] {
  return [...entries].sort((a, b) => a.item.expiresAt - b.item.expiresAt);
}
