/**
 * First-run admin bootstrap.
 *
 * A fresh deployment has no users and public signup is disabled, so without this
 * there would be no way in at all. `DW_USER` / `DW_PASSWORD` create exactly one
 * admin, and only when the user table is empty.
 *
 * ## Why seed-if-empty, and not seed-every-boot
 *
 * Re-applying the environment password on every boot would silently revert an
 * operator's password change, turning a value that lives in a compose file — and
 * therefore in shell history, a git repo, and a CI log — into a permanent
 * backdoor that cannot be closed without editing the deployment. Seeding only
 * into an empty table means the variable bootstraps the first login and then
 * stops mattering; it can be removed from the environment afterwards.
 *
 * The seeded account is flagged `mustChangePassword` so the console can insist
 * on a real one. A compose-file password is acceptable to bootstrap with and not
 * acceptable to keep.
 *
 * ## Why the internal adapter
 *
 * `auth.api.signUpEmail` is the obvious call and the wrong one: `disableSignUp`
 * is set (see auth.ts), so it correctly refuses. Relaxing that flag to let the
 * seed through would leave public registration open on every running instance —
 * trading a permanent security hole for a one-line convenience. These are the
 * same three calls better-auth's own sign-up route makes, in the same order.
 */
import type { Auth } from './auth.js';
import { DEFAULT_ORGANIZATION_ID } from '../db/schema.js';

export interface SeedAdminOptions {
  auth: Auth;
  email: string;
  password: string;
  /** Display name. Defaults to the local-part of the email. */
  name?: string;
  logger?: { info(message: string): void; warn(message: string): void };
}

export type SeedAdminResult =
  | { seeded: true; email: string }
  | { seeded: false; reason: 'users-exist' | 'not-configured' | 'password-too-short' };

/** better-auth's own minimum; mirrored here so the failure is explained at boot. */
const MIN_PASSWORD_LENGTH = 12;

export async function seedAdminUser(options: SeedAdminOptions): Promise<SeedAdminResult> {
  const { auth, email, password, name, logger } = options;

  if (!email || !password) {
    logger?.warn(
      'no admin user configured — set DW_USER and DW_PASSWORD to create the first login',
    );
    return { seeded: false, reason: 'not-configured' };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    logger?.warn(
      `DW_PASSWORD is shorter than ${MIN_PASSWORD_LENGTH} characters; no admin user was created`,
    );
    return { seeded: false, reason: 'password-too-short' };
  }

  const ctx = await auth.$context;

  // Guard on this specific address rather than a global "any users exist"
  // count. A deployment that later adds a second admin and deletes the first
  // should not have the original silently reappear on the next restart.
  const existing = await ctx.internalAdapter.findUserByEmail(email);
  if (existing) return { seeded: false, reason: 'users-exist' };

  const passwordHash = await ctx.password.hash(password);
  const created = await ctx.internalAdapter.createUser({
    email,
    name: name || email.split('@')[0] || 'admin',
    // No mail transport is configured in a self-hosted deployment, so an
    // unverified admin could never verify and could never log in.
    emailVerified: true,
    role: 'admin',
    organizationId: DEFAULT_ORGANIZATION_ID,
    mustChangePassword: true,
  });

  // The password lives on a linked `credential` account, not on the user row —
  // which is what lets an OIDC account be linked to the same user later.
  await ctx.internalAdapter.linkAccount({
    userId: created.id,
    providerId: 'credential',
    accountId: created.id,
    password: passwordHash,
  });

  logger?.info(`created initial admin user: ${email} (change the password on first login)`);
  return { seeded: true, email };
}
