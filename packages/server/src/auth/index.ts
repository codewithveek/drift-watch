/**
 * Auth bootstrap: build the better-auth instance and seed the first admin.
 *
 * Returns `undefined` when the deployment has no database. better-auth needs one
 * (users, sessions and accounts are rows, not memory), so a memory-store or
 * Redis-only deployment has no human login at all and falls back to the
 * AUTH_TOKEN path. That is a deliberate, visible limitation rather than a
 * half-working login: a session store that evaporates on restart would log
 * everyone out at every deploy and look like a bug.
 */
import { randomBytes } from 'node:crypto';
import type { Database } from '../db/client.js';
import type { ServerConfig } from '../config/server-config.js';
import { createAuth, type Auth } from './auth.js';
import { seedAdminUser } from './seed-admin.js';

export type { Auth } from './auth.js';
export { createAuth } from './auth.js';
export { scopesForRole, ROLE_SCOPES, USER_ROLES, type UserRole } from './roles.js';

export interface SetupAuthOptions {
  serverConfig: ServerConfig;
  db?: Database;
  isProduction?: boolean;
  logger?: { info(message: string): void; warn(message: string): void };
}

export async function setupAuth(options: SetupAuthOptions): Promise<Auth | undefined> {
  const { serverConfig, db, logger } = options;
  const isProduction = options.isProduction ?? process.env.NODE_ENV === 'production';

  if (!db) {
    logger?.warn(
      'no DATABASE_URL: console login is disabled. Only API keys and local-network ' +
        'requests are accepted — set DATABASE_URL for a real deployment.',
    );
    return undefined;
  }

  const auth = createAuth({
    db,
    secret: resolveSecret(serverConfig.authSecret, isProduction, logger),
    baseUrl: serverConfig.baseUrl || `http://localhost:${serverConfig.port}`,
  });

  await seedAdminUser({
    auth,
    email: serverConfig.adminUser,
    password: serverConfig.adminPassword,
    ...(logger ? { logger } : {}),
  });

  return auth;
}

/**
 * A missing secret is fatal in production and merely noisy in development.
 *
 * Falling back to a random value in production would appear to work — until the
 * process restarted or a second replica started, at which point every operator
 * is logged out with no explanation. Failing at boot with a clear message is the
 * kinder outcome, and it is a one-line fix.
 */
function resolveSecret(
  configured: string,
  isProduction: boolean,
  logger?: { warn(message: string): void },
): string {
  if (configured) return configured;

  if (isProduction) {
    throw new Error(
      'DW_AUTH_SECRET is required in production — it signs session cookies, and an ' +
        'unstable value logs every user out on restart and across replicas. ' +
        'Generate one with: openssl rand -base64 32',
    );
  }

  logger?.warn(
    'DW_AUTH_SECRET not set — using an ephemeral development secret; sessions end on restart',
  );
  return randomBytes(32).toString('base64url');
}
