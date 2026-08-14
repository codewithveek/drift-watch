/**
 * drizzle-kit config — used only to GENERATE migration SQL from schema.ts.
 *
 * Applying migrations is not drizzle-kit's job here: the server runs them
 * itself at boot via drizzle-orm's migrator (see src/db/migrate.ts), so a
 * deployment needs no extra command, no devDependency in the runtime image, and
 * no window where the container is up but the schema is old.
 *
 * Regenerate after any schema.ts change:
 *   pnpm --filter @driftwatch/server db:generate
 */
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  // Both files: the control-plane tables this project defines, and better-auth's
  // generated user/session/account/verification tables. They must migrate
  // together — one migration history, one advisory lock, one boot step.
  schema: ['./src/db/schema.ts', './src/db/auth-schema.ts'],
  out: './drizzle',
  // Only read by `drizzle-kit push`/`studio`, which this project does not use in
  // deployment — generation itself needs no live connection.
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/driftwatch',
  },
  strict: true,
  verbose: true,
});
