/**
 * Redis-backed StateStore for multi-process operation. When several server
 * processes run behind a load balancer, they share one view of agent state,
 * pending approvals, drift history, and the action log — and a leader lock
 * ensures only one process runs each scheduled drift cycle.
 *
 * ioredis is used directly here (server-side I/O); the SDK stays provider-free.
 */
import { Redis } from 'ioredis';
import type {
  ActionLogEntry,
  AgentRuntimeState,
  Approval,
  ApprovalStatus,
  DriftHistoryEntry,
  StateStore,
} from '@driftwatch/sdk';

const HISTORY_CAP = 500;

const KEY = {
  agentState: 'dw:agent:state',
  pendingApprovals: 'dw:approvals:pending',
  approval: (id: string) => `dw:approval:${id}`,
  driftHistory: 'dw:drift:history',
  actionLog: 'dw:action:log',
  cooldown: (key: string) => `dw:cooldown:${key}`,
  leader: (key: string) => `dw:leader:${key}`,
} as const;

const DEFAULT_AGENT_STATE: AgentRuntimeState = {
  status: 'running',
  activeVersion: 1,
  updatedAt: 0,
};

/**
 * Atomically resolve a still-pending approval. Returns the updated JSON, or an
 * empty string when the approval is missing or already resolved. Running this
 * as a single Lua script guarantees two channels (console + Slack + Telegram)
 * can't both "win" the same approval.
 */
const RESOLVE_APPROVAL_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return '' end
local approval = cjson.decode(raw)
if approval.status ~= 'pending' then return '' end
approval.status = ARGV[1]
approval.resolvedBy = ARGV[2]
approval.channel = ARGV[3]
approval.resolvedAt = tonumber(ARGV[4])
local updated = cjson.encode(approval)
redis.call('SET', KEYS[1], updated)
redis.call('SREM', KEYS[2], ARGV[5])
return updated
`;

export class RedisStateStore implements StateStore {
  private readonly redis: Redis;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: 3 });
  }

  async getAgentState(): Promise<AgentRuntimeState> {
    const raw = await this.redis.get(KEY.agentState);
    if (!raw) return { ...DEFAULT_AGENT_STATE, updatedAt: Date.now() };
    return JSON.parse(raw) as AgentRuntimeState;
  }

  async setAgentState(state: AgentRuntimeState): Promise<void> {
    await this.redis.set(KEY.agentState, JSON.stringify(state));
  }

  async createApproval(approval: Approval): Promise<void> {
    await this.redis
      .multi()
      .set(KEY.approval(approval.id), JSON.stringify(approval))
      .sadd(KEY.pendingApprovals, approval.id)
      .exec();
  }

  async getApproval(id: string): Promise<Approval | undefined> {
    const raw = await this.redis.get(KEY.approval(id));
    return raw ? (JSON.parse(raw) as Approval) : undefined;
  }

  async listPendingApprovals(): Promise<Approval[]> {
    const ids = await this.redis.smembers(KEY.pendingApprovals);
    if (ids.length === 0) return [];
    const raws = await this.redis.mget(ids.map((id) => KEY.approval(id)));
    const approvals: Approval[] = [];
    for (const raw of raws) {
      if (!raw) continue;
      const approval = JSON.parse(raw) as Approval;
      if (approval.status === 'pending') approvals.push(approval);
    }
    return approvals.sort((a, b) => a.createdAt - b.createdAt);
  }

  async resolveApproval(
    id: string,
    status: Exclude<ApprovalStatus, 'pending'>,
    resolvedBy: string,
    channel: string,
  ): Promise<Approval | undefined> {
    const result = (await this.redis.eval(
      RESOLVE_APPROVAL_LUA,
      2,
      KEY.approval(id),
      KEY.pendingApprovals,
      status,
      resolvedBy,
      channel,
      String(Date.now()),
      id,
    )) as string;
    return result ? (JSON.parse(result) as Approval) : undefined;
  }

  async recordDriftVerdict(entry: DriftHistoryEntry): Promise<void> {
    await this.redis
      .multi()
      .lpush(KEY.driftHistory, JSON.stringify(entry))
      .ltrim(KEY.driftHistory, 0, HISTORY_CAP - 1)
      .exec();
  }

  async listDriftHistory(limit: number): Promise<DriftHistoryEntry[]> {
    const raws = await this.redis.lrange(KEY.driftHistory, 0, limit - 1);
    return raws.map((raw) => JSON.parse(raw) as DriftHistoryEntry);
  }

  async recordAction(entry: ActionLogEntry): Promise<void> {
    await this.redis
      .multi()
      .lpush(KEY.actionLog, JSON.stringify(entry))
      .ltrim(KEY.actionLog, 0, HISTORY_CAP - 1)
      .exec();
  }

  async listActionLog(limit: number): Promise<ActionLogEntry[]> {
    const raws = await this.redis.lrange(KEY.actionLog, 0, limit - 1);
    return raws.map((raw) => JSON.parse(raw) as ActionLogEntry);
  }

  async checkAndSetCooldown(key: string, ttlMs: number): Promise<boolean> {
    const result = await this.redis.set(KEY.cooldown(key), '1', 'PX', ttlMs, 'NX');
    return result === 'OK';
  }

  async acquireLeaderLock(key: string, ttlMs: number): Promise<boolean> {
    const result = await this.redis.set(KEY.leader(key), '1', 'PX', ttlMs, 'NX');
    return result === 'OK';
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
