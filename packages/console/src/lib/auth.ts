/**
 * Console-side auth client.
 *
 * Deliberately plain `fetch` against better-auth's HTTP surface rather than its
 * React client. The console needs exactly four calls, and the client package
 * would pull better-auth (and its own zod 4) into the browser bundle to save
 * about forty lines. The endpoints below are a stable public contract — the same
 * ones the client would call.
 *
 * There is no token handling anywhere in this file, and that is the point: the
 * session lives in an httpOnly cookie the browser attaches automatically, so
 * script (including injected script) cannot read or exfiltrate it. The old model
 * kept a long-lived privileged bearer in localStorage.
 */

/** better-auth's base path — unversioned; see routes/auth-routes.ts. */
const AUTH_BASE = '/api/auth';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: string | null;
  /** True while the account still has the password seeded from DW_PASSWORD. */
  mustChangePassword: boolean;
}

export class AuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

async function authFetch<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${AUTH_BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      'x-requested-with': 'driftwatch-console',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (!response.ok) {
    throw new AuthError(response.status, await readErrorMessage(response));
  }
  // sign-out answers 200 with an empty body.
  const text = await response.text();
  return (text ? JSON.parse(text) : null) as T;
}

/**
 * better-auth returns `{ message, code }`; a proxy or gateway in front might
 * return something else entirely. Falling back to the status text keeps a login
 * failure legible rather than showing "[object Object]".
 */
async function readErrorMessage(response: Response): Promise<string> {
  try {
    const parsed = (await response.json()) as { message?: string; error?: string };
    return parsed.message ?? parsed.error ?? response.statusText;
  } catch {
    return response.statusText || `request failed (${response.status})`;
  }
}

/**
 * The signed-in user, or null.
 *
 * A failure resolves to null rather than throwing: this is called by the root
 * route loader on every navigation, and an unreachable server should land the
 * operator on the login page, not on a crashed error boundary with no way out.
 */
export async function getSession(): Promise<SessionUser | null> {
  try {
    const session = await authFetch<{ user?: SessionUser } | null>('/get-session');
    return session?.user ?? null;
  } catch {
    return null;
  }
}

export async function signIn(email: string, password: string): Promise<SessionUser> {
  const result = await authFetch<{ user: SessionUser }>('/sign-in/email', { email, password });
  return result.user;
}

export async function signOut(): Promise<void> {
  await authFetch<null>('/sign-out', {});
}

/**
 * `revokeOtherSessions` is on by default. Someone changing their password has
 * usually either been told to or suspects the old one is compromised, and in
 * both cases leaving other sessions alive defeats the purpose.
 */
export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  await authFetch<unknown>('/change-password', {
    currentPassword,
    newPassword,
    revokeOtherSessions: true,
  });
}
