import { describe, it, expect, vi, afterEach } from 'vitest';
import { AuthError, changePassword, getSession, signIn, signOut } from './auth.js';

/**
 * The auth client's contract with the server.
 *
 * What matters here is not that fetch is called — it is the decisions this
 * module makes on the caller's behalf: that a failed session lookup resolves to
 * "signed out" rather than throwing (the root loader depends on it), that
 * credentials are sent so the cookie travels, and that a password change revokes
 * other sessions.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(body === null ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const A_USER = {
  id: 'u1',
  email: 'ops@acme.test',
  name: 'Ops',
  role: 'admin',
  mustChangePassword: false,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Captures the single fetch call so its URL and init can be asserted. */
function stubFetch(response: Response | Promise<never>) {
  const fetchMock = vi.fn(async () => (response instanceof Response ? response : response));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('getSession', () => {
  it('returns the user when a session exists', async () => {
    stubFetch(jsonResponse({ user: A_USER }));
    await expect(getSession()).resolves.toMatchObject({ email: 'ops@acme.test', role: 'admin' });
  });

  it('returns null rather than throwing on 401', async () => {
    stubFetch(jsonResponse({ message: 'unauthorized' }, 401));
    // The root loader calls this on every navigation and redirects on null. If
    // it threw, a logged-out visitor would hit the error boundary instead of
    // the login page.
    await expect(getSession()).resolves.toBeNull();
  });

  it('returns null rather than throwing when the server is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    // Same reasoning: an unreachable server should land the operator on the
    // login page, not on a crashed boundary with no way out.
    await expect(getSession()).resolves.toBeNull();
  });

  it('treats a session with no user as signed out', async () => {
    stubFetch(jsonResponse(null));
    await expect(getSession()).resolves.toBeNull();
  });

  it('sends credentials so the session cookie travels', async () => {
    const fetchMock = stubFetch(jsonResponse({ user: A_USER }));
    await getSession();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/auth/get-session');
    expect(init.credentials).toBe('same-origin');
  });
});

describe('signIn', () => {
  it('posts the credentials and returns the user', async () => {
    const fetchMock = stubFetch(jsonResponse({ user: A_USER }));
    await expect(signIn('ops@acme.test', 'a-long-password')).resolves.toMatchObject({ id: 'u1' });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/auth/sign-in/email');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      email: 'ops@acme.test',
      password: 'a-long-password',
    });
  });

  it('throws an AuthError carrying the status so the page can tailor the message', async () => {
    stubFetch(jsonResponse({ message: 'Invalid email or password' }, 401));
    await expect(signIn('ops@acme.test', 'wrong')).rejects.toMatchObject({
      name: 'AuthError',
      status: 401,
    });
  });

  it('falls back to status text when the error body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>gateway error</html>', { status: 502 })),
    );
    // A proxy in front of the server returns HTML, not better-auth's shape.
    // Without the fallback this surfaces as "[object Object]".
    await expect(signIn('a@b.test', 'x')).rejects.toBeInstanceOf(AuthError);
  });
});

describe('signOut', () => {
  it('tolerates an empty 200 body', async () => {
    // better-auth answers sign-out with no body; JSON.parse('') would throw.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));
    await expect(signOut()).resolves.toBeUndefined();
  });
});

describe('changePassword', () => {
  it('revokes other sessions', async () => {
    const fetchMock = stubFetch(jsonResponse({}));
    await changePassword('old-password', 'a-much-better-password');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/auth/change-password');
    // Someone changing a password usually suspects the old one is compromised;
    // leaving other sessions alive would defeat the point.
    expect(JSON.parse(init.body as string)).toMatchObject({ revokeOtherSessions: true });
  });
});
