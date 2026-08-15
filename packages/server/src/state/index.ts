/**
 * Selects the StateStore implementation for this deployment.
 *
 * Precedence is `DATABASE_URL` > `REDIS_URL` > in-memory, and it is deliberately
 * ordered by durability rather than by which was configured most recently:
 *
 *   - **Postgres** is the production answer. It is the only backend that keeps
 *     API keys, audit events and drift history across a restart, and the only
 *     one that can answer the ranged/relational queries the console's reporting
 *     needs. Choosing it also removes Redis from the required stack entirely —
 *     `PostgresStateStore` implements all 28 methods, including the leader lock
 *     and cooldown that used to be Redis's reason for existing here.
 *   - **Redis** stays supported for deployments already running it, and for
 *     multi-process setups that have no Postgres.
 *   - **Memory** remains the zero-configuration default so `pnpm dev` and the
 *     test suite need no services at all. It is single-process and loses
 *     everything on restart — including minted API keys, which is why the root
 *     credential exists as a bootstrap path.
 *
 * Both stores being configured is not an error: Postgres wins, and the caller
 * logs which one was chosen so an operator can see that their REDIS_URL is
 * being ignored rather than silently mis-attributing behaviour to it.
 */
import { MemoryStateStore, type StateStore } from '@driftwatch/sdk';
import { createDatabase, type Database } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { seedOrganization } from '../db/seed.js';
import { PostgresStateStore } from '../db/postgres-store.js';
import { RedisStateStore } from './redis-store.js';

export { MemoryStateStore } from '@driftwatch/sdk';
export { RedisStateStore } from './redis-store.js';
export { PostgresStateStore } from '../db/postgres-store.js';

export type StateStoreKind = 'postgres' | 'redis' | 'memory';

export interface CreateStateStoreOptions {
  databaseUrl?: string;
  redisUrl?: string;
  logger?: { info(message: string): void; error(message: string, error: unknown): void };
}

export interface CreatedStateStore {
  store: StateStore;
  kind: StateStoreKind;
  /**
   * Present only for the Postgres backend. Exposed so better-auth can share
   * this pool rather than opening a second one — they are the same database and
   * the same process, and two pools would double the connection count against a
   * managed Postgres for no benefit. Its absence is also the signal that human
   * login is unavailable: better-auth requires a database.
   */
  db?: Database;
}

/**
 * Async because Postgres has to migrate and seed before the store is usable.
 * The previous signature was synchronous and took only a Redis URL; callers
 * now await this during boot, before the HTTP server starts listening, so no
 * request can arrive against an unmigrated schema.
 */
export async function createStateStore(
  options: CreateStateStoreOptions,
): Promise<CreatedStateStore> {
  const { databaseUrl, redisUrl, logger } = options;

  if (databaseUrl) {
    const handle = createDatabase({ connectionString: databaseUrl });
    await runMigrations({ db: handle.db, ...(logger ? { logger } : {}) });
    await seedOrganization(handle.db);
    if (redisUrl) {
      logger?.info('DATABASE_URL is set; REDIS_URL is ignored (Postgres implements every method)');
    }
    return {
      store: new PostgresStateStore({ db: handle.db, onClose: handle.close }),
      kind: 'postgres',
      db: handle.db,
    };
  }

  if (redisUrl) return { store: new RedisStateStore(redisUrl), kind: 'redis' };
  return { store: new MemoryStateStore(), kind: 'memory' };
}
