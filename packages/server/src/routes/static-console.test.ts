import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerConsoleStatic } from './static-console.js';

const INDEX_HTML = '<!doctype html><html><body><div id="root"></div></body></html>';

let consoleDistDir: string;
let app: FastifyInstance | undefined;

beforeAll(() => {
  // A real directory — @fastify/static stats the filesystem, so a mock won't do.
  consoleDistDir = mkdtempSync(join(tmpdir(), 'dw-console-dist-'));
  writeFileSync(join(consoleDistDir, 'index.html'), INDEX_HTML);
  mkdirSync(join(consoleDistDir, 'assets'));
  writeFileSync(join(consoleDistDir, 'assets', 'app-abc123.js'), 'console.log(1)');
});

afterAll(() => {
  rmSync(consoleDistDir, { recursive: true, force: true });
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function buildApp(): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false });
  // Representative server routes at their real paths, so the tests can prove the
  // root-level not-found handler does not swallow API 404s now that it is no
  // longer confined to a /console prefix.
  fastify.get('/api/v1/agents', async () => ({ agents: [] }));
  fastify.get('/health', async () => ({ ok: true }));
  await registerConsoleStatic(fastify, { consoleDistDir });
  await fastify.ready();
  app = fastify;
  return fastify;
}

describe('console static + SPA fallback at the root', () => {
  it('serves index.html at /', async () => {
    const fastify = await buildApp();
    const response = await fastify.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<div id="root">');
  });

  it('serves real asset files normally', async () => {
    const fastify = await buildApp();
    const response = await fastify.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('console.log(1)');
  });

  it('falls back to index.html for a client-side deep link', async () => {
    const fastify = await buildApp();
    const response = await fastify.inject({ method: 'GET', url: '/agents/payment-agent/config' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<div id="root">');
  });

  it('serves the login route from the SPA shell', async () => {
    const fastify = await buildApp();
    const response = await fastify.inject({ method: 'GET', url: '/login' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<div id="root">');
  });

  it('marks the fallback no-store so a stale index.html cannot reference deleted chunks', async () => {
    const fastify = await buildApp();
    const response = await fastify.inject({ method: 'GET', url: '/agents/foo' });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('404s a missing asset instead of returning HTML under a .js URL', async () => {
    const fastify = await buildApp();
    const response = await fastify.inject({ method: 'GET', url: '/assets/does-not-exist.js' });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('<div id="root">');
  });

  it('404s any dotted filename outside /assets/ too', async () => {
    const fastify = await buildApp();
    const response = await fastify.inject({ method: 'GET', url: '/favicon.ico' });
    expect(response.statusCode).toBe(404);
  });

  it('ignores the query string when deciding whether a path is an asset', async () => {
    const fastify = await buildApp();
    const deepLink = await fastify.inject({ method: 'GET', url: '/agents/foo?tab=config' });
    expect(deepLink.statusCode).toBe(200);
    expect(deepLink.body).toContain('<div id="root">');
  });

  it('does not fall back for non-GET/HEAD methods', async () => {
    const fastify = await buildApp();
    const response = await fastify.inject({ method: 'POST', url: '/agents/foo' });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('<div id="root">');
  });

  // --- the guards that the move to the root made load-bearing ---------------

  it('leaves an unmatched API path as a JSON 404, not the SPA shell', async () => {
    const fastify = await buildApp();
    const response = await fastify.inject({ method: 'GET', url: '/api/v1/no-such-route' });
    expect(response.statusCode).toBe(404);
    // Returning HTML here would make an SDK client fail on JSON.parse('<')
    // instead of seeing a clean 404.
    expect(response.body).not.toContain('<div id="root">');
    expect(response.json()).toMatchObject({ error: 'not found' });
  });

  it('leaves an unmatched better-auth path as a JSON 404', async () => {
    const fastify = await buildApp();
    const response = await fastify.inject({ method: 'GET', url: '/api/auth/nonsense' });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('<div id="root">');
  });

  it('leaves an unmatched webhook path as a JSON 404', async () => {
    const fastify = await buildApp();
    const response = await fastify.inject({ method: 'GET', url: '/integrations/unknown' });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('<div id="root">');
  });

  it('leaves matched API routes working', async () => {
    const fastify = await buildApp();
    const response = await fastify.inject({ method: 'GET', url: '/api/v1/agents' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ agents: [] });
  });

  it('leaves /health working — orchestrator probes must not get HTML', async () => {
    const fastify = await buildApp();
    const response = await fastify.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });
});
