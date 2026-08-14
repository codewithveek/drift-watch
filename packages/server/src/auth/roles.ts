/**
 * User roles, expressed as named bundles of the EXISTING API-key scopes.
 *
 * This is the whole point: there is one permission vocabulary in DriftWatch
 * (`ApiKeyScope`), and a role is a shorthand for a set of them. A user and a
 * machine key are therefore authorized by literally the same check in
 * routes/auth.ts — `principal.scopes.includes(required)` — and a new scope
 * cannot be added without deciding, right here, which humans get it.
 *
 * The alternative (a parallel `role`-based permission system alongside the
 * scope-based one) is how authorization bugs happen: two systems that must agree
 * and inevitably drift, so a route protected in one is unprotected in the other.
 */
import { API_KEY_SCOPES, type ApiKeyScope } from '@driftwatch/sdk';

export const USER_ROLES = ['admin', 'operator', 'viewer'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const ROLE_SCOPES: Record<UserRole, readonly ApiKeyScope[]> = {
  /** Everything, including minting keys and creating other users. */
  admin: API_KEY_SCOPES,
  /**
   * Day-to-day operation: triage approvals, pause a misbehaving agent, adjust
   * guardrails. Deliberately excludes `keys:admin` — an operator who can mint a
   * fleet-wide key can grant themselves admin, which would make the distinction
   * decorative.
   */
  operator: [
    'read',
    'agent:run',
    'approvals:write',
    'control:write',
    'agents:write',
    'policy:write',
  ],
  /** Read-only. For auditors, and for anyone who should see without touching. */
  viewer: ['read'],
};

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value);
}

/**
 * Scopes for a role string coming out of the database.
 *
 * An unrecognised value resolves to the LEAST privilege, not the most — a
 * typo'd or removed role must never silently widen access. It returns `viewer`
 * rather than an empty set so a user with a stale role can still log in and see
 * that something is wrong, instead of hitting an unexplained wall of 403s.
 */
export function scopesForRole(role: string | null | undefined): readonly ApiKeyScope[] {
  return isUserRole(role) ? ROLE_SCOPES[role] : ROLE_SCOPES.viewer;
}
