/**
 * Selects the StateStore implementation: Redis when a URL is supplied (for
 * multi-process deployments), otherwise the in-memory store (dev/demo). Both
 * implementations live in @driftwatch/sdk — this file is just the config-to-
 * instance wiring specific to this server.
 */
import { MemoryStateStore, type StateStore } from '@driftwatch/sdk';
import { RedisStateStore } from '@driftwatch/sdk/redis';

export { MemoryStateStore } from '@driftwatch/sdk';
export { RedisStateStore } from '@driftwatch/sdk/redis';

export function createStateStore(redisUrl: string): StateStore {
  return redisUrl ? new RedisStateStore(redisUrl) : new MemoryStateStore();
}
