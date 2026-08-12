/**
 * Audit-on-write plumbing.
 *
 * Every control-plane mutation records who did it. This is the other half of
 * scoped API keys: scoping limits the blast radius of a leaked key, the audit
 * log is what tells you what that key actually touched before you noticed.
 *
 * Two rules the callers must honour:
 *   - `summary` names FIELDS, never values. A guardrail diff that printed the
 *     before/after of a secret would put the secret in a log that is, by
 *     design, readable by anyone with `read`.
 *   - Recording must never fail the request it describes. A store hiccup
 *     losing one audit line is bad; turning a successful pause into a 500 the
 *     operator then retries is worse.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditAction, AuditEvent, StateStore } from '@driftwatch/sdk';
import type { Principal } from './auth.js';

export interface AuditDetails {
  action: AuditAction;
  /** The record acted on: an agent id, an API key id, an approval id. */
  target?: string;
  /** Set when the event belongs to one agent, so it can be filtered per-agent. */
  agentId?: string;
  summary: string;
}

export type AuditRecorder = (
  principal: Principal,
  details: AuditDetails,
  log: FastifyBaseLogger,
) => Promise<void>;

export function createAuditRecorder(store: StateStore): AuditRecorder {
  return async function recordAudit(principal, details, log) {
    const event: AuditEvent = {
      id: randomUUID(),
      at: Date.now(),
      actor: principal.id,
      actorLabel: principal.label,
      ...details,
    };
    try {
      await store.recordAuditEvent(event);
    } catch (error) {
      log.error({ error, event }, 'failed to record audit event');
    }
  };
}

/** Fields on an agent write that require the `policy:write` scope. */
export const POLICY_FIELDS = [
  'guardrails',
  'guardrailsSource',
  'toolNames',
  'toolPolicies',
  'toolPoliciesSource',
] as const;

/**
 * True when a request body touches anything governing what an agent is allowed
 * to spend or call. `agents:write` covers identity (name/owner/serviceName);
 * loosening a spend cap or removing a tool gate is a separate permission.
 */
export function touchesPolicy(body: Record<string, unknown>): boolean {
  return POLICY_FIELDS.some((field) => body[field] !== undefined);
}

/** `guardrails, toolPolicies` — field names only, never their values. */
export function describeChangedFields(body: Record<string, unknown>): string {
  const changed = Object.keys(body).filter((key) => body[key] !== undefined);
  return changed.length > 0 ? changed.join(', ') : 'no fields';
}
