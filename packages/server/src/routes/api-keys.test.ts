import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  DriftWatchConfigSchema,
  MemoryStateStore,
  ApprovalService,
  type ApiKeyScope,
  type AutopilotScheduler,
} from '@driftwatch/sdk';
import { registerApiKeyRoutes } from './api-keys.js';
import { registerConsoleRoutes } from './console.js';
import { createAuthGate } from './auth.js';
import { createAuditRecorder } from './audit.js';
import { ServerConfigSchema, type ServerConfig } from '../config/server-config.js';

let app: FastifyInstance | undefined;

const ROOT = 'root-secret';

/**
 * Every test here sets AUTH_TOKEN. Without it the gate's dev local-network
 * path grants full scopes to fastify.inject (which reports 127.0.0.1), and
 * nothing about scoping would actually be exercised.
 */
async function buildApp(overrides: Partial<ServerConfig> = {}) {
  const config = ServerConfigSchema.parse({ authToken: ROOT, ...overrides });
  const store = new MemoryStateStore();
  const approvalService = new ApprovalService({
    store,
    notifiers: { list: [] },
    approvalTimeoutMs: 60_000,
    timeoutDecision: 'rejected',
  });
  const fastify = Fastify({ logger: false });
  const authorize = createAuthGate({ store, authToken: config.authToken });
  const recordAudit = createAuditRecorder(store);

  await registerApiKeyRoutes(fastify, { store, authorize, recordAudit });
  await registerConsoleRoutes(fastify, {
    store,
    serverConfig: config,
    driftWatchConfig: DriftWatchConfigSchema.parse({}),
    approvalService,
    scheduler: {
      async runCycleForAgent(agentId: string) {
        return { agentId, intents: [] };
      },
      async runCycle() {
        return { results: [] };
      },
    } as unknown as AutopilotScheduler,
    authorize,
    recordAudit,
  });
  await fastify.ready();
  app = fastify;
  return { fastify, store };
}

const asRoot = (token = ROOT) => ({ authorization: `Bearer ${token}` });

/** Mints a key through the real HTTP route and returns its plaintext token. */
async function mintKey(
  fastify: FastifyInstance,
  body: { name?: string; scopes: ApiKeyScope[]; agentIds?: string[]; expiresAt?: number },
  actorToken = ROOT,
): Promise<{ token: string; id: string; statusCode: number; json: () => any }> {
  const response = await fastify.inject({
    method: 'POST',
    url: '/api-keys',
    headers: asRoot(actorToken),
    payload: { name: 'test key', ...body },
  });
  const parsed = response.statusCode === 201 ? response.json() : { token: '', key: { id: '' } };
  return {
    token: parsed.token,
    id: parsed.key.id,
    statusCode: response.statusCode,
    json: () => response.json(),
  };
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('POST /api-keys', () => {
  it('returns the plaintext token exactly once and never stores it', async () => {
    const { fastify, store } = await buildApp();

    const created = await mintKey(fastify, { scopes: ['read'] });
    expect(created.statusCode).toBe(201);
    expect(created.token).toMatch(/^dw_/);

    // Not in the create response's key object, not in the listing, not in the store.
    expect(created.json().key.hash).toBeUndefined();
    const listed = await fastify.inject({ method: 'GET', url: '/api-keys', headers: asRoot() });
    expect(JSON.stringify(listed.json())).not.toContain(created.token);

    const stored = await store.getApiKey(created.id);
    expect(stored?.hash).toBeDefined();
    expect(JSON.stringify(stored)).not.toContain(created.token);
  });

  it('rejects an empty name, empty scopes, and unknown scopes', async () => {
    const { fastify } = await buildApp();

    const noName = await fastify.inject({
      method: 'POST',
      url: '/api-keys',
      headers: asRoot(),
      payload: { name: '  ', scopes: ['read'] },
    });
    expect(noName.statusCode).toBe(400);

    const noScopes = await mintKey(fastify, { scopes: [] });
    expect(noScopes.statusCode).toBe(400);

    const bogus = await mintKey(fastify, { scopes: ['superuser' as ApiKeyScope] });
    expect(bogus.statusCode).toBe(400);
    expect(bogus.json().error).toContain('unknown scopes');
  });

  it('rejects scoping to an agent that does not exist', async () => {
    const { fastify } = await buildApp();
    const response = await mintKey(fastify, { scopes: ['read'], agentIds: ['ghost'] });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('unknown agent');
  });

  it('rejects an expiry in the past or absurdly far in the future', async () => {
    const { fastify } = await buildApp();

    const past = await mintKey(fastify, { scopes: ['read'], expiresAt: Date.now() - 1000 });
    expect(past.statusCode).toBe(400);

    const tooFar = await mintKey(fastify, {
      scopes: ['read'],
      expiresAt: Date.now() + 100 * 365 * 24 * 60 * 60 * 1000,
    });
    expect(tooFar.statusCode).toBe(400);
  });

  it('refuses to let a key grant scopes it does not itself hold', async () => {
    // Privilege escalation: without this, any keys:admin key could mint itself
    // a superuser key and every other scope restriction is decorative.
    const { fastify } = await buildApp();
    const admin = await mintKey(fastify, { scopes: ['read', 'keys:admin'] });

    const escalated = await mintKey(fastify, { scopes: ['policy:write'] }, admin.token);
    expect(escalated.statusCode).toBe(403);
    expect(escalated.json().error).toContain('cannot grant scopes you do not hold');

    // ...but it can mint a key at or below its own level.
    const fine = await mintKey(fastify, { scopes: ['read'] }, admin.token);
    expect(fine.statusCode).toBe(201);
  });
});

describe('GET /api-keys', () => {
  it('serves the scope catalogue so the console never hardcodes it', async () => {
    const { fastify } = await buildApp();
    const response = await fastify.inject({ method: 'GET', url: '/api-keys', headers: asRoot() });

    const { scopes } = response.json();
    expect(scopes.length).toBeGreaterThan(0);
    for (const scope of scopes) {
      expect(scope.name).toBeTypeOf('string');
      expect(scope.description).toBeTruthy();
    }
  });
});

describe('DELETE /api-keys/:id', () => {
  it('revokes the key, kills its access immediately, and is idempotent', async () => {
    const { fastify } = await buildApp();
    const key = await mintKey(fastify, { scopes: ['read'] });

    const before = await fastify.inject({
      method: 'GET',
      url: '/agents',
      headers: asRoot(key.token),
    });
    expect(before.statusCode).toBe(200);

    const revoked = await fastify.inject({
      method: 'DELETE',
      url: `/api-keys/${key.id}`,
      headers: asRoot(),
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().key.revokedAt).toBeTypeOf('number');

    const after = await fastify.inject({
      method: 'GET',
      url: '/agents',
      headers: asRoot(key.token),
    });
    expect(after.statusCode).toBe(401);
    expect(after.json().error).toBe('api key revoked');

    const again = await fastify.inject({
      method: 'DELETE',
      url: `/api-keys/${key.id}`,
      headers: asRoot(),
    });
    expect(again.statusCode).toBe(409);
  });

  it('404s an unknown key', async () => {
    const { fastify } = await buildApp();
    const response = await fastify.inject({
      method: 'DELETE',
      url: '/api-keys/nope',
      headers: asRoot(),
    });
    expect(response.statusCode).toBe(404);
  });

  it('keeps the revoked record listed so past audit entries still resolve its name', async () => {
    const { fastify } = await buildApp();
    const key = await mintKey(fastify, { name: 'ci-deploy', scopes: ['read'] });
    await fastify.inject({ method: 'DELETE', url: `/api-keys/${key.id}`, headers: asRoot() });

    const listed = await fastify.inject({ method: 'GET', url: '/api-keys', headers: asRoot() });
    const found = listed.json().keys.find((entry: { id: string }) => entry.id === key.id);
    expect(found.name).toBe('ci-deploy');
    expect(found.revokedAt).toBeTypeOf('number');
  });
});

describe('key management requires a fleet-wide keys:admin principal', () => {
  it('403s an agent-scoped key even when it holds keys:admin', async () => {
    const { fastify, store } = await buildApp();
    await store.upsertAgent({ id: 'agent-1', name: 'Agent One', createdAt: 1 });
    const scoped = await mintKey(fastify, {
      scopes: ['read', 'keys:admin'],
      agentIds: ['agent-1'],
    });

    const listed = await fastify.inject({
      method: 'GET',
      url: '/api-keys',
      headers: asRoot(scoped.token),
    });
    expect(listed.statusCode).toBe(403);
    expect(listed.json().error).toContain('fleet-wide');
  });

  it('403s a fleet-wide key that lacks keys:admin', async () => {
    const { fastify } = await buildApp();
    const readOnly = await mintKey(fastify, { scopes: ['read'] });

    const listed = await fastify.inject({
      method: 'GET',
      url: '/api-keys',
      headers: asRoot(readOnly.token),
    });
    expect(listed.statusCode).toBe(403);
    expect(listed.json().error).toContain('keys:admin');
  });
});

describe('audit trail', () => {
  it('records the mint and the revoke, attributed to the principal, with no plaintext', async () => {
    const { fastify } = await buildApp();
    const key = await mintKey(fastify, { name: 'ci-deploy', scopes: ['read', 'agent:run'] });
    await fastify.inject({ method: 'DELETE', url: `/api-keys/${key.id}`, headers: asRoot() });

    const response = await fastify.inject({ method: 'GET', url: '/audit', headers: asRoot() });
    const { events } = response.json();

    expect(events.map((event: { action: string }) => event.action)).toEqual([
      'apikey.revoke',
      'apikey.create',
    ]);
    expect(events[0].actor).toBe('root');
    expect(events[0].actorLabel).toBe('AUTH_TOKEN');
    expect(JSON.stringify(events)).not.toContain(key.token);
  });

  it('names the fields a policy change touched, never their values', async () => {
    const { fastify, store } = await buildApp();
    await store.upsertAgent({ id: 'agent-1', name: 'Agent One', createdAt: 1 });

    await fastify.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      headers: asRoot(),
      payload: { guardrails: { maxTokensPerTask: 4242 } },
    });

    const { events } = (
      await fastify.inject({ method: 'GET', url: '/audit', headers: asRoot() })
    ).json();
    expect(events[0].action).toBe('policy.update');
    expect(events[0].agentId).toBe('agent-1');
    expect(events[0].summary).toContain('guardrails');
    expect(events[0].summary).not.toContain('4242');
  });

  it('attributes a change to the API key that made it, by name', async () => {
    const { fastify, store } = await buildApp();
    await store.upsertAgent({ id: 'agent-1', name: 'Agent One', createdAt: 1 });
    const key = await mintKey(fastify, {
      name: 'ops-console',
      scopes: ['agents:write'],
      agentIds: ['agent-1'],
    });

    await fastify.inject({
      method: 'PATCH',
      url: '/agents/agent-1',
      headers: asRoot(key.token),
      payload: { owner: 'platform' },
    });

    const { events } = (
      await fastify.inject({ method: 'GET', url: '/audit?agentId=agent-1', headers: asRoot() })
    ).json();
    expect(events[0].action).toBe('agent.update');
    expect(events[0].actor).toBe(key.id);
    expect(events[0].actorLabel).toBe('ops-console');
  });

  it('only lets an agent-scoped key read its own slice of the trail', async () => {
    const { fastify, store } = await buildApp();
    await store.upsertAgent({ id: 'agent-1', name: 'Agent One', createdAt: 1 });
    await store.upsertAgent({ id: 'agent-2', name: 'Agent Two', createdAt: 2 });
    const scoped = await mintKey(fastify, { scopes: ['read'], agentIds: ['agent-1'] });

    const fleetWide = await fastify.inject({
      method: 'GET',
      url: '/audit',
      headers: asRoot(scoped.token),
    });
    expect(fleetWide.statusCode).toBe(403);

    const own = await fastify.inject({
      method: 'GET',
      url: '/audit?agentId=agent-1',
      headers: asRoot(scoped.token),
    });
    expect(own.statusCode).toBe(200);

    const other = await fastify.inject({
      method: 'GET',
      url: '/audit?agentId=agent-2',
      headers: asRoot(scoped.token),
    });
    expect(other.statusCode).toBe(403);
  });
});
