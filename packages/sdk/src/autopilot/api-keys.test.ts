import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  API_KEY_SCOPES,
  API_KEY_SCOPE_DESCRIPTIONS,
  API_KEY_TOKEN_PREFIX,
  hashApiKeyToken,
  isApiKeyFleetWide,
  isApiKeyScope,
  mintApiKey,
  toPublicApiKey,
} from './api-keys.js';
import { MemoryStateStore } from './memory-store.js';

function mint(overrides: Partial<Parameters<typeof mintApiKey>[0]> = {}) {
  return mintApiKey({ name: 'test key', scopes: ['read'], createdBy: 'root', ...overrides });
}

describe('mintApiKey', () => {
  it('produces a prefixed, high-entropy token that is never stored in the record', () => {
    const { record, token } = mint();

    expect(token.startsWith(API_KEY_TOKEN_PREFIX)).toBe(true);
    // 24 bytes base64url = 32 chars, plus the prefix.
    expect(token).toHaveLength(API_KEY_TOKEN_PREFIX.length + 32);
    expect(JSON.stringify(record)).not.toContain(token);
  });

  it('stores sha256(token), which is what makes the hash usable as an index', () => {
    const { record, token } = mint();
    expect(record.hash).toBe(createHash('sha256').update(token, 'utf8').digest('hex'));
    // Deterministic — the same token always resolves to the same lookup key.
    expect(hashApiKeyToken(token)).toBe(record.hash);
  });

  it('never repeats a token or an id across mints', () => {
    const minted = Array.from({ length: 50 }, () => mint());
    expect(new Set(minted.map((m) => m.token)).size).toBe(50);
    expect(new Set(minted.map((m) => m.record.id)).size).toBe(50);
  });

  it('keeps a display prefix that identifies but cannot authenticate', () => {
    const { record, token } = mint();
    expect(token.startsWith(record.prefix)).toBe(true);
    expect(record.prefix.length).toBeLessThan(token.length);
  });

  it('treats an empty agentIds list as fleet-wide rather than "no agents"', () => {
    // The distinction matters: a key recorded with agentIds: [] would match no
    // agent at all, silently making it useless instead of unrestricted.
    const { record } = mint({ agentIds: [] });
    expect(record.agentIds).toBeUndefined();
    expect(isApiKeyFleetWide(record)).toBe(true);

    const scoped = mint({ agentIds: ['agent-1'] }).record;
    expect(isApiKeyFleetWide(scoped)).toBe(false);
  });
});

describe('toPublicApiKey', () => {
  it('strips the hash — the one field an offline attacker would want', () => {
    const { record } = mint();
    const publicKey = toPublicApiKey(record);
    expect('hash' in publicKey).toBe(false);
    expect(publicKey.id).toBe(record.id);
    expect(publicKey.prefix).toBe(record.prefix);
  });
});

describe('scope catalogue', () => {
  it('describes every scope, so a new one cannot ship without operator copy', () => {
    for (const scope of API_KEY_SCOPES) {
      expect(API_KEY_SCOPE_DESCRIPTIONS[scope]).toBeTruthy();
    }
    expect(Object.keys(API_KEY_SCOPE_DESCRIPTIONS)).toHaveLength(API_KEY_SCOPES.length);
  });

  it('rejects unknown scope strings', () => {
    expect(isApiKeyScope('read')).toBe(true);
    expect(isApiKeyScope('admin')).toBe(false);
    expect(isApiKeyScope(42)).toBe(false);
  });
});

describe('MemoryStateStore api keys', () => {
  it('looks a key up by its hash and by its id', async () => {
    const store = new MemoryStateStore();
    const { record, token } = mint();
    await store.createApiKey(record);

    expect((await store.getApiKeyByHash(hashApiKeyToken(token)))?.id).toBe(record.id);
    expect((await store.getApiKey(record.id))?.name).toBe('test key');
    expect(await store.getApiKeyByHash(hashApiKeyToken('dw_nope'))).toBeUndefined();
  });

  it('keeps a revoked key resolvable by hash so the gate can say "revoked", not "unknown"', async () => {
    const store = new MemoryStateStore();
    const { record, token } = mint();
    await store.createApiKey(record);

    const revoked = await store.revokeApiKey(record.id, 'root');
    expect(revoked?.revokedAt).toBeTypeOf('number');
    expect(revoked?.revokedBy).toBe('root');

    const found = await store.getApiKeyByHash(hashApiKeyToken(token));
    expect(found?.revokedAt).toBeTypeOf('number');
  });

  it('is idempotent on double revoke', async () => {
    const store = new MemoryStateStore();
    const { record } = mint();
    await store.createApiKey(record);

    expect(await store.revokeApiKey(record.id, 'root')).toBeDefined();
    expect(await store.revokeApiKey(record.id, 'root')).toBeUndefined();
    expect(await store.revokeApiKey('no-such-key', 'root')).toBeUndefined();
  });

  it('records last-used without disturbing any other field', async () => {
    const store = new MemoryStateStore();
    const { record } = mint({ scopes: ['read', 'agent:run'] });
    await store.createApiKey(record);

    await store.touchApiKey(record.id, 1234);
    const touched = await store.getApiKey(record.id);
    expect(touched?.lastUsedAt).toBe(1234);
    expect(touched?.scopes).toEqual(['read', 'agent:run']);
    // No throw for an unknown id — touching is best-effort by contract.
    await expect(store.touchApiKey('gone', 1)).resolves.toBeUndefined();
  });

  it('lists newest first', async () => {
    const store = new MemoryStateStore();
    await store.createApiKey(mint({ name: 'older', now: 1000 }).record);
    await store.createApiKey(mint({ name: 'newer', now: 2000 }).record);

    expect((await store.listApiKeys()).map((key) => key.name)).toEqual(['newer', 'older']);
  });
});

describe('MemoryStateStore audit log', () => {
  const event = (overrides: Record<string, unknown> = {}) => ({
    id: `event-${Math.random()}`,
    at: 1,
    actor: 'root',
    actorLabel: 'admin@example.test',
    action: 'agent.update' as const,
    summary: 'updated guardrails',
    ...overrides,
  });

  it('returns newest first and honours the limit', async () => {
    const store = new MemoryStateStore();
    await store.recordAuditEvent(event({ id: 'a', summary: 'first' }));
    await store.recordAuditEvent(event({ id: 'b', summary: 'second' }));

    const all = await store.listAuditEvents(10);
    expect(all.map((entry) => entry.id)).toEqual(['b', 'a']);
    expect(await store.listAuditEvents(1)).toHaveLength(1);
  });

  it('filters to one agent, keeping fleet-level events out of a scoped read', async () => {
    const store = new MemoryStateStore();
    await store.recordAuditEvent(event({ id: 'scoped', agentId: 'agent-1' }));
    await store.recordAuditEvent(event({ id: 'other', agentId: 'agent-2' }));
    await store.recordAuditEvent(event({ id: 'fleet', action: 'apikey.create' }));

    const scoped = await store.listAuditEvents(10, 'agent-1');
    expect(scoped.map((entry) => entry.id)).toEqual(['scoped']);
  });
});
