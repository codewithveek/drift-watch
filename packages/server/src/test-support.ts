/**
 * Test-only helpers. Excluded from the build (see tsconfig.json).
 *
 * ## Why each Postgres test file needs its own database
 *
 * Vitest runs test FILES in parallel by default, and every Postgres suite here
 * starts by truncating the tables it uses. Sharing one database means one file's
 * `TRUNCATE ... CASCADE` can land in the middle of another file's test and
 * delete rows it just wrote — which surfaced as an intermittent failure in an
 * assertion that had nothing to do with the file that broke it.
 *
 * The alternatives were worse. Disabling file parallelism slows the whole suite
 * to fix two files. Coordinating on distinct agent ids fails because the
 * ordering assertions depend on `RESTART IDENTITY`, which is table-wide. A
 * database per file is complete isolation for one `CREATE DATABASE` at startup.
 */
import { Client } from 'pg';

/**
 * Ensures a dedicated database exists and returns its connection URL.
 *
 * Pass a name unique to the calling test file. Creation runs against the
 * `postgres` maintenance database, since `CREATE DATABASE` cannot run inside the
 * database being created (nor inside a transaction).
 */
export async function createTestDatabase(
  baseUrl: string,
  name: string,
): Promise<string> {
  const url = new URL(baseUrl);
  const databaseName = `dw_test_${name}`;

  const maintenanceUrl = new URL(url.toString());
  maintenanceUrl.pathname = '/postgres';

  const client = new Client({ connectionString: maintenanceUrl.toString() });
  await client.connect();
  try {
    // Dropped and recreated rather than reused: a leftover schema from an older
    // migration set would fail the migrator with "relation already exists",
    // which is a confusing way to discover a stale test database.
    await client.query(`drop database if exists "${databaseName}" with (force)`);
    await client.query(`create database "${databaseName}"`);
  } finally {
    await client.end();
  }

  url.pathname = `/${databaseName}`;
  return url.toString();
}
