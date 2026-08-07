/**
 * Shared types for the Autopilot layer — Loop 2 of DriftWatch.
 *
 * The orchestration built on these types — `MemoryStateStore`,
 * `ApprovalService`, `AutopilotScheduler`, `executeControlAction`, and the
 * notify-dispatch helpers — lives alongside them in this package, since none
 * of it does concrete I/O: it only calls the `StateStore`/`Notifier`
 * interfaces defined here. Two things that DO require concrete I/O are kept
 * out of the package root:
 *   - `RedisStateStore` needs `ioredis` — it's an isolated subpath export at
 *     `@driftwatch/sdk/redis` with ioredis as an optional peer dependency, so
 *     importing the core SDK never pulls it in.
 *   - Concrete Slack/Telegram/webhook `Notifier`s and inbound-webhook
 *     signature verification live in the companion `@driftwatch/autopilot`
 *     package, since they track those providers' APIs independently of this
 *     package's release cadence.
 */
import { randomBytes } from 'node:crypto';
import type { DriftVerdict } from '../drift/detector.js';
import type { AgentConfig } from '../config/schema.js';

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
  /** Which agent this approval targets. */
  agentId: string;
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

/**
 * Registry entry for one monitored agent in the fleet — distinct from
 * `AgentRuntimeState` (its mutable runtime status). One deployment can host
 * many agents; `id` (a low-cardinality metric label — see `agent.id`/
 * `agent_id` on spans and counters throughout the SDK) is what actually
 * isolates one agent's telemetry/state/config from another's, not process
 * identity. This record is the single source of truth for everything that
 * varies per agent: telemetry association, guardrails, and tools.
 */
export interface AgentDefinition {
  id: string;
  name: string;
  owner?: string;
  /**
   * OTel service.name this agent's telemetry is nominally associated with —
   * an optional secondary Prometheus label matcher (see
   * PrometheusMetricsSource's `extraLabelMatchers`), not the primary one.
   * `agent_id` (this record's `id`) is the primary per-agent metric label,
   * since co-located agents sharing one process share one `service.name`.
   */
  serviceName?: string;
  createdAt: number;
  /**
   * Per-agent guardrail overrides, merged over DriftWatchConfig.agent
   * per-field. If `guardrailsSource` is also set, this merges OVER that
   * agent's own guardrails — inherit a shared baseline, then tweak specific
   * fields locally.
   */
  guardrails?: Partial<AgentConfig>;
  /**
   * Reuse another agent's guardrails as this agent's baseline (e.g. a
   * payment agent reusing a customer-service agent's caps) — a single-hop
   * reference, not a chain: resolution uses the referenced agent's own
   * `guardrails` field directly, ignoring whether THAT agent itself has a
   * `guardrailsSource` set. Must reference an existing, different agent id
   * — validated at registration/edit time (see the server's console routes).
   */
  guardrailsSource?: string;
  /** Tool names this agent may call. Omit = every registered tool (today's behavior). */
  toolNames?: string[];
  /** Default true. Set false for an approval/control-only agent, never drift-scanned. */
  driftDetectionEnabled?: boolean;
}

/**
 * Agent ids that come from outside the process (e.g. a POST /agents body)
 * must match this before being trusted as a Redis/composite-key segment —
 * an unvalidated id containing `:` (RedisStateStore) or the cooldown-key
 * separator could collide with another agent's keys. Ids generated internally
 * via randomUUID() (or generateAgentSlug below) are safe by construction and
 * don't need this check.
 */
export const AGENT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Human-readable agent id: a slug of `name` plus a short random suffix to
 * prevent collisions (e.g. "Payment Agent" -> "payment-agent-9e930e"). Used
 * as the default when a caller doesn't supply a custom id at registration —
 * this id is also the primary telemetry label (`agent_id`), so a readable
 * value is worth more here than in a typical opaque-id case. Always matches
 * AGENT_ID_PATTERN.
 */
export function generateAgentSlug(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const suffix = randomBytes(3).toString('hex');
  return base ? `${base}-${suffix}` : suffix;
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
 *
 * Every method is scoped to one agent via a leading `agentId`, EXCEPT:
 *   - `getApproval`/`resolveApproval` — id-only. Approval ids are globally
 *     unique (randomUUID), and Slack/Telegram webhook callbacks only ever
 *     carry the bare approval id, never an agentId — `Approval.agentId`
 *     carries that information on the record instead of the method signature.
 *   - `acquireLeaderLock` — stays global. One leader process runs the whole
 *     fleet's drift cycle per tick; this isn't a per-agent concern.
 */
export interface StateStore {
  // --- agent registry -----------------------------------------------------
  /** Idempotent create-or-update, keyed by `definition.id`. */
  upsertAgent(definition: AgentDefinition): Promise<void>;
  getAgentDefinition(agentId: string): Promise<AgentDefinition | undefined>;
  listAgents(): Promise<AgentDefinition[]>;

  // --- runtime state --------------------------------------------------------
  getAgentState(agentId: string): Promise<AgentRuntimeState>;
  setAgentState(agentId: string, state: AgentRuntimeState): Promise<void>;

  createApproval(approval: Approval): Promise<void>;
  getApproval(id: string): Promise<Approval | undefined>;
  listPendingApprovals(agentId: string): Promise<Approval[]>;
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

  recordDriftVerdict(agentId: string, entry: DriftHistoryEntry): Promise<void>;
  listDriftHistory(agentId: string, limit: number): Promise<DriftHistoryEntry[]>;

  recordAction(agentId: string, entry: ActionLogEntry): Promise<void>;
  listActionLog(agentId: string, limit: number): Promise<ActionLogEntry[]>;

  /**
   * Returns true when the (agentId, key) pair was NOT recently seen (i.e. the
   * caller may proceed) and records it for `ttlMs`; false while still in
   * cooldown. Per-agent so an action storm on one agent doesn't suppress a
   * legitimate action for another.
   */
  checkAndSetCooldown(agentId: string, key: string, ttlMs: number): Promise<boolean>;

  /** Best-effort leader election so only one process runs a drift cycle. */
  acquireLeaderLock(key: string, ttlMs: number): Promise<boolean>;

  close(): Promise<void>;
}

/** A notification sink (Slack, Telegram, generic webhook). */
export interface Notifier {
  readonly channel: string;
  notify(message: NotificationMessage): Promise<void>;
}
