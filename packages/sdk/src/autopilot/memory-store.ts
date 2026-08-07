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
  DriftHistoryEntry,
  StateStore,
} from './types.js';

const HISTORY_CAP = 500;

function defaultAgentState(): AgentRuntimeState {
  return { status: 'running', activeVersion: 1, updatedAt: Date.now() };
}

export class MemoryStateStore implements StateStore {
  private readonly agents = new Map<string, AgentDefinition>();
  private readonly agentState = new Map<string, AgentRuntimeState>();
  private readonly approvals = new Map<string, Approval>();
  private readonly pendingByAgent = new Map<string, Set<string>>();
  private readonly driftHistory = new Map<string, DriftHistoryEntry[]>();
  private readonly actionLog = new Map<string, ActionLogEntry[]>();
  private readonly cooldowns = new Map<string, number>();
  private readonly leaderLocks = new Map<string, number>();

  async upsertAgent(definition: AgentDefinition): Promise<void> {
    this.agents.set(definition.id, { ...definition });
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
