/**
 * Subpath entry: `import { RedisStateStore } from '@driftwatch/sdk/redis'`.
 * Isolated from the package root so core SDK consumers never pull in
 * `ioredis` — only importers of this subpath need it installed (it's an
 * optional peer dependency; see package.json).
 */
export { RedisStateStore } from './autopilot/redis-store.js';
