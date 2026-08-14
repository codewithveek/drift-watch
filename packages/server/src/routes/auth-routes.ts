/**
 * Mounts better-auth's handler onto Fastify at `/api/auth/*`.
 *
 * better-auth speaks the Fetch API (`Request` in, `Response` out) and Fastify
 * speaks Node's req/res, so this is a small adapter. It stays a catch-all rather
 * than enumerating routes because better-auth's surface changes with the plugins
 * enabled — listing them here would mean a silent 404 the first time a plugin is
 * added.
 *
 * Path note: the DriftWatch API lives under `/api/v1` while auth sits at
 * `/api/auth`. Auth is deliberately unversioned — it is better-auth's own
 * contract, matched by its client's default base path, and it does not move in
 * lockstep with DriftWatch's resource API. Both live under `/api`, which is what
 * the console's SPA fallback keys off.
 */
import type { FastifyInstance } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import type { Auth } from '../auth/auth.js';

export interface RegisterAuthRoutesOptions {
  auth: Auth;
}

export async function registerAuthRoutes(
  server: FastifyInstance,
  { auth }: RegisterAuthRoutesOptions,
): Promise<void> {
  /*
   * No custom content-type parser is registered here, deliberately.
   *
   * The obvious move is a pass-through parser so better-auth sees the raw body,
   * but content-type parsers in Fastify are global unless encapsulated, and
   * routes/integrations.ts already claims `application/x-www-form-urlencoded`
   * to verify Slack's request signature against the unparsed bytes. Registering
   * it twice throws at boot ("already present"), and taking it over would break
   * that signature check — a working feature traded for a hypothetical one.
   *
   * So the body is re-serialised below instead. That is lossless for the JSON
   * bodies every enabled endpoint uses. If social providers are ever enabled,
   * their form-encoded OAuth callbacks WILL need the raw bytes; at that point
   * move these routes into an encapsulated `server.register(...)` scope with
   * their own parser rather than adding one here.
   */
  server.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    // Auth endpoints are the ones worth brute-forcing, so they get a tighter
    // budget than the global limit. Keyed on IP by the plugin's default.
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    async handler(request, reply) {
      const url = new URL(request.url, `${request.protocol}://${request.headers.host}`);
      const response = await auth.handler(
        new Request(url, {
          method: request.method,
          headers: fromNodeHeaders(request.headers),
          // Already a string when some other plugin's pass-through parser
          // handled it (Slack's form parser is global); an object when
          // Fastify's built-in JSON parser did. Stringifying a string would
          // double-encode it and better-auth would reject the body.
          ...(request.body === undefined || request.method === 'GET'
            ? {}
            : {
                body:
                  typeof request.body === 'string'
                    ? request.body
                    : JSON.stringify(request.body),
              }),
        }),
      );

      reply.status(response.status);
      // `raw.append`, not `reply.header`: a login response carries more than one
      // Set-Cookie, and Fastify's header() replaces rather than appends — which
      // would silently drop all but the last cookie.
      response.headers.forEach((value, key) => {
        if (key.toLowerCase() === 'set-cookie') reply.raw.appendHeader('set-cookie', value);
        else reply.header(key, value);
      });
      return reply.send(response.body ? await response.text() : null);
    },
  });
}
