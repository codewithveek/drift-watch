/**
 * `PostgresStateStore` — the durable `StateStore` implementation.
 *
 * Implements the whole 28-method interface rather than splitting hot/ephemeral
 * state into Redis and durable state into Postgres. A split would be a better
 * theoretical fit per concern, but it doubles the operational surface (both
 * systems must be up), makes the composition root conditional, and spreads a
 * single logical write across two systems with no transaction spanning them.
 * Postgres handles the "hot" paths comfortably at this scale: a leader lock
 * contested once a minute, cooldowns, and approval polling.
 *
 * ## The three atomic operations
 *
 * Redis needed a hand-written Lua script to resolve an approval atomically, and
 * `SET NX PX` for the lock and cooldown. All three are *simpler* here, not
 * harder, and each is a single statement:
 *
 *   - resolve approval / tool call — `UPDATE ... WHERE status = 'pending'
 *     RETURNING *`. The row lock Postgres takes for the UPDATE is the mutual
 *     exclusion; a loser matches zero rows and gets `undefined`, which is
 *     exactly the interface's idempotency contract.
 *   - cooldown / leader lock — `INSERT ... ON CONFLICT DO UPDATE ... WHERE
 *     <expired> RETURNING`. A caller that returns a row won; one that returns
 *     nothing lost. Expired rows are overwritten in place, so neither table
 *     needs sweeping.
 *
 * ## Nulls
 *
 * The domain types use optional properties (`resolvedAt?: number`) and Postgres
 * returns `null`. Every read goes through a row mapper below that converts back,
 * so `null` never escapes this file — a `null` reaching `AuditEvent.agentId`
 * would silently break the `agentId === undefined` checks callers make.
 */
import { and, asc, desc, eq, isNull, lte } from 'drizzle-orm';
import type {
  ActionLogEntry,
  AgentDefinition,
  AgentRuntimeState,
  ApiKeyRecord,
  Approval,
  ApprovalStatus,
  AuditEvent,
  DriftHistoryEntry,
  StateStore,
  ToolCallApproval,
} from '@driftwatch/sdk';
import type { Database } from './client.js';
import {
  DEFAULT_ORGANIZATION_ID,
  actionLog,
  agentState,
  agents,
  apiKeys,
  approvals,
  auditEvents,
  cooldowns,
  driftHistory,
  leaderLocks,
  toolCallApprovals,
} from './schema.js';

export interface PostgresStateStoreOptions {
  db: Database;
  /**
   * Tenant every read is filtered by and every write is stamped with. Defaults
   * to the single-tenant organization a self-hosted deployment seeds at boot.
   */
  organizationId?: string;
  /** Called on `close()`. Set by the factory that owns the pool. */
  onClose?: () => Promise<void>;
}

export class PostgresStateStore implements StateStore {
  private readonly db: Database;
  private readonly organizationId: string;
  private readonly onClose: (() => Promise<void>) | undefined;

  constructor(options: PostgresStateStoreOptions) {
    this.db = options.db;
    this.organizationId = options.organizationId ?? DEFAULT_ORGANIZATION_ID;
    this.onClose = options.onClose;
  }

  // --- API keys -------------------------------------------------------------

  async createApiKey(record: ApiKeyRecord): Promise<void> {
    await this.db.insert(apiKeys).values({
      id: record.id,
      organizationId: this.organizationId,
      name: record.name,
      prefix: record.prefix,
      hash: record.hash,
      scopes: record.scopes,
      agentIds: record.agentIds ?? null,
      createdAt: record.createdAt,
      createdBy: record.createdBy,
      lastUsedAt: record.lastUsedAt ?? null,
      expiresAt: record.expiresAt ?? null,
      revokedAt: record.revokedAt ?? null,
      revokedBy: record.revokedBy ?? null,
    });
  }

  /**
   * The authentication hot path — one indexed lookup per authenticated request.
   * Returns the record even when revoked or expired: the caller decides, so the
   * gate can answer "revoked" rather than "unknown token".
   */
  async getApiKeyByHash(hash: string): Promise<ApiKeyRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.hash, hash), eq(apiKeys.organizationId, this.organizationId)))
      .limit(1);
    return row ? toApiKeyRecord(row) : undefined;
  }

  async getApiKey(id: string): Promise<ApiKeyRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.id, id), eq(apiKeys.organizationId, this.organizationId)))
      .limit(1);
    return row ? toApiKeyRecord(row) : undefined;
  }

  async listApiKeys(): Promise<ApiKeyRecord[]> {
    const rows = await this.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.organizationId, this.organizationId))
      .orderBy(desc(apiKeys.createdAt));
    return rows.map(toApiKeyRecord);
  }

  /**
   * Soft revoke. The `revoked_at IS NULL` predicate is the idempotency guard —
   * a second revoke matches zero rows and returns undefined, same contract as
   * `resolveApproval`.
   */
  async revokeApiKey(id: string, revokedBy: string): Promise<ApiKeyRecord | undefined> {
    const [row] = await this.db
      .update(apiKeys)
      .set({ revokedAt: Date.now(), revokedBy })
      .where(
        and(
          eq(apiKeys.id, id),
          eq(apiKeys.organizationId, this.organizationId),
          isNull(apiKeys.revokedAt),
        ),
      )
      .returning();
    return row ? toApiKeyRecord(row) : undefined;
  }

  async touchApiKey(id: string, at: number): Promise<void> {
    await this.db
      .update(apiKeys)
      .set({ lastUsedAt: at })
      .where(and(eq(apiKeys.id, id), eq(apiKeys.organizationId, this.organizationId)));
  }

  // --- audit log ------------------------------------------------------------

  async recordAuditEvent(event: AuditEvent): Promise<void> {
    await this.db.insert(auditEvents).values({
      id: event.id,
      organizationId: this.organizationId,
      at: event.at,
      actor: event.actor,
      actorLabel: event.actorLabel,
      action: event.action,
      target: event.target ?? null,
      agentId: event.agentId ?? null,
      summary: event.summary,
    });
  }

  /**
   * Newest first. Ordered by `seq`, not `at`: several events routinely land in
   * the same millisecond and `at` alone is then a nondeterministic tie.
   */
  async listAuditEvents(limit: number, agentId?: string): Promise<AuditEvent[]> {
    const scope = eq(auditEvents.organizationId, this.organizationId);
    const rows = await this.db
      .select()
      .from(auditEvents)
      .where(agentId ? and(scope, eq(auditEvents.agentId, agentId)) : scope)
      .orderBy(desc(auditEvents.seq))
      .limit(limit);
    return rows.map(toAuditEvent);
  }

  // --- agent registry -------------------------------------------------------

  /**
   * Idempotent create-or-update keyed by id. Writes every column so a
   * re-registration that DROPS a field (an agent that no longer declares
   * `toolPolicies`) actually clears it — a partial upsert would leave the old
   * value behind and the agent would keep enforcing a rule its code no longer
   * declares, which is precisely the stale-policy failure this store exists to
   * make impossible.
   */
  async upsertAgent(definition: AgentDefinition): Promise<void> {
    const values = {
      id: definition.id,
      organizationId: this.organizationId,
      name: definition.name,
      owner: definition.owner ?? null,
      serviceName: definition.serviceName ?? null,
      createdAt: definition.createdAt,
      guardrails: definition.guardrails ?? null,
      guardrailsSource: definition.guardrailsSource ?? null,
      toolNames: definition.toolNames ?? null,
      driftDetectionEnabled: definition.driftDetectionEnabled ?? null,
      toolPolicies: definition.toolPolicies ?? null,
      toolPoliciesSource: definition.toolPoliciesSource ?? null,
    };
    await this.db
      .insert(agents)
      .values(values)
      .onConflictDoUpdate({
        target: agents.id,
        set: {
          name: values.name,
          owner: values.owner,
          serviceName: values.serviceName,
          guardrails: values.guardrails,
          guardrailsSource: values.guardrailsSource,
          toolNames: values.toolNames,
          driftDetectionEnabled: values.driftDetectionEnabled,
          toolPolicies: values.toolPolicies,
          toolPoliciesSource: values.toolPoliciesSource,
          // createdAt is deliberately NOT updated: re-registering an agent must
          // not reset when it first appeared.
        },
      });
  }

  async getAgentDefinition(agentId: string): Promise<AgentDefinition | undefined> {
    const [row] = await this.db
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.organizationId, this.organizationId)))
      .limit(1);
    return row ? toAgentDefinition(row) : undefined;
  }

  async listAgents(): Promise<AgentDefinition[]> {
    const rows = await this.db
      .select()
      .from(agents)
      .where(eq(agents.organizationId, this.organizationId))
      .orderBy(asc(agents.createdAt), asc(agents.id));
    return rows.map(toAgentDefinition);
  }

  // --- runtime state --------------------------------------------------------

  /** Synthesises a default for an unregistered agent, matching MemoryStateStore. */
  async getAgentState(agentId: string): Promise<AgentRuntimeState> {
    const [row] = await this.db
      .select()
      .from(agentState)
      .where(eq(agentState.agentId, agentId))
      .limit(1);
    if (!row) return { status: 'running', activeVersion: 1, updatedAt: Date.now() };
    return {
      status: row.status,
      activeModel: row.activeModel ?? undefined,
      activeVersion: row.activeVersion,
      updatedAt: row.updatedAt,
      reason: row.reason ?? undefined,
    };
  }

  async setAgentState(agentId: string, state: AgentRuntimeState): Promise<void> {
    const values = {
      agentId,
      organizationId: this.organizationId,
      status: state.status,
      activeModel: state.activeModel ?? null,
      activeVersion: state.activeVersion,
      updatedAt: state.updatedAt,
      reason: state.reason ?? null,
    };
    await this.db
      .insert(agentState)
      .values(values)
      .onConflictDoUpdate({
        target: agentState.agentId,
        set: {
          status: values.status,
          activeModel: values.activeModel,
          activeVersion: values.activeVersion,
          updatedAt: values.updatedAt,
          reason: values.reason,
        },
      });
  }

  // --- control approvals (Loop 2) -------------------------------------------

  async createApproval(approval: Approval): Promise<void> {
    await this.db.insert(approvals).values({
      id: approval.id,
      organizationId: this.organizationId,
      agentId: approval.agentId,
      action: approval.action,
      severity: approval.severity,
      reasons: approval.reasons,
      recommendedAction: approval.recommendedAction,
      status: approval.status,
      createdAt: approval.createdAt,
      expiresAt: approval.expiresAt,
      resolvedAt: approval.resolvedAt ?? null,
      resolvedBy: approval.resolvedBy ?? null,
      channel: approval.channel ?? null,
    });
  }

  async getApproval(id: string): Promise<Approval | undefined> {
    const [row] = await this.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, id), eq(approvals.organizationId, this.organizationId)))
      .limit(1);
    return row ? toApproval(row) : undefined;
  }

  async listPendingApprovals(agentId: string): Promise<Approval[]> {
    const rows = await this.db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.agentId, agentId),
          eq(approvals.status, 'pending'),
          eq(approvals.organizationId, this.organizationId),
        ),
      )
      .orderBy(asc(approvals.createdAt), asc(approvals.seq));
    return rows.map(toApproval);
  }

  /**
   * Atomic compare-and-set. The `status = 'pending'` predicate is the whole
   * mutual exclusion: two racing resolvers serialise on the row lock, the loser
   * matches nothing and gets `undefined`. This is what the Redis backend needed
   * a Lua script for.
   */
  async resolveApproval(
    id: string,
    status: Exclude<ApprovalStatus, 'pending'>,
    resolvedBy: string,
    channel: string,
  ): Promise<Approval | undefined> {
    const [row] = await this.db
      .update(approvals)
      .set({ status, resolvedBy, channel, resolvedAt: Date.now() })
      .where(
        and(
          eq(approvals.id, id),
          eq(approvals.status, 'pending'),
          eq(approvals.organizationId, this.organizationId),
        ),
      )
      .returning();
    return row ? toApproval(row) : undefined;
  }

  // --- tool-call approvals (Loop 3) -----------------------------------------

  async createToolCallApproval(approval: ToolCallApproval): Promise<void> {
    await this.db.insert(toolCallApprovals).values({
      id: approval.id,
      organizationId: this.organizationId,
      agentId: approval.agentId,
      tool: approval.tool,
      fieldPath: approval.fieldPath ?? null,
      matchedReason: approval.matchedReason ?? null,
      inputSummary: approval.inputSummary ?? null,
      status: approval.status,
      createdAt: approval.createdAt,
      expiresAt: approval.expiresAt,
      resolvedAt: approval.resolvedAt ?? null,
      resolvedBy: approval.resolvedBy ?? null,
      channel: approval.channel ?? null,
    });
  }

  async getToolCallApproval(id: string): Promise<ToolCallApproval | undefined> {
    const [row] = await this.db
      .select()
      .from(toolCallApprovals)
      .where(
        and(eq(toolCallApprovals.id, id), eq(toolCallApprovals.organizationId, this.organizationId)),
      )
      .limit(1);
    return row ? toToolCallApproval(row) : undefined;
  }

  async listPendingToolCallApprovals(agentId: string): Promise<ToolCallApproval[]> {
    const rows = await this.db
      .select()
      .from(toolCallApprovals)
      .where(
        and(
          eq(toolCallApprovals.agentId, agentId),
          eq(toolCallApprovals.status, 'pending'),
          eq(toolCallApprovals.organizationId, this.organizationId),
        ),
      )
      .orderBy(asc(toolCallApprovals.createdAt), asc(toolCallApprovals.seq));
    return rows.map(toToolCallApproval);
  }

  async resolveToolCallApproval(
    id: string,
    status: Exclude<ApprovalStatus, 'pending'>,
    resolvedBy: string,
    channel: string,
  ): Promise<ToolCallApproval | undefined> {
    const [row] = await this.db
      .update(toolCallApprovals)
      .set({ status, resolvedBy, channel, resolvedAt: Date.now() })
      .where(
        and(
          eq(toolCallApprovals.id, id),
          eq(toolCallApprovals.status, 'pending'),
          eq(toolCallApprovals.organizationId, this.organizationId),
        ),
      )
      .returning();
    return row ? toToolCallApproval(row) : undefined;
  }

  // --- history --------------------------------------------------------------

  async recordDriftVerdict(agentId: string, entry: DriftHistoryEntry): Promise<void> {
    await this.db.insert(driftHistory).values({
      id: entry.id,
      organizationId: this.organizationId,
      agentId,
      at: entry.at,
      drift: entry.drift,
      severity: entry.severity,
      reasons: entry.reasons,
      recommendedAction: entry.recommendedAction,
      baselineTokenSpend: entry.baselineTokenSpend,
      currentTokenSpend: entry.currentTokenSpend,
    });
  }

  async listDriftHistory(agentId: string, limit: number): Promise<DriftHistoryEntry[]> {
    const rows = await this.db
      .select()
      .from(driftHistory)
      .where(
        and(
          eq(driftHistory.agentId, agentId),
          eq(driftHistory.organizationId, this.organizationId),
        ),
      )
      .orderBy(desc(driftHistory.seq))
      .limit(limit);
    return rows.map((row) => ({
      id: row.id,
      at: row.at,
      drift: row.drift,
      severity: row.severity,
      reasons: row.reasons,
      recommendedAction: row.recommendedAction,
      baselineTokenSpend: row.baselineTokenSpend,
      currentTokenSpend: row.currentTokenSpend,
    }));
  }

  async recordAction(agentId: string, entry: ActionLogEntry): Promise<void> {
    await this.db.insert(actionLog).values({
      id: entry.id,
      organizationId: this.organizationId,
      agentId,
      at: entry.at,
      action: entry.action,
      category: entry.category,
      outcome: entry.outcome,
      reason: entry.reason,
      actor: entry.actor ?? null,
      channel: entry.channel ?? null,
    });
  }

  async listActionLog(agentId: string, limit: number): Promise<ActionLogEntry[]> {
    const rows = await this.db
      .select()
      .from(actionLog)
      .where(and(eq(actionLog.agentId, agentId), eq(actionLog.organizationId, this.organizationId)))
      .orderBy(desc(actionLog.seq))
      .limit(limit);
    return rows.map((row) => ({
      id: row.id,
      at: row.at,
      action: row.action,
      category: row.category,
      outcome: row.outcome,
      reason: row.reason,
      actor: row.actor ?? undefined,
      channel: row.channel ?? undefined,
    }));
  }

  // --- coordination ---------------------------------------------------------

  /**
   * True when the caller may proceed. One statement: insert if absent, or
   * overwrite an EXPIRED row. A row still in cooldown fails the `WHERE` on the
   * DO UPDATE branch, so nothing is returned and nothing is written — which is
   * both the answer and the mutual exclusion.
   */
  async checkAndSetCooldown(agentId: string, key: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const [row] = await this.db
      .insert(cooldowns)
      .values({ agentId, key, expiresAt: now + ttlMs })
      .onConflictDoUpdate({
        target: [cooldowns.agentId, cooldowns.key],
        set: { expiresAt: now + ttlMs },
        setWhere: lte(cooldowns.expiresAt, now),
      })
      .returning({ agentId: cooldowns.agentId });
    return row !== undefined;
  }

  /** Same single-statement acquire as the cooldown, keyed globally. */
  async acquireLeaderLock(key: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const [row] = await this.db
      .insert(leaderLocks)
      .values({ key, expiresAt: now + ttlMs, holder: process.pid.toString() })
      .onConflictDoUpdate({
        target: leaderLocks.key,
        set: { expiresAt: now + ttlMs, holder: process.pid.toString() },
        setWhere: lte(leaderLocks.expiresAt, now),
      })
      .returning({ key: leaderLocks.key });
    return row !== undefined;
  }

  /**
   * Expires every approval and tool-call approval whose deadline has passed.
   *
   * Not part of `StateStore` — an extra Postgres-only affordance. The in-memory
   * and Redis stores let stale pending rows linger (Redis TTLs them out of the
   * pending index); a durable store keeps them forever, so a pending queue would
   * fill with dead entries that block nothing but look actionable. Called on the
   * scheduler tick.
   */
  async expireStaleApprovals(now = Date.now()): Promise<number> {
    const expirePending = (table: typeof approvals | typeof toolCallApprovals) =>
      this.db
        .update(table)
        .set({ status: 'expired', resolvedAt: now, channel: 'timeout' })
        .where(
          and(
            eq(table.status, 'pending'),
            lte(table.expiresAt, now),
            eq(table.organizationId, this.organizationId),
          ),
        )
        .returning({ id: table.id });

    const [control, toolCalls] = await Promise.all([
      expirePending(approvals),
      expirePending(toolCallApprovals),
    ]);
    return control.length + toolCalls.length;
  }

  /**
   * Deletes cooldown rows that can never be read again. Everything else in this
   * schema is deliberately retained — durable history is the point of the
   * backend. Expired sessions are better-auth's to clean up, not this store's.
   */
  async pruneExpired(now = Date.now()): Promise<void> {
    await this.db.delete(cooldowns).where(lte(cooldowns.expiresAt, now));
  }

  async close(): Promise<void> {
    await this.onClose?.();
  }
}

// --- row mappers ------------------------------------------------------------
// Postgres returns null for an absent value; the domain types use optional
// properties. These are the only place that conversion happens.

type ApiKeyRow = typeof apiKeys.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type ApprovalRow = typeof approvals.$inferSelect;
type ToolCallApprovalRow = typeof toolCallApprovals.$inferSelect;
type AuditEventRow = typeof auditEvents.$inferSelect;

function toApiKeyRecord(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    hash: row.hash,
    scopes: row.scopes,
    agentIds: row.agentIds ?? undefined,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    lastUsedAt: row.lastUsedAt ?? undefined,
    expiresAt: row.expiresAt ?? undefined,
    revokedAt: row.revokedAt ?? undefined,
    revokedBy: row.revokedBy ?? undefined,
  };
}

function toAgentDefinition(row: AgentRow): AgentDefinition {
  return {
    id: row.id,
    name: row.name,
    owner: row.owner ?? undefined,
    serviceName: row.serviceName ?? undefined,
    createdAt: row.createdAt,
    guardrails: row.guardrails ?? undefined,
    guardrailsSource: row.guardrailsSource ?? undefined,
    toolNames: row.toolNames ?? undefined,
    driftDetectionEnabled: row.driftDetectionEnabled ?? undefined,
    toolPolicies: row.toolPolicies ?? undefined,
    toolPoliciesSource: row.toolPoliciesSource ?? undefined,
  };
}

function toApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    agentId: row.agentId,
    action: row.action,
    severity: row.severity,
    reasons: row.reasons,
    recommendedAction: row.recommendedAction,
    status: row.status,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    resolvedAt: row.resolvedAt ?? undefined,
    resolvedBy: row.resolvedBy ?? undefined,
    channel: row.channel ?? undefined,
  };
}

function toToolCallApproval(row: ToolCallApprovalRow): ToolCallApproval {
  return {
    id: row.id,
    agentId: row.agentId,
    tool: row.tool,
    fieldPath: row.fieldPath ?? undefined,
    matchedReason: row.matchedReason ?? undefined,
    inputSummary: row.inputSummary ?? undefined,
    status: row.status,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    resolvedAt: row.resolvedAt ?? undefined,
    resolvedBy: row.resolvedBy ?? undefined,
    channel: row.channel ?? undefined,
  };
}

function toAuditEvent(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    at: row.at,
    actor: row.actor,
    actorLabel: row.actorLabel,
    action: row.action,
    target: row.target ?? undefined,
    agentId: row.agentId ?? undefined,
    summary: row.summary,
  };
}
