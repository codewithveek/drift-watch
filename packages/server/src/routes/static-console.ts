/**
 * Serves the built React console (packages/console/dist) at the ROOT, with a
 * single-page-app fallback so client-side routes survive a deep link or refresh.
 *
 * Why the fallback is needed: the console uses a client-side router, so a URL
 * like /agents/payment-agent/config exists only in the browser. Without a
 * fallback, @fastify/static resolves it against the filesystem, finds nothing,
 * and 404s — every deep link and every F5 breaks.
 *
 * ## The root move made the guards load-bearing
 *
 * This used to live in a `{ prefix: '/console' }` scope, which meant the
 * not-found handler could only ever affect paths under that prefix. At the root
 * there is no such containment: `setNotFoundHandler` here catches EVERY
 * unmatched request in the process. A path that should return a JSON 404 — a
 * misspelled API route, a retired endpoint — would instead return `index.html`
 * with a 200, and an SDK client would fail on `JSON.parse('<')` with no useful
 * error. So the handler now decides explicitly, and the default is a real 404:
 * only paths that plausibly name a console PAGE get the SPA shell.
 *
 * Routes that 404 deliberately (requireAgent's `unknown agent`) are route-MATCHED
 * and never reach a not-found handler at all, so they are unaffected.
 */
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';

/**
 * Path prefixes that must never receive the SPA fallback.
 *
 * `/api` covers both the versioned DriftWatch API and better-auth's routes;
 * `/integrations` covers the Slack and Telegram webhooks. An unmatched path
 * under any of these is a genuine 404 for a machine caller, and machines need
 * JSON and a correct status code, not a login page rendered at 200.
 */
const NON_CONSOLE_PREFIXES = ['/api/', '/integrations/', '/health'];

function isServerPath(pathname: string): boolean {
  return NON_CONSOLE_PREFIXES.some(
    (prefix) => pathname === prefix.replace(/\/$/, '') || pathname.startsWith(prefix),
  );
}

/**
 * True for paths that name a file rather than a client route (`app-D4f8.js`,
 * `logo.svg`). Serving index.html for these would return HTML with a 200 under
 * a .js URL, and the browser reports an opaque MIME-type error instead of the
 * missing file — so they must keep a real 404.
 */
function looksLikeStaticAsset(pathname: string): boolean {
  if (pathname.includes('/assets/')) return true;
  const lastSegment = pathname.split('/').pop() ?? '';
  return lastSegment.includes('.');
}

export interface RegisterConsoleStaticOptions {
  /** Absolute path to the console's built output (its `dist` directory). */
  consoleDistDir: string;
}

export async function registerConsoleStatic(
  fastifyServer: FastifyInstance,
  options: RegisterConsoleStaticOptions,
): Promise<void> {
  const { consoleDistDir } = options;

  await fastifyServer.register(fastifyStatic, { root: consoleDistDir, redirect: true });

  fastifyServer.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split('?')[0] ?? '/';

    // Only document requests get the SPA fallback.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return reply.code(404).send({ error: 'not found' });
    }
    if (isServerPath(pathname) || looksLikeStaticAsset(pathname)) {
      return reply.code(404).send({ error: 'not found' });
    }

    // Hashed assets are immutable and cache forever, but a cached index.html
    // referencing chunks that no longer exist is a white screen on the next
    // deploy. `cacheControl: false` is required: @fastify/static otherwise
    // writes its own `public, max-age=0` and overwrites ours.
    return reply
      .header('cache-control', 'no-store')
      .sendFile('index.html', { cacheControl: false });
  });
}
