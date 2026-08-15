/**
 * Redis-backed StateStore for multi-process operation. When several server
 * processes run behind a load balancer, they share one view of the agent
 * registry, runtime state, pending approvals, drift history, and the action
 * log — and a leader lock ensures only one process runs each scheduled drift
 * cycle (for the whole fleet, not per agent).
 *
 * ## Why this lives in the server and no longer in @driftwatch/sdk
 *
 * It used to ship as `@driftwatch/sdk/redis` with `ioredis` as an optional peer
 * dependency. That was the wrong package: this is the CONTROL PLANE's storage,
 * and an agent running in a Lambda or a CI job — the shape the SDK exists to
 * serve — has no business carrying a Redis client, even an optional one. Moving
 * it here makes the dependency direction one-way (an agent talks to the control
 * plane over HTTP; it does not share its database) and lets the SDK and the
 * server version independently, which they could not do while they shared a
 * storage implementation.
 *
 * `StateStore` itself remains a TYPE in the SDK, so anyone can still implement
 * their own backend — the same bring-your-own-implementation stance as
 * `MetricsQuerySource`.
 *
 * ## When to use it
 *
 * Postgres is the recommended backend and implements every method including the
 * leader lock, so Redis is no longer required for multi-process deployments.
 * This remains supported for deployments already running Redis. Note it caps
 * drift history at 500 entries and the audit log at 2000 — durable, unbounded
 * history is what PostgresStateStore is for.
 */
import { Redis } from 'ioredis';
import type {
  ActionLogEntry,
  AgentDefinition,
  AgentOverride,
  AgentRuntimeState,
  ApiKeyRecord,
  Approval,
  ApprovalStatus,
  AuditEvent,
  DriftHistoryEntry,
  StateStore,
  ToolCallApproval,
} from '@driftwatch/sdk';

const HISTORY_CAP = 500;

/** See the matching constant in memory-store.ts for why this is separate. */
const AUDIT_CAP = 2000;

const KEY = {
  apiKey: (id: string) => `dw:apikey:${id}`,
  /** sha256(token) -> key id. The authentication index; see api-keys.ts. */
  apiKeyByHash: (hash: string) => `dw:apikey:hash:${hash}`,
  apiKeysIndex: 'dw:apikeys',
  auditLog: 'dw:audit:log',
  agentDef: (agentId: string) => `dw:agent:${agentId}:def`,
  agentOverride: (agentId: string) => `dw:agent:${agentId}:override`,
  agentsIndex: 'dw:agents',
  agentState: (agentId: string) => `dw:agent:${agentId}:state`,
  approval: (id: string) => `dw:approval:${id}`,
  pendingApprovals: (agentId: string) => `dw:agent:${agentId}:approvals:pending`,
  toolCallApproval: (id: string) => `dw:toolcall-approval:${id}`,
  pendingToolCallApprovals: (agentId: string) => `dw:agent:${agentId}:toolcall-approvals:pending`,
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

/**
 * Same CAS pattern as RESOLVE_APPROVAL_LUA, kept as a separate script rather
 * than parameterizing one shared script over both key prefixes — each is
 * already tightly coupled to its own type's exact field shape via cjson, and
 * a tool-call approval is a genuinely different kind of event (see
 * ToolCallApproval's docblock in types.ts), not a hardship to keep parallel.
 */
const RESOLVE_TOOL_CALL_APPROVAL_LUA = `
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
redis.call('SREM', 'dw:agent:' .. approval.agentId .. ':toolcall-approvals:pending', ARGV[5])
return updated
`;

/**
 * Read-modify-write on one key record, done in Lua for the same reason the
 * approval scripts are: a plain GET/SET pair from two processes would let a
 * `touchApiKey` silently resurrect a record a concurrent `revokeApiKey` had
 * just stamped. ARGV[1] selects the mutation so both operations share one
 * script rather than duplicating the load-decode-encode-store frame.
 */
const MUTATE_API_KEY_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return '' end
local record = cjson.decode(raw)
if ARGV[1] == 'revoke' then
  if record.revokedAt ~= nil then return '' end
  record.revokedAt = tonumber(ARGV[2])
  record.revokedBy = ARGV[3]
else
  record.lastUsedAt = tonumber(ARGV[2])
end
local updated = cjson.encode(record)
redis.call('SET', KEYS[1], updated)
return updated
`;

export class RedisStateStore implements StateStore {
  private readonly redis: Redis;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: 3 });
  }

  async createApiKey(record: ApiKeyRecord): Promise<void> {
    await this.redis
      .multi()
      .set(KEY.apiKey(record.id), JSON.stringify(record))
      .set(KEY.apiKeyByHash(record.hash), record.id)
      .sadd(KEY.apiKeysIndex, record.id)
      .exec();
  }

  async getApiKeyByHash(hash: string): Promise<ApiKeyRecord | undefined> {
    const id = await this.redis.get(KEY.apiKeyByHash(hash));
    return id ? this.getApiKey(id) : undefined;
  }

  async getApiKey(id: string): Promise<ApiKeyRecord | undefined> {
    const raw = await this.redis.get(KEY.apiKey(id));
    return raw ? (JSON.parse(raw) as ApiKeyRecord) : undefined;
  }

  async listApiKeys(): Promise<ApiKeyRecord[]> {
    const ids = await this.redis.smembers(KEY.apiKeysIndex);
    if (ids.length === 0) return [];
    const raws = await this.redis.mget(ids.map((id) => KEY.apiKey(id)));
    return raws
      .filter((raw): raw is string => !!raw)
      .map((raw) => JSON.parse(raw) as ApiKeyRecord)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async revokeApiKey(id: string, revokedBy: string): Promise<ApiKeyRecord | undefined> {
    // The hash index entry is deliberately left in place — see the matching
    // comment in memory-store.ts.
    const result = (await this.redis.eval(
      MUTATE_API_KEY_LUA,
      1,
      KEY.apiKey(id),
      'revoke',
      String(Date.now()),
      revokedBy,
    )) as string;
    return result ? (JSON.parse(result) as ApiKeyRecord) : undefined;
  }

  async touchApiKey(id: string, at: number): Promise<void> {
    await this.redis.eval(MUTATE_API_KEY_LUA, 1, KEY.apiKey(id), 'touch', String(at), '');
  }

  async recordAuditEvent(event: AuditEvent): Promise<void> {
    await this.redis
      .multi()
      .lpush(KEY.auditLog, JSON.stringify(event))
      .ltrim(KEY.auditLog, 0, AUDIT_CAP - 1)
      .exec();
  }

  async listAuditEvents(limit: number, agentId?: string): Promise<AuditEvent[]> {
    // Unfiltered reads take only what they need. A per-agent read has to scan
    // the capped list, since the log is one fleet-wide stream by design (see
    // AuditEvent's docblock) — bounded by AUDIT_CAP, not unbounded.
    const raws = await this.redis.lrange(KEY.auditLog, 0, agentId ? AUDIT_CAP - 1 : limit - 1);
    const events = raws.map((raw) => JSON.parse(raw) as AuditEvent);
    return (agentId ? events.filter((event) => event.agentId === agentId) : events).slice(0, limit);
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

  async getAgentOverride(agentId: string): Promise<AgentOverride | undefined> {
    const raw = await this.redis.get(KEY.agentOverride(agentId));
    return raw ? (JSON.parse(raw) as AgentOverride) : undefined;
  }

  async setAgentOverride(override: AgentOverride): Promise<void> {
    await this.redis.set(KEY.agentOverride(override.agentId), JSON.stringify(override));
  }

  async clearAgentOverride(agentId: string): Promise<boolean> {
    // DEL returns the number of keys removed, which is exactly the
    // "was there anything to revert" answer the interface asks for.
    return (await this.redis.del(KEY.agentOverride(agentId))) > 0;
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

  async createToolCallApproval(approval: ToolCallApproval): Promise<void> {
    await this.redis
      .multi()
      .set(KEY.toolCallApproval(approval.id), JSON.stringify(approval))
      .sadd(KEY.pendingToolCallApprovals(approval.agentId), approval.id)
      .exec();
  }

  async getToolCallApproval(id: string): Promise<ToolCallApproval | undefined> {
    const raw = await this.redis.get(KEY.toolCallApproval(id));
    return raw ? (JSON.parse(raw) as ToolCallApproval) : undefined;
  }

  async listPendingToolCallApprovals(agentId: string): Promise<ToolCallApproval[]> {
    const ids = await this.redis.smembers(KEY.pendingToolCallApprovals(agentId));
    if (ids.length === 0) return [];
    const raws = await this.redis.mget(ids.map((id) => KEY.toolCallApproval(id)));
    const approvals: ToolCallApproval[] = [];
    for (const raw of raws) {
      if (!raw) continue;
      const approval = JSON.parse(raw) as ToolCallApproval;
      if (approval.status === 'pending') approvals.push(approval);
    }
    return approvals.sort((a, b) => a.createdAt - b.createdAt);
  }

  async resolveToolCallApproval(
    id: string,
    status: Exclude<ApprovalStatus, 'pending'>,
    resolvedBy: string,
    channel: string,
  ): Promise<ToolCallApproval | undefined> {
    const result = (await this.redis.eval(
      RESOLVE_TOOL_CALL_APPROVAL_LUA,
      1,
      KEY.toolCallApproval(id),
      status,
      resolvedBy,
      channel,
      String(Date.now()),
      id,
    )) as string;
    return result ? (JSON.parse(result) as ToolCallApproval) : undefined;
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
