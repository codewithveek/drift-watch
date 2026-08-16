import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  MemoryStateStore,
  mintApiKey,
  type ApiKeyScope,
  type StateStore,
} from '@driftwatch/sdk';
import { createAuthGate, type AuthRequirement } from './auth.js';

let app: FastifyInstance | undefined;

/**
 * A bare probe route per requirement, so these tests exercise the gate itself
 * rather than any particular business route's extra validation.
 */
async function buildProbe(
  requirements: Record<string, AuthRequirement>,
): Promise<{ fastify: FastifyInstance; store: StateStore }> {
  const store = new MemoryStateStore();
  // No `auth`: these probes model a deployment with no database, which is the
  // only configuration in which the local-network path is still open.
  const authorize = createAuthGate({ store });
  const fastify = Fastify({ logger: false });

  for (const [path, requirement] of Object.entries(requirements)) {
    fastify.get(`/${path}`, async (request, reply) => {
      const principal = await authorize(request, reply, requirement);
      if (!principal) return;
      return { principalId: principal.id, kind: principal.kind };
    });
  }
  await fastify.ready();
  app = fastify;
  return { fastify, store };
}

async function seedKey(
  store: StateStore,
  scopes: ApiKeyScope[],
  extras: { agentIds?: string[]; expiresAt?: number } = {},
) {
  const { record, token } = mintApiKey({ name: 'k', scopes, createdBy: 'root', ...extras });
  await store.createApiKey(record);
  return { record, token, headers: { authorization: `Bearer ${token}` } };
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('principal resolution', () => {
  it('trusts an unauthenticated local request when there is no login configured', async () => {
    // The last remaining credential-free path, and it exists so `pnpm dev`
    // needs no setup. It closes the moment a database (and therefore a login)
    // is configured — see routes/auth.ts.
    const { fastify } = await buildProbe({ read: { scope: 'read' } });
    const local = await fastify.inject({
      method: 'GET',
      url: '/read',
      remoteAddress: '127.0.0.1',
    });
    expect(local.statusCode).toBe(200);
    expect(local.json()).toMatchObject({ kind: 'local' });
  });

  it('refuses a remote unauthenticated request', async () => {
    const { fastify } = await buildProbe({ read: { scope: 'read' } });
    const remote = await fastify.inject({
      method: 'GET',
      url: '/read',
      remoteAddress: '203.0.113.5',
    });
    expect(remote.statusCode).toBe(401);
  });

  it('401s a bearer that matches nothing, even from localhost', async () => {
    // Behaviour change from the old flat gate, and deliberate: silently
    // downgrading a bad credential to local trust makes a stale token in
    // localStorage look like it is working when it is being ignored.
    const { fastify } = await buildProbe({ read: { scope: 'read' } });
    const response = await fastify.inject({
      method: 'GET',
      url: '/read',
      headers: { authorization: 'Bearer stale-token' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('authenticates a minted key and reports it as the principal', async () => {
    const { fastify, store } = await buildProbe({ read: { scope: 'read' } });
    const { record, headers } = await seedKey(store, ['read']);

    const response = await fastify.inject({ method: 'GET', url: '/read', headers });
    expect(response.json()).toEqual({ principalId: record.id, kind: 'api-key' });
  });

  it('authenticates a minted key from a remote address', async () => {
    const { fastify, store } = await buildProbe({ read: { scope: 'read' } });
    const { headers } = await seedKey(store, ['read']);
    expect((await fastify.inject({ method: 'GET', url: '/read', headers })).statusCode).toBe(200);
  });

  it('distinguishes revoked from expired from unknown', async () => {
    const { fastify, store } = await buildProbe({ read: { scope: 'read' } });

    const revoked = await seedKey(store, ['read']);
    await store.revokeApiKey(revoked.record.id, 'root');
    const revokedResponse = await fastify.inject({
      method: 'GET',
      url: '/read',
      headers: revoked.headers,
    });
    expect(revokedResponse.statusCode).toBe(401);
    expect(revokedResponse.json().error).toBe('api key revoked');

    const expired = await seedKey(store, ['read'], { expiresAt: Date.now() - 1 });
    const expiredResponse = await fastify.inject({
      method: 'GET',
      url: '/read',
      headers: expired.headers,
    });
    expect(expiredResponse.json().error).toBe('api key expired');

    const unknown = await fastify.inject({
      method: 'GET',
      url: '/read',
      headers: { authorization: 'Bearer dw_not-a-real-key' },
    });
    expect(unknown.json().error).toBe('unauthorized');
  });

  it('records last-used coarsely rather than on every request', async () => {
    const { fastify, store } = await buildProbe({ read: { scope: 'read' } });
    const { record, headers } = await seedKey(store, ['read']);

    await fastify.inject({ method: 'GET', url: '/read', headers });
    const first = (await store.getApiKey(record.id))!.lastUsedAt;
    expect(first).toBeTypeOf('number');

    await fastify.inject({ method: 'GET', url: '/read', headers });
    // Second call inside the touch interval must not have written again.
    expect((await store.getApiKey(record.id))!.lastUsedAt).toBe(first);
  });
});

describe('scope enforcement', () => {
  it('403s a missing scope and names it', async () => {
    const { fastify, store } = await buildProbe({ write: { scope: 'policy:write' } });
    const { headers } = await seedKey(store, ['read']);

    const response = await fastify.inject({ method: 'GET', url: '/write', headers });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe('missing required scope: policy:write');
  });

  it('requires ALL scopes when a route declares several', async () => {
    const { fastify, store } = await buildProbe({
      both: { scope: ['agents:write', 'policy:write'] },
    });

    const partial = await seedKey(store, ['agents:write']);
    const denied = await fastify.inject({ method: 'GET', url: '/both', headers: partial.headers });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe('missing required scope: policy:write');

    const full = await seedKey(store, ['agents:write', 'policy:write']);
    expect(
      (await fastify.inject({ method: 'GET', url: '/both', headers: full.headers })).statusCode,
    ).toBe(200);
  });
});

describe('agent scoping', () => {
  it('allows the agents a key holds and 403s the ones it does not', async () => {
    const { fastify, store } = await buildProbe({
      one: { scope: 'read', agentId: 'agent-1' },
      two: { scope: 'read', agentId: 'agent-2' },
    });
    const { headers } = await seedKey(store, ['read'], { agentIds: ['agent-1'] });

    expect((await fastify.inject({ method: 'GET', url: '/one', headers })).statusCode).toBe(200);

    const denied = await fastify.inject({ method: 'GET', url: '/two', headers });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe('this key is not scoped to agent: agent-2');
  });

  it('lets a fleet-wide key reach any agent', async () => {
    const { fastify, store } = await buildProbe({
      any: { scope: 'read', agentId: 'whatever' },
    });
    const { headers } = await seedKey(store, ['read']);
    expect((await fastify.inject({ method: 'GET', url: '/any', headers })).statusCode).toBe(200);
  });

  it('refuses fleet-wide operations from an agent-scoped key', async () => {
    const { fastify, store } = await buildProbe({
      fleet: { scope: 'control:write', fleetWide: true },
    });

    const scoped = await seedKey(store, ['control:write'], { agentIds: ['agent-1'] });
    const denied = await fastify.inject({ method: 'GET', url: '/fleet', headers: scoped.headers });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toContain('cannot perform fleet-wide operations');

    const unscoped = await seedKey(store, ['control:write']);
    expect(
      (await fastify.inject({ method: 'GET', url: '/fleet', headers: unscoped.headers }))
        .statusCode,
    ).toBe(200);
  });
});
