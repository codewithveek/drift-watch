/**
 * Postgres connection wiring.
 *
 * One pool per process, created from `DATABASE_URL`. The pool is small by
 * default because this server is not the throughput bottleneck — it serves a
 * console and a handful of SDK clients, and an oversized pool against a managed
 * Postgres is a good way to exhaust the server's connection limit with idle
 * connections instead of useful ones.
 */
import { Pool, type PoolConfig } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;

export interface CreateDatabaseOptions {
  connectionString: string;
  /** Defaults to 10. */
  maxConnections?: number;
  /**
   * Force TLS on/off. Left undefined, TLS is inferred: enabled unless the host
   * is localhost. Managed providers (Neon, Supabase, RDS, Render) all require
   * it, and the failure mode when it is missing is a confusing connection reset
   * rather than a clear error, so defaulting it on for remote hosts saves a
   * predictable support round-trip.
   */
  ssl?: boolean;
}

export interface DatabaseHandle {
  db: Database;
  pool: Pool;
  close(): Promise<void>;
}

export function createDatabase(options: CreateDatabaseOptions): DatabaseHandle {
  const { connectionString, maxConnections = 10 } = options;

  const config: PoolConfig = {
    connectionString,
    max: maxConnections,
    // A connect attempt that hangs should fail fast and be retried by the
    // caller rather than holding a request open indefinitely.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  };

  const useSsl = options.ssl ?? !isLocalConnectionString(connectionString);
  if (useSsl) {
    // `rejectUnauthorized: false` because most managed providers terminate TLS
    // with a certificate chain Node does not trust out of the box. This still
    // encrypts the connection; it does not authenticate the server. Deployments
    // that need full verification should pass their CA via PGSSLROOTCERT and
    // set `ssl: false` here to let libpq's own handling take over.
    config.ssl = { rejectUnauthorized: false };
  }

  const pool = new Pool(config);

  // An idle client erroring (server restart, network blip) emits on the pool.
  // Without a listener Node treats it as an unhandled 'error' event and kills
  // the process — the pool itself recovers by discarding the dead client.
  pool.on('error', (error) => {
    console.error('[driftwatch] idle postgres client error', error);
  });

  return {
    db: drizzle(pool, { schema }),
    pool,
    close: () => pool.end(),
  };
}

/** Local hosts get plaintext by default; everything else gets TLS. */
function isLocalConnectionString(connectionString: string): boolean {
  try {
    const { hostname } = new URL(connectionString);
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      // The compose service name — the stack's own network is not the public
      // internet, and requiring TLS there would mean shipping certs with the
      // reference deployment for no security gain.
      hostname === 'postgres' ||
      hostname === 'db'
    );
  } catch {
    // Not a URL (e.g. a libpq keyword string). Assume remote and encrypt.
    return false;
  }
}
