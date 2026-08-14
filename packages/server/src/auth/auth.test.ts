/**
 * End-to-end verification of the built-in auth path.
 *
 * These assertions are the ones that matter for the change: that an admin gets
 * seeded from the environment, that a real login returns a usable session
 * cookie, that the cookie resolves to a `user` principal with role-derived
 * scopes, and — most importantly — that public sign-up is closed. A unit test of
 * `scopesForRole` would prove none of that.
 *
 * Requires a real Postgres (better-auth has no in-memory mode worth testing
 * against), so the whole file is skipped without TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { sql } from 'drizzle-orm';
import { MemoryStateStore } from '@driftwatch/sdk';
import { createDatabase, type DatabaseHandle } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { seedOrganization } from '../db/seed.js';
import { createAuth, type Auth } from './auth.js';
import { seedAdminUser } from './seed-admin.js';
import { registerAuthRoutes } from '../routes/auth-routes.js';
import { createAuthGate, type Principal } from '../routes/auth.js';
import { ROLE_SCOPES, scopesForRole } from './roles.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

const ADMIN_EMAIL = 'admin@driftwatch.test';
const ADMIN_PASSWORD = 'correct-horse-battery-staple';

describe('roles', () => {
  it('maps an unknown role to the least privilege, not the most', () => {
    // A typo'd or removed role must never silently widen access.
    expect(scopesForRole('superuser')).toEqual(ROLE_SCOPES.viewer);
    expect(scopesForRole(null)).toEqual(ROLE_SCOPES.viewer);
    expect(scopesForRole(undefined)).toEqual(ROLE_SCOPES.viewer);
  });

  it('withholds key minting from operators', () => {
    // An operator who can mint a fleet-wide key can grant themselves admin,
    // which would make the whole role distinction decorative.
    expect(ROLE_SCOPES.operator).not.toContain('keys:admin');
    expect(ROLE_SCOPES.admin).toContain('keys:admin');
  });
});

describe.skipIf(!testDatabaseUrl)('built-in auth', () => {
  let handle: DatabaseHandle;
  let auth: Auth;
  let server: FastifyInstance;
  /** Captured by the probe route below on each authenticated request. */
  let lastPrincipal: Principal | undefined;

  beforeAll(async () => {
    handle = createDatabase({ connectionString: testDatabaseUrl!, maxConnections: 4 });
    await runMigrations({ db: handle.db });
    await seedOrganization(handle.db);
    await handle.db.execute(sql`truncate table "user", session, account, verification cascade`);

    auth = createAuth({
      db: handle.db,
      secret: 'test-secret-that-is-long-enough-to-sign',
      baseUrl: 'http://localhost:3000',
    });

    server = Fastify();
    await server.register(rateLimit, { global: false, max: 1000, timeWindow: 60_000 });
    await registerAuthRoutes(server, { auth });

    const authorize = createAuthGate({
      store: new MemoryStateStore(),
      authToken: '',
      auth,
    });
    // A stand-in for any real control-plane route: it does nothing but run the
    // gate and expose which principal came out.
    server.get('/probe', async (request, reply) => {
      const principal = await authorize(request, reply, { scope: 'read' });
      lastPrincipal = principal;
      if (!principal) return reply;
      return reply.send({ kind: principal.kind, id: principal.id });
    });
    server.get('/probe-admin', async (request, reply) => {
      const principal = await authorize(request, reply, { scope: 'keys:admin', fleetWide: true });
      if (!principal) return reply;
      return reply.send({ ok: true });
    });
    await server.ready();
  });

  afterAll(async () => {
    await server?.close();
    await handle?.close();
  });

  it('seeds exactly one admin, and does not re-seed on a second boot', async () => {
    const first = await seedAdminUser({
      auth,
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });
    expect(first).toEqual({ seeded: true, email: ADMIN_EMAIL });

    // The critical property: a restart must not reapply the environment
    // password over an operator's own.
    const second = await seedAdminUser({
      auth,
      email: ADMIN_EMAIL,
      password: 'a-completely-different-password',
    });
    expect(second).toEqual({ seeded: false, reason: 'users-exist' });
  });

  it('refuses to seed a password below the minimum length', async () => {
    const result = await seedAdminUser({ auth, email: 'weak@test.local', password: 'short' });
    expect(result).toEqual({ seeded: false, reason: 'password-too-short' });
  });

  it('refuses public sign-up', async () => {
    // If this ever passes, anything that can reach the instance can create
    // itself an account.
    const response = await server.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: { email: 'intruder@test.local', password: 'another-long-password', name: 'x' },
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('rejects the wrong password', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: ADMIN_EMAIL, password: 'not-the-password' },
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('issues an httpOnly session cookie on a correct login', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    const setCookie = response.headers['set-cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie.join('; ') : String(setCookie);
    // httpOnly is what makes this immune to the XSS token theft that the old
    // localStorage bearer was exposed to.
    expect(cookies.toLowerCase()).toContain('httponly');
    expect(cookies.toLowerCase()).toContain('samesite=lax');
  });

  it('resolves the session cookie to a user principal with admin scopes', async () => {
    const login = await server.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    const cookie = sessionCookieFrom(login.headers['set-cookie']);

    const probe = await server.inject({ method: 'GET', url: '/probe', headers: { cookie } });
    expect(probe.statusCode).toBe(200);
    expect(probe.json()).toMatchObject({ kind: 'user' });
    expect(lastPrincipal?.label).toBe(ADMIN_EMAIL);
    expect(lastPrincipal?.scopes).toEqual(ROLE_SCOPES.admin);
    // Seeded accounts are flagged so the console can insist on a real password.
    expect(lastPrincipal?.mustChangePassword).toBe(true);

    // The admin role must actually carry through to a fleet-wide scope check.
    const adminProbe = await server.inject({
      method: 'GET',
      url: '/probe-admin',
      headers: { cookie },
    });
    expect(adminProbe.statusCode).toBe(200);
  });

  it('rejects a request with no credential at all', async () => {
    const response = await server.inject({ method: 'GET', url: '/probe' });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a forged session cookie', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/probe',
      headers: { cookie: 'better-auth.session_token=not-a-real-token' },
    });
    expect(response.statusCode).toBe(401);
  });
});

/** Pulls just the session cookie name=value pairs out of a Set-Cookie header. */
function sessionCookieFrom(setCookie: string | string[] | undefined): string {
  const values = Array.isArray(setCookie) ? setCookie : [setCookie ?? ''];
  return values
    .map((value) => value.split(';')[0])
    .filter(Boolean)
    .join('; ');
}
