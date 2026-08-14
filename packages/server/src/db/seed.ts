/**
 * Boot-time seeding.
 *
 * Two things are seeded, and they have deliberately different rules:
 *
 *   - **The default organization** is created if absent, every boot. It is a
 *     structural row (every other table's `organization_id` references it), not
 *     a piece of user data, so re-creating it is always safe.
 *   - **The admin user** is created ONLY when the users table is empty. This is
 *     the important one: re-seeding from `DW_PASSWORD` on every boot would
 *     silently undo an operator's password change, turning a compose file into
 *     a permanent backdoor. Seed-if-empty means the env var bootstraps the
 *     first login and then stops mattering.
 *
 * The admin seed lives in auth/seed-admin.ts alongside the password hashing it
 * needs; this module owns only the tenancy row, so the store factory can call it
 * without pulling the auth stack into the storage layer.
 */
import { eq } from 'drizzle-orm';
import type { Database } from './client.js';
import { DEFAULT_ORGANIZATION_ID, organizations } from './schema.js';

export async function seedOrganization(db: Database, id = DEFAULT_ORGANIZATION_ID): Promise<void> {
  const [existing] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, id))
    .limit(1);
  if (existing) return;

  await db
    .insert(organizations)
    .values({ id, name: 'Default', createdAt: Date.now() })
    // Two replicas booting simultaneously both see "absent" and both insert.
    // The loser would otherwise crash the process on a duplicate key at boot,
    // which is a needlessly dramatic way to fail at doing nothing.
    .onConflictDoNothing();
}
