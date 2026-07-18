/**
 * In-memory StateStore — the zero-dependency fallback used when REDIS_URL is
 * unset. Perfect for single-process dev and the demo; NOT suitable across
 * multiple processes (each would keep its own state). For multi-process, set
 * REDIS_URL to use redis-store.ts instead.
 */
import type {
  ActionLogEntry,
  AgentRuntimeState,
  Approval,
  ApprovalStatus,
  DriftHistoryEntry,
  StateStore,
} from '@driftwatch/sdk';

const HISTORY_CAP = 500;

export class MemoryStateStore implements StateStore {
  private agentState: AgentRuntimeState = {
    status: 'running',
    activeVersion: 1,
    updatedAt: Date.now(),
  };
  private readonly approvals = new Map<string, Approval>();
  private readonly driftHistory: DriftHistoryEntry[] = [];
  private readonly actionLog: ActionLogEntry[] = [];
  private readonly cooldowns = new Map<string, number>();
  private readonly leaderLocks = new Map<string, number>();

  async getAgentState(): Promise<AgentRuntimeState> {
    return { ...this.agentState };
  }

  async setAgentState(state: AgentRuntimeState): Promise<void> {
    this.agentState = { ...state };
  }

  async createApproval(approval: Approval): Promise<void> {
    this.approvals.set(approval.id, { ...approval });
  }

  async getApproval(id: string): Promise<Approval | undefined> {
    const approval = this.approvals.get(id);
    return approval ? { ...approval } : undefined;
  }

  async listPendingApprovals(): Promise<Approval[]> {
    return Array.from(this.approvals.values())
      .filter((approval) => approval.status === 'pending')
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
    return { ...resolved };
  }

  async recordDriftVerdict(entry: DriftHistoryEntry): Promise<void> {
    this.driftHistory.unshift({ ...entry });
    if (this.driftHistory.length > HISTORY_CAP) {
      this.driftHistory.length = HISTORY_CAP;
    }
  }

  async listDriftHistory(limit: number): Promise<DriftHistoryEntry[]> {
    return this.driftHistory.slice(0, limit).map((entry) => ({ ...entry }));
  }

  async recordAction(entry: ActionLogEntry): Promise<void> {
    this.actionLog.unshift({ ...entry });
    if (this.actionLog.length > HISTORY_CAP) {
      this.actionLog.length = HISTORY_CAP;
    }
  }

  async listActionLog(limit: number): Promise<ActionLogEntry[]> {
    return this.actionLog.slice(0, limit).map((entry) => ({ ...entry }));
  }

  async checkAndSetCooldown(key: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const existingExpiry = this.cooldowns.get(key);
    if (existingExpiry !== undefined && existingExpiry > now) return false;
    this.cooldowns.set(key, now + ttlMs);
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
