/**
 * Shared types for the Autopilot layer — Loop 2 of DriftWatch.
 *
 * These live in the SDK because they are pure data/interfaces with no I/O and
 * no provider or env coupling. The *implementations* (Redis state store, Slack
 * / Telegram / webhook notifiers, the scheduler) live in @driftwatch/server,
 * which is where side effects belong. This keeps the SDK publishable with zero
 * provider SDKs and zero process.env reads, exactly like the rest of it.
 */
import type { DriftVerdict } from '../drift/detector.js';

/** Every remediation action Autopilot knows how to intend. */
export const ACTION_TYPES = [
  'notify_slack',
  'notify_telegram',
  'notify_webhook',
  'pause_agent',
  'resume_agent',
  'rollback',
  'throttle',
  'switch_model',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/**
 * Notify actions are safe side effects and fire automatically. Control
 * actions change how the monitored agent behaves and are gated behind a
 * human-in-the-loop approval unless a policy marks them auto.
 */
export type ActionCategory = 'notify' | 'control';

export const CONTROL_ACTIONS: ReadonlySet<ActionType> = new Set<ActionType>([
  'pause_agent',
  'resume_agent',
  'rollback',
  'throttle',
  'switch_model',
]);

export function categorizeAction(action: ActionType): ActionCategory {
  return CONTROL_ACTIONS.has(action) ? 'control' : 'notify';
}

export type DriftSeverity = DriftVerdict['severity'];

/** One action the policy engine decided should happen for a drift event. */
export interface ActionIntent {
  type: ActionType;
  category: ActionCategory;
  severity: DriftSeverity;
  /** Why this action was intended (verdict reasons + which rule matched). */
  reason: string;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

/** A control action awaiting a human decision from any channel. */
export interface Approval {
  id: string;
  action: ActionType;
  severity: DriftSeverity;
  reasons: string[];
  recommendedAction: string;
  status: ApprovalStatus;
  createdAt: number;
  expiresAt: number;
  resolvedAt?: number;
  /** Who resolved it (e.g. a Slack user id, Telegram username, "console"). */
  resolvedBy?: string;
  /** Which surface resolved it: 'console' | 'slack' | 'telegram' | 'timeout'. */
  channel?: string;
}

export type AgentStatus = 'running' | 'paused' | 'throttled';

/** The monitored agent's current runtime posture, shared across processes. */
export interface AgentRuntimeState {
  status: AgentStatus;
  /** Active model id — swapped by rollback / switch_model. */
  activeModel?: string;
  /** Monotonic version label used to roll back to a last-known-good config. */
  activeVersion: number;
  updatedAt: number;
  reason?: string;
}

export interface DriftHistoryEntry {
  id: string;
  at: number;
  drift: boolean;
  severity: DriftSeverity;
  reasons: string[];
  recommendedAction: string;
  baselineTokenSpend: number;
  currentTokenSpend: number;
}

export type ActionOutcome =
  | 'executed'
  | 'shadowed'
  | 'pending_approval'
  | 'skipped_cooldown'
  | 'failed';

export interface ActionLogEntry {
  id: string;
  at: number;
  action: ActionType;
  category: ActionCategory;
  outcome: ActionOutcome;
  reason: string;
  actor?: string;
  channel?: string;
}

/** A channel-agnostic notification payload. Rendered per-notifier. */
export interface NotificationMessage {
  title: string;
  severity: DriftSeverity;
  reasons: string[];
  recommendedAction: string;
  /** When set, the notifier should render Approve/Reject affordances. */
  approvalId?: string;
  action?: ActionType;
}

/**
 * Shared state, implemented by @driftwatch/server (Redis for multi-process,
 * in-memory for single-process/dev). All methods are async so the same
 * interface fits both a network store and a local map.
 */
export interface StateStore {
  getAgentState(): Promise<AgentRuntimeState>;
  setAgentState(state: AgentRuntimeState): Promise<void>;

  createApproval(approval: Approval): Promise<void>;
  getApproval(id: string): Promise<Approval | undefined>;
  listPendingApprovals(): Promise<Approval[]>;
  /**
   * Atomically resolve a still-pending approval. Returns the updated approval,
   * or undefined if it was missing or already resolved (idempotency guard).
   */
  resolveApproval(
    id: string,
    status: Exclude<ApprovalStatus, 'pending'>,
    resolvedBy: string,
    channel: string,
  ): Promise<Approval | undefined>;

  recordDriftVerdict(entry: DriftHistoryEntry): Promise<void>;
  listDriftHistory(limit: number): Promise<DriftHistoryEntry[]>;

  recordAction(entry: ActionLogEntry): Promise<void>;
  listActionLog(limit: number): Promise<ActionLogEntry[]>;

  /**
   * Returns true when the key was NOT recently seen (i.e. the caller may
   * proceed) and records it for `ttlMs`; false while still in cooldown.
   */
  checkAndSetCooldown(key: string, ttlMs: number): Promise<boolean>;

  /** Best-effort leader election so only one process runs a drift cycle. */
  acquireLeaderLock(key: string, ttlMs: number): Promise<boolean>;

  close(): Promise<void>;
}

/** A notification sink (Slack, Telegram, generic webhook). */
export interface Notifier {
  readonly channel: string;
  notify(message: NotificationMessage): Promise<void>;
}
