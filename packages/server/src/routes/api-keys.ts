/**
 * API key management. Every route here needs `keys:admin` AND a fleet-wide
 * principal — key management is an administrative function, and letting an
 * agent-scoped key list the fleet's keys would leak the names and scopes of
 * credentials it has no business knowing about.
 *
 * The plaintext token exists in exactly one place in this codebase: the 201
 * response body of POST /api-keys. It is never stored, never logged, and never
 * returned again. Everything else works from `sha256(token)`.
 */
import type { FastifyInstance } from 'fastify';
import type { ApiKeyScope, StateStore } from '@driftwatch/sdk';
import {
  API_KEY_SCOPES,
  API_KEY_SCOPE_DESCRIPTIONS,
  isApiKeyScope,
  mintApiKey,
  toPublicApiKey,
} from '@driftwatch/sdk';
import { checkGrantIsWithinPrincipal, type AuthorizeFn } from './auth.js';
import type { AuditRecorder } from './audit.js';

export interface RegisterApiKeyRoutesOptions {
  store: StateStore;
  authorize: AuthorizeFn;
  recordAudit: AuditRecorder;
}

interface CreateApiKeyBody {
  name?: string;
  scopes?: unknown;
  agentIds?: unknown;
  /** Epoch ms. Omit for a key that never expires. */
  expiresAt?: unknown;
}

/** Longest a key may be valid for. Not a security boundary, a footgun guard. */
const MAX_EXPIRY_MS = 10 * 365 * 24 * 60 * 60 * 1000;

export async function registerApiKeyRoutes(
  fastifyServer: FastifyInstance,
  options: RegisterApiKeyRoutesOptions,
): Promise<void> {
  const { store, authorize, recordAudit } = options;

  fastifyServer.get('/api-keys', async (request, reply) => {
    const principal = await authorize(request, reply, { scope: 'keys:admin', fleetWide: true });
    if (!principal) return;
    const keys = await store.listApiKeys();
    // The scope catalogue rides along with the listing so the console never
    // hardcodes it: the SDK's runtime entry pulls in OpenTelemetry and must
    // not reach the browser bundle, so it can only import SDK *types*.
    return {
      keys: keys.map(toPublicApiKey),
      scopes: API_KEY_SCOPES.map((scope) => ({
        name: scope,
        description: API_KEY_SCOPE_DESCRIPTIONS[scope],
      })),
    };
  });

  fastifyServer.post<{ Body: CreateApiKeyBody }>('/api-keys', async (request, reply) => {
    const principal = await authorize(request, reply, { scope: 'keys:admin', fleetWide: true });
    if (!principal) return;

    const body = request.body ?? {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return reply.code(400).send({ error: 'name (non-empty string) required' });

    if (!Array.isArray(body.scopes) || body.scopes.length === 0) {
      return reply.code(400).send({ error: 'scopes (non-empty array) required' });
    }
    const unknownScopes = body.scopes.filter((scope) => !isApiKeyScope(scope));
    if (unknownScopes.length > 0) {
      return reply.code(400).send({
        error: `unknown scopes: ${unknownScopes.join(', ')}. Valid: ${API_KEY_SCOPES.join(', ')}`,
      });
    }
    const scopes = body.scopes as ApiKeyScope[];

    let agentIds: string[] | undefined;
    if (body.agentIds !== undefined) {
      if (!Array.isArray(body.agentIds) || body.agentIds.some((id) => typeof id !== 'string')) {
        return reply.code(400).send({ error: 'agentIds must be an array of agent ids' });
      }
      agentIds = body.agentIds as string[];
      // Scoping a key to an agent that doesn't exist is almost always a typo,
      // and it fails as a silent 403 much later rather than here.
      for (const agentId of agentIds) {
        if (!(await store.getAgentDefinition(agentId))) {
          return reply.code(400).send({ error: `unknown agent in agentIds: ${agentId}` });
        }
      }
    }

    let expiresAt: number | undefined;
    if (body.expiresAt !== undefined && body.expiresAt !== null) {
      if (typeof body.expiresAt !== 'number' || !Number.isFinite(body.expiresAt)) {
        return reply.code(400).send({ error: 'expiresAt must be a unix timestamp in milliseconds' });
      }
      const now = Date.now();
      if (body.expiresAt <= now) {
        return reply.code(400).send({ error: 'expiresAt must be in the future' });
      }
      if (body.expiresAt > now + MAX_EXPIRY_MS) {
        return reply.code(400).send({ error: 'expiresAt must be within 10 years' });
      }
      expiresAt = body.expiresAt;
    }

    const escalation = checkGrantIsWithinPrincipal(principal, scopes);
    if (escalation) return reply.code(403).send({ error: escalation });

    const { record, token } = mintApiKey({
      name,
      scopes,
      agentIds,
      createdBy: principal.id,
      expiresAt,
    });
    await store.createApiKey(record);
    await recordAudit(
      principal,
      {
        action: 'apikey.create',
        target: record.id,
        summary: `minted key "${name}" (${record.prefix}) with scopes ${scopes.join(', ')}; ${
          agentIds && agentIds.length > 0 ? `scoped to ${agentIds.join(', ')}` : 'fleet-wide'
        }`,
      },
      request.log,
    );

    // The only response in the whole API that carries a usable credential.
    return reply.code(201).send({ key: toPublicApiKey(record), token });
  });

  fastifyServer.delete<{ Params: { id: string } }>('/api-keys/:id', async (request, reply) => {
    const principal = await authorize(request, reply, { scope: 'keys:admin', fleetWide: true });
    if (!principal) return;

    const existing = await store.getApiKey(request.params.id);
    if (!existing) return reply.code(404).send({ error: 'unknown api key' });

    const revoked = await store.revokeApiKey(request.params.id, principal.id);
    if (!revoked) return reply.code(409).send({ error: 'api key already revoked' });

    await recordAudit(
      principal,
      {
        action: 'apikey.revoke',
        target: revoked.id,
        summary: `revoked key "${revoked.name}" (${revoked.prefix})`,
      },
      request.log,
    );
    return { key: toPublicApiKey(revoked) };
  });
}
