/**
 * In-memory StateStore — the zero-dependency default. Perfect for single-
 * process use (a standalone script, a single container); NOT suitable across
 * multiple processes, since each keeps its own state. For multi-process
 * deployments, use `RedisStateStore` from `@driftwatch/sdk/redis` instead.
 */
import type {
  ActionLogEntry,
  AgentDefinition,
  AgentRuntimeState,
  Approval,
  ApprovalStatus,
  AuditEvent,
  DriftHistoryEntry,
  StateStore,
  ToolCallApproval,
} from './types.js';
import type { ApiKeyRecord } from './api-keys.js';

const HISTORY_CAP = 500;

/**
 * Separate, larger cap than HISTORY_CAP: the audit log is the record you
 * consult after something went wrong, and it accumulates across the whole
 * fleet rather than per agent, so it fills far faster.
 */
const AUDIT_CAP = 2000;

function defaultAgentState(): AgentRuntimeState {
  return { status: 'running', activeVersion: 1, updatedAt: Date.now() };
}

export class MemoryStateStore implements StateStore {
  private readonly agents = new Map<string, AgentDefinition>();
  private readonly agentState = new Map<string, AgentRuntimeState>();
  private readonly approvals = new Map<string, Approval>();
  private readonly pendingByAgent = new Map<string, Set<string>>();
  private readonly toolCallApprovals = new Map<string, ToolCallApproval>();
  private readonly pendingToolCallByAgent = new Map<string, Set<string>>();
  private readonly driftHistory = new Map<string, DriftHistoryEntry[]>();
  private readonly actionLog = new Map<string, ActionLogEntry[]>();
  private readonly cooldowns = new Map<string, number>();
  private readonly leaderLocks = new Map<string, number>();
  private readonly apiKeys = new Map<string, ApiKeyRecord>();
  /** sha256(token) -> key id. Mirrors the Redis hash index so both stores
   *  authenticate with one lookup rather than scanning every key. */
  private readonly apiKeyIdsByHash = new Map<string, string>();
  private readonly auditEvents: AuditEvent[] = [];

  async createApiKey(record: ApiKeyRecord): Promise<void> {
    this.apiKeys.set(record.id, { ...record });
    this.apiKeyIdsByHash.set(record.hash, record.id);
  }

  async getApiKeyByHash(hash: string): Promise<ApiKeyRecord | undefined> {
    const id = this.apiKeyIdsByHash.get(hash);
    return id ? this.getApiKey(id) : undefined;
  }

  async getApiKey(id: string): Promise<ApiKeyRecord | undefined> {
    const record = this.apiKeys.get(id);
    return record ? { ...record } : undefined;
  }

  async listApiKeys(): Promise<ApiKeyRecord[]> {
    return Array.from(this.apiKeys.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((record) => ({ ...record }));
  }

  async revokeApiKey(id: string, revokedBy: string): Promise<ApiKeyRecord | undefined> {
    const record = this.apiKeys.get(id);
    if (!record || record.revokedAt !== undefined) return undefined;
    const revoked: ApiKeyRecord = { ...record, revokedAt: Date.now(), revokedBy };
    this.apiKeys.set(id, revoked);
    // The hash index entry stays: getApiKeyByHash must still resolve a revoked
    // key so the gate can answer "revoked" rather than "unknown token".
    return { ...revoked };
  }

  async touchApiKey(id: string, at: number): Promise<void> {
    const record = this.apiKeys.get(id);
    if (!record) return;
    this.apiKeys.set(id, { ...record, lastUsedAt: at });
  }

  async recordAuditEvent(event: AuditEvent): Promise<void> {
    this.auditEvents.unshift({ ...event });
    if (this.auditEvents.length > AUDIT_CAP) this.auditEvents.length = AUDIT_CAP;
  }

  async listAuditEvents(limit: number, agentId?: string): Promise<AuditEvent[]> {
    const source = agentId
      ? this.auditEvents.filter((event) => event.agentId === agentId)
      : this.auditEvents;
    return source.slice(0, limit).map((event) => ({ ...event }));
  }

  /**
   * `createdAt` is preserved from the existing record rather than taken from
   * the incoming one. An SDK client re-registers on every deploy with a fresh
   * `Date.now()`, and letting that through would reset "first seen" each time,
   * making the fleet list's age column meaningless. Every other field is
   * replaced wholesale so a definition that stops declaring `toolPolicies`
   * actually clears them.
   */
  async upsertAgent(definition: AgentDefinition): Promise<void> {
    const existing = this.agents.get(definition.id);
    this.agents.set(definition.id, {
      ...definition,
      ...(existing ? { createdAt: existing.createdAt } : {}),
    });
  }

  async getAgentDefinition(agentId: string): Promise<AgentDefinition | undefined> {
    const definition = this.agents.get(agentId);
    return definition ? { ...definition } : undefined;
  }

  async listAgents(): Promise<AgentDefinition[]> {
    return Array.from(this.agents.values())
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((definition) => ({ ...definition }));
  }

  async getAgentState(agentId: string): Promise<AgentRuntimeState> {
    return { ...(this.agentState.get(agentId) ?? defaultAgentState()) };
  }

  async setAgentState(agentId: string, state: AgentRuntimeState): Promise<void> {
    this.agentState.set(agentId, { ...state });
  }

  async createApproval(approval: Approval): Promise<void> {
    this.approvals.set(approval.id, { ...approval });
    const pending = this.pendingByAgent.get(approval.agentId) ?? new Set<string>();
    pending.add(approval.id);
    this.pendingByAgent.set(approval.agentId, pending);
  }

  async getApproval(id: string): Promise<Approval | undefined> {
    const approval = this.approvals.get(id);
    return approval ? { ...approval } : undefined;
  }

  async listPendingApprovals(agentId: string): Promise<Approval[]> {
    const ids = this.pendingByAgent.get(agentId) ?? new Set<string>();
    return Array.from(ids)
      .map((id) => this.approvals.get(id))
      .filter((approval): approval is Approval => !!approval && approval.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((approval) => ({ ...approval }));
  }

  async resolveApproval(
    id: string,
    status: Exclude<ApprovalStatus, 'pending'>,
    resolvedBy: string,
    channel: string,
  ): Promise<Approval | undefined> {
    const approval = this.approvals.get(id);
    if (!approval || approval.status !== 'pending') return undefined;
    const resolved: Approval = {
      ...approval,
      status,
      resolvedBy,
      channel,
      resolvedAt: Date.now(),
    };
    this.approvals.set(id, resolved);
    this.pendingByAgent.get(approval.agentId)?.delete(id);
    return { ...resolved };
  }

  async createToolCallApproval(approval: ToolCallApproval): Promise<void> {
    this.toolCallApprovals.set(approval.id, { ...approval });
    const pending = this.pendingToolCallByAgent.get(approval.agentId) ?? new Set<string>();
    pending.add(approval.id);
    this.pendingToolCallByAgent.set(approval.agentId, pending);
  }

  async getToolCallApproval(id: string): Promise<ToolCallApproval | undefined> {
    const approval = this.toolCallApprovals.get(id);
    return approval ? { ...approval } : undefined;
  }

  async listPendingToolCallApprovals(agentId: string): Promise<ToolCallApproval[]> {
    const ids = this.pendingToolCallByAgent.get(agentId) ?? new Set<string>();
    return Array.from(ids)
      .map((id) => this.toolCallApprovals.get(id))
      .filter((approval): approval is ToolCallApproval => !!approval && approval.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((approval) => ({ ...approval }));
  }

  async resolveToolCallApproval(
    id: string,
    status: Exclude<ApprovalStatus, 'pending'>,
    resolvedBy: string,
    channel: string,
  ): Promise<ToolCallApproval | undefined> {
    const approval = this.toolCallApprovals.get(id);
    if (!approval || approval.status !== 'pending') return undefined;
    const resolved: ToolCallApproval = {
      ...approval,
      status,
      resolvedBy,
      channel,
      resolvedAt: Date.now(),
    };
    this.toolCallApprovals.set(id, resolved);
    this.pendingToolCallByAgent.get(approval.agentId)?.delete(id);
    return { ...resolved };
  }

  async recordDriftVerdict(agentId: string, entry: DriftHistoryEntry): Promise<void> {
    const list = this.driftHistory.get(agentId) ?? [];
    list.unshift({ ...entry });
    if (list.length > HISTORY_CAP) list.length = HISTORY_CAP;
    this.driftHistory.set(agentId, list);
  }

  async listDriftHistory(agentId: string, limit: number): Promise<DriftHistoryEntry[]> {
    return (this.driftHistory.get(agentId) ?? []).slice(0, limit).map((entry) => ({ ...entry }));
  }

  async recordAction(agentId: string, entry: ActionLogEntry): Promise<void> {
    const list = this.actionLog.get(agentId) ?? [];
    list.unshift({ ...entry });
    if (list.length > HISTORY_CAP) list.length = HISTORY_CAP;
    this.actionLog.set(agentId, list);
  }

  async listActionLog(agentId: string, limit: number): Promise<ActionLogEntry[]> {
    return (this.actionLog.get(agentId) ?? []).slice(0, limit).map((entry) => ({ ...entry }));
  }

  async checkAndSetCooldown(agentId: string, key: string, ttlMs: number): Promise<boolean> {
    const compositeKey = `${agentId} ${key}`;
    const now = Date.now();
    const existingExpiry = this.cooldowns.get(compositeKey);
    if (existingExpiry !== undefined && existingExpiry > now) return false;
    this.cooldowns.set(compositeKey, now + ttlMs);
    return true;
  }

  async acquireLeaderLock(key: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const existingExpiry = this.leaderLocks.get(key);
    if (existingExpiry !== undefined && existingExpiry > now) return false;
    this.leaderLocks.set(key, now + ttlMs);
    return true;
  }

  async close(): Promise<void> {
    // nothing to release for the in-memory store
  }
}
