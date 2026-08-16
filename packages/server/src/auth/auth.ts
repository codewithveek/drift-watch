/**
 * better-auth configuration — the console's human authentication.
 *
 * This replaced the old model where an operator pasted a flat `AUTH_TOKEN` into
 * the browser and it sat in `localStorage`. That was bad in several ways at
 * once: the credential was the deployment's most privileged secret, it never
 * expired, XSS could read it, and every console action landed in the audit log
 * attributed to `root` rather than to a person. That token has since been
 * removed outright — see routes/auth.ts.
 *
 * ## Two authentication paths, one authorization model
 *
 * Humans get a session cookie from here. Machines (the SDK, CI) keep using
 * scoped API keys. Both are resolved into the same `Principal` by
 * routes/auth.ts, so every route's scope and agent checks are written once and
 * apply to both. A user's `role` is a named bundle of the *existing*
 * `ApiKeyScope` vocabulary (see roles.ts) rather than a second, parallel
 * permission system.
 *
 * ## Notes on the choices below
 *
 * - **`disableSignUp: true`** is the single most important line in this file.
 *   Without it, anything that can reach the instance can create itself an
 *   account. Users are created by an admin; the very first one is seeded from
 *   the environment (see seed-admin.ts), which is why bootstrapping does not
 *   need public signup.
 * - **Cookies, not JWTs.** The console is served same-origin with this server,
 *   so a cookie needs no CORS work and `httpOnly` removes the XSS-exfiltration
 *   risk that localStorage had. A JWT would buy nothing here and would make
 *   revocation harder. The cost is CSRF, paid for with SameSite=Lax below plus
 *   the origin check better-auth performs on state-changing requests.
 * - **better-auth carries its own zod 4** as a regular dependency while this
 *   workspace stays pinned to zod 3 (the SDK breaks on 4 — nested `.default({})`
 *   stops populating). The two never meet: `additionalFields` below is a plain
 *   descriptor object, not a zod schema, so no schema ever crosses the boundary.
 */
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { admin } from 'better-auth/plugins/admin';
import type { Database } from '../db/client.js';
import { DEFAULT_ORGANIZATION_ID } from '../db/schema.js';
import * as authSchema from '../db/auth-schema.js';

export interface CreateAuthOptions {
  db: Database;
  /**
   * Signs session cookies. MUST be stable across restarts and across replicas —
   * a changed secret invalidates every session at once.
   */
  secret: string;
  /** Public origin the console is served from, e.g. https://driftwatch.acme.com. */
  baseUrl: string;
  /** Session lifetime in seconds. Defaults to 7 days. */
  sessionMaxAgeSeconds?: number;
  /** True when served over TLS — sets the Secure cookie attribute. */
  secureCookies?: boolean;
}

export type Auth = ReturnType<typeof createAuth>;

export function createAuth(options: CreateAuthOptions) {
  const {
    db,
    secret,
    baseUrl,
    sessionMaxAgeSeconds = 60 * 60 * 24 * 7,
    secureCookies = baseUrl.startsWith('https://'),
  } = options;

  return betterAuth({
    secret,
    baseURL: baseUrl,
    database: drizzleAdapter(db, { provider: 'pg', schema: authSchema }),

    emailAndPassword: {
      enabled: true,
      // See the docblock: this is what stops a reachable instance from being
      // self-service. Admins create users through the admin plugin below.
      disableSignUp: true,
      minPasswordLength: 12,
    },

    session: {
      expiresIn: sessionMaxAgeSeconds,
      // Rolling expiry: a session in daily use is refreshed rather than forcing
      // a re-login every week. Only rewritten once a day so an active console
      // is not writing a session row on every poll.
      updateAge: 60 * 60 * 24,
    },

    advanced: {
      defaultCookieAttributes: {
        httpOnly: true,
        // Lax rather than Strict: Strict would drop the cookie on any
        // cross-site navigation INTO the console — including the link in a
        // Slack approval notification, which is a primary way operators arrive
        // here. Lax still blocks the cross-site POSTs that CSRF needs.
        sameSite: 'lax',
        secure: secureCookies,
        path: '/',
      },
    },

    user: {
      additionalFields: {
        /**
         * Tenancy, matching every other table's `organization_id`. Unused while
         * self-hosted, present so that hosting DriftWatch later is a feature
         * rather than a migration of every populated table.
         */
        organizationId: {
          type: 'string',
          required: false,
          defaultValue: DEFAULT_ORGANIZATION_ID,
          input: false,
        },
        /**
         * Nags the console until the operator replaces the password that was
         * seeded from the environment. A password living in a compose file is
         * acceptable to bootstrap with and not acceptable to keep.
         */
        mustChangePassword: {
          type: 'boolean',
          required: false,
          defaultValue: false,
          input: false,
        },
      },
    },

    plugins: [
      // Gives the console user management (create, list, disable, set role)
      // without hand-rolling it, and owns the `role` field that roles.ts maps
      // onto API key scopes.
      admin({
        defaultRole: 'viewer',
        adminRoles: ['admin'],
      }),
    ],

    // The console is same-origin, so this list only matters for the Vite dev
    // server on :5173 talking to the API on :4300.
    trustedOrigins: [baseUrl],
  });
}
