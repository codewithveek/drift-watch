/**
 * Scoped API keys — the authorization primitive for the control plane.
 *
 * Everything here is pure: minting, hashing, and the three predicates a gate
 * needs (usable / has-scope / covers-agent). The HTTP gate that consumes them
 * lives in @driftwatch/server (routes/auth.ts), and persistence goes through
 * `StateStore` like every other record — this file does no I/O.
 *
 * Why sha256 and not bcrypt/argon2: those are deliberately slow, salted
 * per-record KDFs, which is the right tool for LOW-entropy human passwords.
 * A minted token here is 24 bytes of CSPRNG output — brute force is already
 * infeasible, so the slow-hash property buys nothing, while the per-record
 * salt would make lookup O(number of keys) with a full KDF run per candidate.
 * A plain sha256 is deterministic, so the hash itself is the index: one
 * constant-time map/GET lookup, no scan. That is also why the "compare" is
 * a lookup miss rather than a byte comparison — there is no timing side
 * channel to leak. (The flat AUTH_TOKEN bearer this once contrasted with was
 * removed in v2 — a single all-scope credential with no expiry or revocation.)
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';

/**
 * Permission axis. Deliberately coarse — one scope per kind of consequence,
 * not per route. `policy:write` is split out from `agents:write` because
 * loosening a spend cap or removing a tool gate is a materially different
 * act from renaming an agent, and a deploy key that registers agents should
 * not be able to do it.
 */
export const API_KEY_SCOPES = [
  /** Every GET on the control plane. */
  'read',
  /** POST /run and GET /drift — actually executing the agent. */
  'agent:run',
  /** Resolve control approvals (Loop 2) and tool-call approvals (Loop 3). */
  'approvals:write',
  /** pause / resume / rollback, and triggering drift scans. */
  'control:write',
  /** Register agents and edit their identity fields (name, owner, serviceName). */
  'agents:write',
  /** Edit guardrails, tool allow-lists, and tool-call policies. */
  'policy:write',
  /** Mint and revoke API keys. Implies fleet-wide reach by construction. */
  'keys:admin',
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/**
 * Operator-facing copy for each scope, colocated with the list so a new scope
 * cannot ship without one. The control plane serves these to the console
 * rather than the console hardcoding its own — the SDK's runtime entry pulls
 * in OpenTelemetry and must never reach a browser bundle.
 */
export const API_KEY_SCOPE_DESCRIPTIONS: Record<ApiKeyScope, string> = {
  read: 'View agents, state, drift history, approvals and the audit log.',
  'agent:run': 'Execute agent tasks and run drift detection.',
  'approvals:write': 'Approve or reject control actions and gated tool calls.',
  'control:write': 'Pause, resume and roll back agents, and trigger drift scans.',
  'agents:write': 'Register agents and edit their name, owner and service name.',
  'policy:write': 'Change guardrails, tool allow-lists and tool-call policies.',
  'keys:admin': 'Mint and revoke API keys. Grant sparingly.',
};

export function isApiKeyScope(value: unknown): value is ApiKeyScope {
  return typeof value === 'string' && (API_KEY_SCOPES as readonly string[]).includes(value);
}

/**
 * All tokens carry this prefix so a leaked string is recognizable as a
 * DriftWatch credential in a log/paste/secret scanner.
 */
export const API_KEY_TOKEN_PREFIX = 'dw_';

/** Bytes of CSPRNG entropy in the secret half of a token. */
const TOKEN_ENTROPY_BYTES = 24;

/** How much of the token is retained in cleartext for display/identification. */
const DISPLAY_PREFIX_LENGTH = API_KEY_TOKEN_PREFIX.length + 8;

/**
 * A stored key. The plaintext token is NEVER a field here — it exists only in
 * the mint response and is unrecoverable afterwards. `prefix` is the leading
 * cleartext slice so an operator can tell two keys apart in a list without
 * the list being a credential dump.
 */
export interface ApiKeyRecord {
  id: string;
  name: string;
  /** First few characters of the token, e.g. `dw_a1b2c3d4`. Display only. */
  prefix: string;
  /** sha256(token) as hex. The lookup index — see this file's docblock. */
  hash: string;
  scopes: ApiKeyScope[];
  /**
   * Agents this key may touch. Omitted/empty = fleet-wide. This is the
   * resource axis the fleet model made necessary: without it, a scoped
   * `policy:write` key could still rewrite any other team's tool gates.
   */
  agentIds?: string[];
  createdAt: number;
  /** Principal id that minted this key (`root`, `local`, or another key's id). */
  createdBy: string;
  /**
   * Coarse last-use timestamp. Written at most once per
   * API_KEY_TOUCH_INTERVAL_MS so authentication doesn't become a store write
   * on every single request.
   */
  lastUsedAt?: number;
  expiresAt?: number;
  revokedAt?: number;
  revokedBy?: string;
}

/** Minimum gap between `lastUsedAt` writes for one key. */
export const API_KEY_TOUCH_INTERVAL_MS = 60_000;

/** The one and only time the plaintext token is available. */
export interface MintedApiKey {
  record: ApiKeyRecord;
  /** Show once, store never. */
  token: string;
}

export function hashApiKeyToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface MintApiKeyOptions {
  name: string;
  scopes: ApiKeyScope[];
  agentIds?: string[];
  createdBy: string;
  expiresAt?: number;
  /** Overridable purely so tests can pin time; defaults to now. */
  now?: number;
}

export function mintApiKey(options: MintApiKeyOptions): MintedApiKey {
  const token = API_KEY_TOKEN_PREFIX + randomBytes(TOKEN_ENTROPY_BYTES).toString('base64url');
  const createdAt = options.now ?? Date.now();
  const record: ApiKeyRecord = {
    id: randomUUID(),
    name: options.name,
    prefix: token.slice(0, DISPLAY_PREFIX_LENGTH),
    hash: hashApiKeyToken(token),
    scopes: [...options.scopes],
    ...(options.agentIds && options.agentIds.length > 0 ? { agentIds: [...options.agentIds] } : {}),
    createdAt,
    createdBy: options.createdBy,
    ...(options.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}),
  };
  return { record, token };
}

/**
 * True when this key has no agent restriction at all. The gate turns a key
 * into a `Principal` and does its scope/agent checks against that, so this is
 * the one predicate the record itself still needs to answer.
 */
export function isApiKeyFleetWide(record: ApiKeyRecord): boolean {
  return !record.agentIds || record.agentIds.length === 0;
}

/**
 * Redaction helper for anything that leaves the server. `hash` is not a
 * secret in the "usable credential" sense — you cannot present it as a bearer
 * — but it is the exact value an offline attacker would want to confirm a
 * guessed token against, so it never appears in an API response either.
 */
export type PublicApiKey = Omit<ApiKeyRecord, 'hash'>;

export function toPublicApiKey(record: ApiKeyRecord): PublicApiKey {
  const { hash: _hash, ...rest } = record;
  return rest;
}
