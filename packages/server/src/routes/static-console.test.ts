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
  // A representative API route, so we can prove the console's not-found handler
  // does not leak out of its prefix and swallow API 404s.
  fastify.get('/agents', async () => ({ agents: [] }));
  await registerConsoleStatic(fastify, { consoleDistDir });
  await fastify.ready();
  app = fastify;
  return fastify;
}

describe('console static + SPA fallback', () => {
  it('serves index.html at the console root', async () => {
    const fastify = await buildApp();
    const response = await fastify.inject({ method: 'GET', url: '/console/' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<div id="root">');
  });

  it('serves real asset files normally', async () => {
    const fastify = await buildApp();
    const response = await fastify.inject({ method: 'GET', url: '/console/assets/app-abc123.js' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('console.log(1)');
  });

  it('falls back to index.html for a client-side deep link (this 404d before)', async () => {
    const fastify = await buildApp();
    const response = await fastify.inject({ method: 'GET', url: '/console/agents/payment-agent/config' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<div id="root">');
  });

  it('marks the fallback no-store so a stale index.html cannot reference deleted chunks', async () => {
    const fastify = await buildApp();
    const response = await fastify.inject({ method: 'GET', url: '/console/agents/foo' });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('404s a missing asset instead of returning HTML under a .js URL', async () => {
    const fastify = await buildApp();
    const response = await fastify.inject({ method: 'GET', url: '/console/assets/does-not-exist.js' });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('<div id="root">');
  });

  it('404s any dotted filename outside /assets/ too', async () => {
    const fastify = await buildApp();
    const response = await fastify.inject({ method: 'GET', url: '/console/favicon.ico' });
    expect(response.statusCode).toBe(404);
  });

  it('ignores the query string when deciding whether a path is an asset', async () => {
    const fastify = await buildApp();
    const deepLink = await fastify.inject({ method: 'GET', url: '/console/agents/foo?tab=config' });
    expect(deepLink.statusCode).toBe(200);
    expect(deepLink.body).toContain('<div id="root">');
  });

  it('does not fall back for non-GET/HEAD methods', async () => {
    const fastify = await buildApp();
    const response = await fastify.inject({ method: 'POST', url: '/console/agents/foo' });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('<div id="root">');
  });

  it('leaves unmatched API paths as JSON 404s — the handler must not leak past /console', async () => {
    const fastify = await buildApp();
    const response = await fastify.inject({ method: 'GET', url: '/no-such-api-route' });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('<div id="root">');
    expect(response.json()).toMatchObject({ error: 'Not Found' });
  });

  it('leaves matched API routes working', async () => {
    const fastify = await buildApp();
    const response = await fastify.inject({ method: 'GET', url: '/agents' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ agents: [] });
  });
});
