/**
 * Per-agent tool descriptions, as synced by an SDK client.
 *
 * The console's policy editor needs to know which tools an agent has and which
 * fields they accept, or field-scoped rules cannot be authored at all. For an
 * in-process agent that information comes from this server's own registry
 * (../tools.ts); for an SDK-registered agent — the case that now matters most —
 * only the client knows, so it ships it at sync time.
 *
 * ## Why this is not on the StateStore interface
 *
 * `StateStore` is the SDK's contract, implemented by anyone bringing their own
 * backend, and every method on it participates in enforcement: state, approvals,
 * policies, audit. Tool descriptions are REFERENCE DATA for a UI — nothing about
 * gating reads them, and a deployment with no console needs none of it. Adding
 * three methods to a 31-method interface that custom implementors must satisfy,
 * to serve a display concern, is the kind of accretion that makes an interface
 * hostile to implement.
 *
 * So it lives here, Postgres-only, and degrades to the server's own registry
 * when the backend cannot store it. That degradation is why the Redis and memory
 * backends remain fully usable — they just show the built-in tools.
 */
import { and, eq } from 'drizzle-orm';
import type { StateStore } from '@driftwatch/sdk';
import { PostgresStateStore } from '../db/postgres-store.js';
import { agentTools, DEFAULT_ORGANIZATION_ID } from '../db/schema.js';

/** Mirrors `SyncedToolMetadata` in the SDK and `ToolMetadata` in ../tools.ts. */
export interface AgentToolRecord {
  name: string;
  description: string;
  fields: string[];
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
  sensitiveFields?: string[];
}

/**
 * Reaches the drizzle handle a `PostgresStateStore` holds.
 *
 * A deliberate, narrow escape hatch rather than widening `StateStore`: this is
 * the one feature that is genuinely Postgres-only, and an `instanceof` check
 * that returns undefined for every other backend is more honest than an
 * interface method three implementations would have to stub out.
 */
function databaseOf(store: StateStore) {
  return store instanceof PostgresStateStore ? store.database : undefined;
}

/**
 * Replaces an agent's tool set wholesale.
 *
 * Delete-then-insert rather than upsert: a tool the code no longer declares must
 * disappear, or the console would keep offering policy rules for a tool that can
 * never be called — and a rule that can never fire looks like protection while
 * providing none.
 */
export async function saveAgentTools(
  store: StateStore,
  agentId: string,
  tools: { name: string; description?: string; fields?: string[]; readOnly?: boolean; destructive?: boolean; idempotent?: boolean }[],
): Promise<void> {
  const db = databaseOf(store);
  if (!db) return;

  const syncedAt = Date.now();
  await db.transaction(async (tx) => {
    await tx.delete(agentTools).where(eq(agentTools.agentId, agentId));
    if (tools.length === 0) return;
    await tx.insert(agentTools).values(
      tools.map((tool) => ({
        agentId,
        name: tool.name,
        organizationId: DEFAULT_ORGANIZATION_ID,
        description: tool.description ?? '',
        fields: tool.fields ?? [],
        readOnly: tool.readOnly ?? false,
        destructive: tool.destructive ?? false,
        idempotent: tool.idempotent ?? false,
        syncedAt,
      })),
    );
  });
}

/** An agent's synced tools, or undefined when it has none (or the backend can't store them). */
export async function listAgentTools(
  store: StateStore,
  agentId: string,
): Promise<AgentToolRecord[] | undefined> {
  const db = databaseOf(store);
  if (!db) return undefined;

  const rows = await db
    .select()
    .from(agentTools)
    .where(
      and(eq(agentTools.agentId, agentId), eq(agentTools.organizationId, DEFAULT_ORGANIZATION_ID)),
    );
  if (rows.length === 0) return undefined;

  return rows
    .map((row) => ({
      name: row.name,
      description: row.description,
      fields: row.fields,
      readOnly: row.readOnly,
      destructive: row.destructive,
      idempotent: row.idempotent,
      ...(row.sensitiveFields ? { sensitiveFields: row.sensitiveFields } : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
