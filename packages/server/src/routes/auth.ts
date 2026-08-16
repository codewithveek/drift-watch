/**
 * Request authorization for the whole control plane.
 *
 * There are three kinds of principal, resolved in this order:
 *
 *   1. `user` — a logged-in human, identified by a better-auth session cookie.
 *      This is how the console authenticates. Scopes come from the user's role
 *      (see auth/roles.ts), which is a named bundle of the SAME `ApiKeyScope`
 *      values a machine key carries, so every route below is written once and
 *      applies to both.
 *   2. `api-key` — a minted, hashed, scoped key (see @driftwatch/sdk's
 *      api-keys.ts). This is how the SDK and CI authenticate.
 *   3. `local` — a development affordance, available ONLY when the deployment
 *      has no database and therefore no login at all. RFC1918 clients are then
 *      trusted so `pnpm dev` needs no setup. See `resolvePrincipal` for why this
 *      is gated so tightly.
 *
 * ## AUTH_TOKEN is gone
 *
 * There used to be a fourth: a flat `AUTH_TOKEN` bearer holding every scope over
 * every agent, forever, with no expiry and no revocation. It was removed rather
 * than deprecated, because a break-glass credential that exists is a credential
 * that gets used — and every action it took landed in the audit log as `root`,
 * which is precisely the attribution the audit log exists to provide.
 *
 * What replaced each of its jobs:
 *   - operator access → sign in (better-auth), attributed to a person;
 *   - machine access → a scoped API key, revocable and per-agent;
 *   - bootstrap → `DW_USER`/`DW_PASSWORD` seed the first admin at deploy time;
 *   - recovery when the key store is empty → that was only ever a problem for
 *     MemoryStateStore, which no production deployment should use; Postgres
 *     keeps keys and users across restarts.
 *
 * Cookie before bearer is deliberate. A browser sends its session cookie on
 * every request automatically, so checking the bearer first would mean an
 * operator who pasted a stale token into a fetch call would be authenticated as
 * that token rather than as themselves, and the audit log would name the wrong
 * actor.
 *
 * Presenting a bearer that matches nothing is a 401 even from the local network:
 * silently downgrading a bad credential to local trust would make a stale token
 * look like it was working while actually being ignored.
 *
 * The integration webhooks (Slack/Telegram) do NOT use any of this — they carry
 * their own signature auth.
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import type { ApiKeyRecord, ApiKeyScope, StateStore } from '@driftwatch/sdk';
import {
  API_KEY_SCOPES,
  API_KEY_TOUCH_INTERVAL_MS,
  hashApiKeyToken,
  isApiKeyFleetWide,
} from '@driftwatch/sdk';
import type { Auth } from '../auth/auth.js';
import { scopesForRole } from '../auth/roles.js';

/** Who is making this request, once authenticated. */
export interface Principal {
  kind: 'user' | 'api-key' | 'local';
  /** Stable id for the audit log: a user id, 'local', or the API key's id. */
  id: string;
  /** Human label for the audit log: an email, 'local-network', or the key's name. */
  label: string;
  scopes: readonly ApiKeyScope[];
  /** Agents this principal may touch. Undefined = fleet-wide. */
  agentIds?: string[];
  /** Set for `user` principals: forces the console to a password-change screen. */
  mustChangePassword?: boolean;
}

const LOCAL_PRINCIPAL: Principal = {
  kind: 'local',
  id: 'local',
  label: 'local-network',
  scopes: API_KEY_SCOPES,
};

/** What a route demands of its caller. */
export interface AuthRequirement {
  /**
   * Required scope, or several that are ALL required. The array form exists
   * for writes that cross permission boundaries — a PATCH carrying both a
   * rename and a guardrail change needs `agents:write` and `policy:write`
   * together, and checking them in one call keeps it to one key lookup.
   */
  scope: ApiKeyScope | ApiKeyScope[];
  /**
   * The agent this request acts on. A key whose `agentIds` doesn't include it
   * gets a 403 — this is the resource axis the fleet model made necessary.
   */
  agentId?: string;
  /**
   * The operation spans the whole fleet (a fleet-wide scan, minting a key).
   * Only an unscoped key may perform it.
   */
  fleetWide?: boolean;
}

export interface AuthGateOptions {
  store: StateStore;
  /**
   * Omitted when the deployment has no database — better-auth requires one, so
   * a memory-store deployment has no human login and falls back to the
   * local-network development path.
   */
  auth?: Auth;
}

/**
 * Resolves the caller and enforces one requirement. Returns the `Principal` on
 * success (routes pass it to `recordAudit` as the actor), or `undefined` after
 * having already sent the 401/403 — so call sites stay the same one-liner
 * shape they had with the old boolean gate.
 */
export type AuthorizeFn = (
  request: FastifyRequest,
  reply: FastifyReply,
  requirement: AuthRequirement,
) => Promise<Principal | undefined>;

export function createAuthGate(options: AuthGateOptions): AuthorizeFn {
  const { store, auth } = options;

  return async function authorize(request, reply, requirement) {
    const outcome = await resolvePrincipal(request, store, auth);
    if (!outcome.principal) {
      reply.code(401).send({ error: outcome.error });
      return undefined;
    }

    const denial = checkRequirement(outcome.principal, requirement);
    if (denial) {
      reply.code(403).send({ error: denial });
      return undefined;
    }
    return outcome.principal;
  };
}

interface PrincipalOutcome {
  principal?: Principal;
  error: string;
}

async function resolvePrincipal(
  request: FastifyRequest,
  store: StateStore,
  auth?: Auth,
): Promise<PrincipalOutcome> {
  // Session cookie first — see this module's docblock on why a browser's own
  // identity must win over any bearer that happens to also be present.
  const sessionPrincipal = await resolveSessionPrincipal(request, auth);
  if (sessionPrincipal) return { principal: sessionPrincipal, error: '' };

  const bearerToken = readBearerToken(request);

  if (bearerToken === undefined) {
    /*
     * No credential at all. The local-network path is the only thing that can
     * rescue this, and it is available ONLY when the deployment has no login —
     * i.e. no database, so `auth` is undefined.
     *
     * The `!auth` term is load-bearing. Without it, a deployment that has a
     * database, a seeded admin and a login screen would still hand FULL
     * fleet-wide admin scopes to any uncredentialed request arriving from a
     * private IP. That is not a theoretical range: every container on the same
     * Docker network has one, and so does every request forwarded by a reverse
     * proxy that does not set X-Forwarded-For (or when TRUST_PROXY is off,
     * which is the default). The dev affordance is acceptable when the
     * alternative is no auth at all; it is a silent, total bypass once real
     * auth exists.
     */
    if (!auth && isRequestFromLocalNetwork(request)) {
      return { principal: LOCAL_PRINCIPAL, error: '' };
    }
    if (auth) return { error: 'not authenticated: sign in to continue' };
    return {
      error:
        'no database configured, so there is no login, and this request is not from the ' +
        'local network. Set DATABASE_URL (plus DW_USER/DW_PASSWORD) to enable sign-in.',
    };
  }

  // A bearer can now only be a minted API key. Lookup is by sha256, so there is
  // no byte comparison to leak timing here — which is also why the constant-time
  // comparison the flat token needed is gone with it.
  const record = await store.getApiKeyByHash(hashApiKeyToken(bearerToken));
  if (!record) return { error: 'unauthorized' };
  if (record.revokedAt !== undefined) return { error: 'api key revoked' };
  if (record.expiresAt !== undefined && record.expiresAt <= Date.now()) {
    return { error: 'api key expired' };
  }

  await touchApiKeyIfStale(store, record, request);
  return { principal: principalForApiKey(record), error: '' };
}

/**
 * Resolves a logged-in human from the session cookie, or undefined when there
 * is no session (or no database, so no better-auth at all).
 *
 * A banned user resolves to undefined rather than throwing: the effect an
 * operator expects from disabling an account is that it stops working, and
 * falling through to the 401 path produces exactly that.
 *
 * Failure is swallowed to a miss, not surfaced. If the session lookup errors —
 * a database blip — the request continues to the bearer paths and, failing
 * those, gets a 401. Turning a transient store error into a 500 on EVERY route
 * would take the whole console down for a hiccup that a page refresh recovers
 * from.
 */
async function resolveSessionPrincipal(
  request: FastifyRequest,
  auth?: Auth,
): Promise<Principal | undefined> {
  if (!auth) return undefined;
  // Cheap pre-check: skip the store round-trip entirely for the SDK and CI,
  // which never carry cookies.
  if (!request.headers.cookie) return undefined;

  try {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    if (!session?.user) return undefined;
    if (session.user.banned) return undefined;

    const user = session.user as typeof session.user & {
      role?: string | null;
      mustChangePassword?: boolean | null;
    };
    return {
      kind: 'user',
      id: user.id,
      label: user.email,
      scopes: scopesForRole(user.role),
      // Users are never agent-scoped today; the resource axis exists only on
      // API keys. Leaving `agentIds` undefined means fleet-wide, which is what
      // a role-based principal should be until per-team scoping exists.
      mustChangePassword: user.mustChangePassword === true,
    };
  } catch (error) {
    request.log.warn({ error }, 'session lookup failed; falling through to bearer auth');
    return undefined;
  }
}

export function principalForApiKey(record: ApiKeyRecord): Principal {
  return {
    kind: 'api-key',
    id: record.id,
    label: record.name,
    scopes: record.scopes,
    ...(isApiKeyFleetWide(record) ? {} : { agentIds: record.agentIds }),
  };
}

/**
 * `lastUsedAt` exists so an operator can spot a key nobody uses any more. That
 * question is answered just as well by a minute-granular timestamp as by an
 * exact one, and the coarse version costs one store write per key per minute
 * instead of one per request. Failure is swallowed: a store hiccup must not
 * turn a valid credential into a 500.
 */
async function touchApiKeyIfStale(
  store: StateStore,
  record: ApiKeyRecord,
  request: FastifyRequest,
): Promise<void> {
  const now = Date.now();
  if (record.lastUsedAt !== undefined && now - record.lastUsedAt < API_KEY_TOUCH_INTERVAL_MS) {
    return;
  }
  try {
    await store.touchApiKey(record.id, now);
  } catch (error) {
    request.log.warn({ error, apiKeyId: record.id }, 'failed to record api key last-used');
  }
}

/** Returns a denial message, or undefined when the principal satisfies the requirement. */
function checkRequirement(principal: Principal, requirement: AuthRequirement): string | undefined {
  const required = Array.isArray(requirement.scope) ? requirement.scope : [requirement.scope];
  const missing = required.filter((scope) => !principal.scopes.includes(scope));
  if (missing.length > 0) {
    return `missing required scope: ${missing.join(', ')}`;
  }
  if (!principal.agentIds) return undefined;

  if (requirement.fleetWide) {
    return 'this key is scoped to specific agents and cannot perform fleet-wide operations';
  }
  if (requirement.agentId && !principal.agentIds.includes(requirement.agentId)) {
    return `this key is not scoped to agent: ${requirement.agentId}`;
  }
  return undefined;
}

/**
 * A principal may only grant scopes it already holds. Key management itself is
 * fleet-wide-only (the /api-keys routes require `fleetWide`), so the agent axis
 * needs no equivalent check — but without THIS one, a key holding just
 * `read` + `keys:admin` could mint itself a `policy:write` key and every other
 * scope restriction would be decorative.
 */
export function checkGrantIsWithinPrincipal(
  principal: Principal,
  scopes: ApiKeyScope[],
): string | undefined {
  const excessScopes = scopes.filter((scope) => !principal.scopes.includes(scope));
  if (excessScopes.length > 0) {
    return `cannot grant scopes you do not hold: ${excessScopes.join(', ')}`;
  }
  return undefined;
}

/** Narrows a fleet-wide listing to what an agent-scoped key is allowed to see. */
export function visibleToPrincipal<T extends { id: string }>(
  principal: Principal,
  records: T[],
): T[] {
  if (!principal.agentIds) return records;
  const allowed = new Set(principal.agentIds);
  return records.filter((record) => allowed.has(record.id));
}

/** The bearer token as presented, or undefined when the header is absent/malformed. */
function readBearerToken(request: FastifyRequest): string | undefined {
  const authorizationHeader = request.headers.authorization ?? '';
  const [authScheme, bearerToken] = authorizationHeader.split(' ');
  if (authScheme !== 'Bearer' || typeof bearerToken !== 'string' || bearerToken === '') {
    return undefined;
  }
  return bearerToken;
}

/**
 * RFC 1918 private ranges only. Note 172.16.0.0/12 covers just
 * 172.16.x.x-172.31.x.x — matching on the "172." prefix alone would
 * wrongly admit all of 172.0.0.0/8, including public addresses.
 */
export function isRequestFromLocalNetwork(request: FastifyRequest): boolean {
  const clientIpAddress = request.ip;
  if (
    clientIpAddress === '127.0.0.1' ||
    clientIpAddress === '::1' ||
    clientIpAddress === '::ffff:127.0.0.1' ||
    clientIpAddress.startsWith('10.') ||
    clientIpAddress.startsWith('192.168.')
  ) {
    return true;
  }

  const privateClassBMatch = /^172\.(\d{1,3})\./.exec(clientIpAddress);
  if (!privateClassBMatch) return false;
  const secondOctet = Number(privateClassBMatch[1]);
  return secondOctet >= 16 && secondOctet <= 31;
}
