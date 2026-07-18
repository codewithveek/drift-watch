/**
 * Selects the StateStore implementation: Redis when a URL is supplied (for
 * multi-process deployments), otherwise the in-memory store (dev/demo).
 */
import type { StateStore } from '@driftwatch/sdk';
import { MemoryStateStore } from './memory-store.js';
import { RedisStateStore } from './redis-store.js';

export { MemoryStateStore } from './memory-store.js';
export { RedisStateStore } from './redis-store.js';

export function createStateStore(redisUrl: string): StateStore {
  return redisUrl ? new RedisStateStore(redisUrl) : new MemoryStateStore();
}
