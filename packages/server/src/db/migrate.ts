/**
 * Schema migration, run by the server itself at boot.
 *
 * Deliberately not a separate `drizzle-kit migrate` step in the deploy pipeline:
 * this product's whole direction is a single deployable application, and a
 * migration that has to be invoked out-of-band is one more thing an operator can
 * forget, plus a window where the container is serving traffic against a schema
 * it was not built for.
 *
 * ## Concurrency
 *
 * Multiple replicas booting together would otherwise race: drizzle's migrator
 * checks its `__drizzle_migrations` table and applies what's missing, and two
 * processes doing that simultaneously can both decide to apply the same file.
 * A Postgres session-level advisory lock serialises them — the second replica
 * blocks until the first finishes, then finds nothing to do. The lock id is an
 * arbitrary constant; it only has to be stable and not collide with another
 * application's advisory locks on the same database.
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import type { Database } from './client.js';

/** Arbitrary but stable — "driftwatch schema migration" in this database. */
const MIGRATION_ADVISORY_LOCK_ID = 4_919_233_701;

/**
 * Resolved relative to this module rather than `process.cwd()`, because the
 * server is started from varying working directories (`pnpm dev` from the
 * package, `node dist/server.js` from the image root, vitest from the repo
 * root). From `dist/db/` or `src/db/`, the folder is two levels up.
 */
function migrationsFolder(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');
}

export interface RunMigrationsOptions {
  db: Database;
  logger?: { info(message: string): void; error(message: string, error: unknown): void };
}

export async function runMigrations({ db, logger }: RunMigrationsOptions): Promise<void> {
  await db.execute(sql`select pg_advisory_lock(${MIGRATION_ADVISORY_LOCK_ID})`);
  try {
    await migrate(db, { migrationsFolder: migrationsFolder() });
    logger?.info('database schema up to date');
  } catch (error) {
    logger?.error('database migration failed', error);
    // Rethrow: serving traffic against a schema the code does not match
    // produces confusing partial failures rather than one clear one at boot.
    throw error;
  } finally {
    // Released explicitly rather than relying on the connection closing, since
    // the pool keeps this client alive for the rest of the process's life.
    await db.execute(sql`select pg_advisory_unlock(${MIGRATION_ADVISORY_LOCK_ID})`);
  }
}
