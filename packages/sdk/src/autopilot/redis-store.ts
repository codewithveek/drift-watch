/**
 * Redis-backed StateStore for multi-process operation. When several server
 * processes run behind a load balancer, they share one view of the agent
 * registry, runtime state, pending approvals, drift history, and the action
 * log — and a leader lock ensures only one process runs each scheduled drift
 * cycle (for the whole fleet, not per agent).
 *
 * Not exported from the package root — import from `@driftwatch/sdk/redis`.
 * `ioredis` is an OPTIONAL peer dependency: installing the core SDK never
 * pulls it in, so this is the one place in the SDK a consumer opts into a
 * concrete I/O dependency, and only if they import this subpath.
 */
import { Redis } from 'ioredis';
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

const KEY = {
  agentDef: (agentId: string) => `dw:agent:${agentId}:def`,
  agentsIndex: 'dw:agents',
  agentState: (agentId: string) => `dw:agent:${agentId}:state`,
  approval: (id: string) => `dw:approval:${id}`,
  pendingApprovals: (agentId: string) => `dw:agent:${agentId}:approvals:pending`,
  driftHistory: (agentId: string) => `dw:agent:${agentId}:drift:history`,
  actionLog: (agentId: string) => `dw:agent:${agentId}:action:log`,
  cooldown: (agentId: string, key: string) => `dw:agent:${agentId}:cooldown:${key}`,
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
 *
 * The per-agent pending-approvals set key is derived INSIDE the script from
 * the decoded approval's own `agentId` field, rather than passed in as a
 * second KEYS entry — `resolveApproval`'s signature intentionally has no
 * `agentId` param (Slack/Telegram webhook callbacks only ever carry the bare
 * approval id). This assumes a non-clustered Redis, same as the rest of this
 * store — a Redis Cluster would need the pending-set key hash-tagged to land
 * in the same slot as KEYS[1], which nothing here does today.
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
redis.call('SREM', 'dw:agent:' .. approval.agentId .. ':approvals:pending', ARGV[5])
return updated
`;

export class RedisStateStore implements StateStore {
  private readonly redis: Redis;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: 3 });
  }

  async upsertAgent(definition: AgentDefinition): Promise<void> {
    await this.redis
      .multi()
      .set(KEY.agentDef(definition.id), JSON.stringify(definition))
      .sadd(KEY.agentsIndex, definition.id)
      .exec();
  }

  async getAgentDefinition(agentId: string): Promise<AgentDefinition | undefined> {
    const raw = await this.redis.get(KEY.agentDef(agentId));
    return raw ? (JSON.parse(raw) as AgentDefinition) : undefined;
  }

  async listAgents(): Promise<AgentDefinition[]> {
    const ids = await this.redis.smembers(KEY.agentsIndex);
    if (ids.length === 0) return [];
    const raws = await this.redis.mget(ids.map((id) => KEY.agentDef(id)));
    return raws
      .filter((raw): raw is string => !!raw)
      .map((raw) => JSON.parse(raw) as AgentDefinition)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async getAgentState(agentId: string): Promise<AgentRuntimeState> {
    const raw = await this.redis.get(KEY.agentState(agentId));
    if (!raw) return { ...DEFAULT_AGENT_STATE, updatedAt: Date.now() };
    return JSON.parse(raw) as AgentRuntimeState;
  }

  async setAgentState(agentId: string, state: AgentRuntimeState): Promise<void> {
    await this.redis.set(KEY.agentState(agentId), JSON.stringify(state));
  }

  async createApproval(approval: Approval): Promise<void> {
    await this.redis
      .multi()
      .set(KEY.approval(approval.id), JSON.stringify(approval))
      .sadd(KEY.pendingApprovals(approval.agentId), approval.id)
      .exec();
  }

  async getApproval(id: string): Promise<Approval | undefined> {
    const raw = await this.redis.get(KEY.approval(id));
    return raw ? (JSON.parse(raw) as Approval) : undefined;
  }

  async listPendingApprovals(agentId: string): Promise<Approval[]> {
    const ids = await this.redis.smembers(KEY.pendingApprovals(agentId));
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
      1,
      KEY.approval(id),
      status,
      resolvedBy,
      channel,
      String(Date.now()),
      id,
    )) as string;
    return result ? (JSON.parse(result) as Approval) : undefined;
  }

  async recordDriftVerdict(agentId: string, entry: DriftHistoryEntry): Promise<void> {
    await this.redis
      .multi()
      .lpush(KEY.driftHistory(agentId), JSON.stringify(entry))
      .ltrim(KEY.driftHistory(agentId), 0, HISTORY_CAP - 1)
      .exec();
  }

  async listDriftHistory(agentId: string, limit: number): Promise<DriftHistoryEntry[]> {
    const raws = await this.redis.lrange(KEY.driftHistory(agentId), 0, limit - 1);
    return raws.map((raw) => JSON.parse(raw) as DriftHistoryEntry);
  }

  async recordAction(agentId: string, entry: ActionLogEntry): Promise<void> {
    await this.redis
      .multi()
      .lpush(KEY.actionLog(agentId), JSON.stringify(entry))
      .ltrim(KEY.actionLog(agentId), 0, HISTORY_CAP - 1)
      .exec();
  }

  async listActionLog(agentId: string, limit: number): Promise<ActionLogEntry[]> {
    const raws = await this.redis.lrange(KEY.actionLog(agentId), 0, limit - 1);
    return raws.map((raw) => JSON.parse(raw) as ActionLogEntry);
  }

  async checkAndSetCooldown(agentId: string, key: string, ttlMs: number): Promise<boolean> {
    const result = await this.redis.set(KEY.cooldown(agentId, key), '1', 'PX', ttlMs, 'NX');
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
