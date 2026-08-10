/**
 * Serves the built React console (packages/console/dist) at /console/, with a
 * single-page-app fallback so client-side routes survive a deep link or a
 * refresh.
 *
 * Why the fallback is needed: the console uses a client-side router, so a URL
 * like /console/agents/payment-agent/config exists only in the browser. Without
 * a fallback, @fastify/static resolves it against the filesystem, finds
 * nothing, and 404s — every deep link and every F5 breaks.
 *
 * Why an encapsulated scope: `setNotFoundHandler` registered on the root
 * instance would swallow EVERY unmatched route in the process, including
 * genuinely-unknown API paths, turning their JSON 404s into HTML. Registering
 * inside a `{ prefix: '/console' }` scope confines the handler to that prefix.
 * (@fastify/static is fastify-plugin-wrapped, so its routes and the
 * `reply.sendFile` decorator still land where we want them.) Routes that 404
 * deliberately — e.g. requireAgent's `unknown agent` — are route-MATCHED and
 * never reach a not-found handler at all.
 */
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';

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

  await fastifyServer.register(
    async (scope) => {
      await scope.register(fastifyStatic, {
        root: consoleDistDir,
        // No `prefix` here — the enclosing scope already supplies /console.
        redirect: true,
      });

      scope.setNotFoundHandler((request, reply) => {
        // Only document requests get the SPA fallback.
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          return reply.code(404).send({ error: 'not found' });
        }
        if (looksLikeStaticAsset(request.url.split('?')[0])) {
          return reply.code(404).send({ error: 'not found' });
        }
        // Hashed assets are immutable and cache forever, but a cached
        // index.html referencing chunks that no longer exist is a white screen
        // on the next deploy. `cacheControl: false` is required: @fastify/static
        // otherwise writes its own `public, max-age=0` and overwrites ours.
        return reply
          .header('cache-control', 'no-store')
          .sendFile('index.html', { cacheControl: false });
      });
    },
    { prefix: '/console' },
  );
}
