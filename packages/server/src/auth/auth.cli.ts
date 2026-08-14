/**
 * Config entry point for `better-auth generate` ONLY — never imported by the
 * running server.
 *
 * The CLI needs a module that exports a constructed `auth` instance, but the
 * real one (./auth.ts) is a factory taking a live `Database`, because the server
 * cannot build it until the pool exists and migrations have run. This file
 * bridges that by handing the factory a database that is never queried:
 * generation reads the *config* (which tables, which columns) and issues no SQL.
 *
 * Keeping it as a thin wrapper around `createAuth` rather than a second copy of
 * the config is the point — a duplicated config would drift, and the generated
 * schema would then describe tables the server does not actually use.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { createAuth } from './auth.js';

export const auth = createAuth({
  db: drizzle({} as never),
  // Length-valid placeholder; generation never signs anything.
  secret: 'schema-generation-placeholder-secret',
  baseUrl: 'http://localhost:3000',
});
