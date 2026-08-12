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
import type { ToolCallPolicyRule } from './tool-call-policy.js';
import type { ApiKeyRecord } from './api-keys.js';

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

/**
 * A single in-flight tool call awaiting a human decision (Loop 3) — NOT a
 * reuse of `Approval`, which is shaped entirely around `ActionType`/
 * `DriftSeverity` for agent-lifecycle control actions. Shoehorning a tool
 * name/call-args into `reasons`/`recommendedAction` strings would be lossy,
 * and would mix a conceptually different kind of event into the
 * control-approval audit trail. See tool-call-gate.ts for how this is
 * created/resolved.
 */
export interface ToolCallApproval {
  id: string;
  agentId: string;
  tool: string;
  /** The policy rule's `field` (dot-path), if the matched rule was field-scoped. */
  fieldPath?: string;
  /** The matched rule's `reason`, if set — shown in the approval notification. */
  matchedReason?: string;
  /**
   * The tool's raw input, ONLY populated when payload capture is enabled
   * (see isCapturePayloadsEnabled in telemetry/capture-config.ts) — never
   * leak a sensitive field's actual value into a Slack/Telegram message by
   * default, that would defeat the point of gating it in the first place.
   */
  inputSummary?: Record<string, unknown>;
  status: ApprovalStatus;
  createdAt: number;
  expiresAt: number;
  resolvedAt?: number;
  resolvedBy?: string;
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
  /**
   * Pre-execution, per-tool-call gate rules (Loop 3 — see tool-call-policy.ts
   * and tool-call-gate.ts). If `toolPoliciesSource` is also set, this list is
   * evaluated ALONGSIDE that agent's own `toolPolicies` (union, not override
   * — a rule list composes by "which rules apply," not by per-field replace
   * the way `guardrails` does).
   */
  toolPolicies?: ToolCallPolicyRule[];
  /**
   * Reuse another agent's tool-call policies as an additional, shared
   * baseline (e.g. a fleet-wide "large refunds need approval" rule set) —
   * independent of `guardrailsSource`, since spend caps and tool-call risk
   * gating are different axes a deployer may want to compose differently.
   * Single-hop reference, same validation as `guardrailsSource`.
   */
  toolPoliciesSource?: string;
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

/**
 * Resolves the effective tool-call policy set for one agent: the union of
 * its own `toolPolicies` and (if `toolPoliciesSource` is set) the referenced
 * agent's `toolPolicies` — NOT a per-field override like `resolveAgentConfig`
 * does for guardrails, since a rule LIST composes by "which rules apply,"
 * not by replacing one flat record's fields. No dedup: overlapping/duplicate
 * rules are harmless under evaluateToolCallPolicy's strictest-wins combining.
 */
export function resolveToolCallPolicies(
  agent: AgentDefinition,
  sourceAgent?: AgentDefinition,
): ToolCallPolicyRule[] {
  return [...(sourceAgent?.toolPolicies ?? []), ...(agent.toolPolicies ?? [])];
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

/**
 * Every mutation of the control plane worth attributing to a principal.
 *
 * Distinct from `ActionLogEntry`, which records what AUTOPILOT decided to do
 * to one agent (and is per-agent by construction). This is the human/API side:
 * who changed configuration, who resolved an approval, who minted a key. It is
 * fleet-wide precisely because the questions it answers ("what did this leaked
 * key touch?") cross agent boundaries.
 */
export const AUDIT_ACTIONS = [
  'apikey.create',
  'apikey.revoke',
  'agent.create',
  'agent.update',
  'policy.update',
  'approval.resolve',
  'toolcall.resolve',
  'control.pause',
  'control.resume',
  'control.rollback',
  'drift.scan',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEvent {
  id: string;
  at: number;
  /** Principal id: `root` (AUTH_TOKEN), `local` (dev local-network), or an API key id. */
  actor: string;
  /** Human label for that principal — the key's name, or `AUTH_TOKEN`. */
  actorLabel: string;
  action: AuditAction;
  /** The record acted on: an agent id, an API key id, an approval id. */
  target?: string;
  /** Set when the event belongs to one agent, so it can be filtered per-agent. */
  agentId?: string;
  /**
   * One-line description. MUST NOT contain secret plaintext — for a change
   * that touches a secret, name the FIELD that changed, never its before/after
   * value. See the roadmap note on audit-log diffs.
   */
  summary: string;
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
 *   - the API-key and audit methods — both are fleet-wide by design. A key's
 *     agent scoping lives on the record (`ApiKeyRecord.agentIds`), not in the
 *     method signature, for the same reason `Approval.agentId` does: the
 *     lookup happens before any agent is known.
 */
export interface StateStore {
  // --- API keys -------------------------------------------------------------
  createApiKey(record: ApiKeyRecord): Promise<void>;
  /**
   * The authentication hot path: look up by sha256(token). Returns the record
   * even when revoked/expired — the caller decides (see `isApiKeyUsable`), so
   * an audit trail can distinguish "unknown token" from "revoked token".
   */
  getApiKeyByHash(hash: string): Promise<ApiKeyRecord | undefined>;
  getApiKey(id: string): Promise<ApiKeyRecord | undefined>;
  listApiKeys(): Promise<ApiKeyRecord[]>;
  /**
   * Soft revoke: stamps `revokedAt`/`revokedBy` and keeps the record, so the
   * audit trail still resolves the key id to a name long after it stopped
   * working. Returns undefined if unknown or already revoked (idempotency
   * guard, same contract as resolveApproval).
   */
  revokeApiKey(id: string, revokedBy: string): Promise<ApiKeyRecord | undefined>;
  /** Best-effort coarse last-use stamp — see API_KEY_TOUCH_INTERVAL_MS. */
  touchApiKey(id: string, at: number): Promise<void>;

  // --- audit log (fleet-wide) -----------------------------------------------
  recordAuditEvent(event: AuditEvent): Promise<void>;
  /** Newest first. `agentId` filters to events scoped to that one agent. */
  listAuditEvents(limit: number, agentId?: string): Promise<AuditEvent[]>;

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

  // --- tool-call approvals (Loop 3) — id-only for get/resolve, same
  // rationale as getApproval/resolveApproval above: a webhook callback only
  // ever carries the bare id, never an agentId.
  createToolCallApproval(approval: ToolCallApproval): Promise<void>;
  getToolCallApproval(id: string): Promise<ToolCallApproval | undefined>;
  listPendingToolCallApprovals(agentId: string): Promise<ToolCallApproval[]>;
  /** Atomically resolve a still-pending tool-call approval. Same CAS contract as resolveApproval. */
  resolveToolCallApproval(
    id: string,
    status: Exclude<ApprovalStatus, 'pending'>,
    resolvedBy: string,
    channel: string,
  ): Promise<ToolCallApproval | undefined>;

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
