/**
 * "Last active" (server/access.ts noteActive): written to users/{uid}.lastActiveAt
 * at most every 5 minutes per account, time only.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ACTIVE_WRITE_MS, clearActiveCache, noteActive } from '../server/access.js';
import { FakeDb } from './fakeDb.js';

beforeEach(() => clearActiveCache());

describe('last active', () => {
  it('is written at most once every 5 minutes per account', async () => {
    const db = new FakeDb();
    db.docs.set('users/u1', { email: 'a@example.com' });
    const t0 = Date.parse('2026-11-13T22:00:00Z');
    await noteActive(db.asFirestore(), 'u1', undefined, t0);
    expect(db.docs.get('users/u1')).toMatchObject({ email: 'a@example.com', lastActiveAt: t0 });
    await noteActive(db.asFirestore(), 'u1', t0, t0 + 60_000);
    expect(db.docs.get('users/u1')).toMatchObject({ lastActiveAt: t0 });
    await noteActive(db.asFirestore(), 'u1', t0, t0 + ACTIVE_WRITE_MS);
    expect(db.docs.get('users/u1')).toMatchObject({ lastActiveAt: t0 + ACTIVE_WRITE_MS });
  });

  it('skips the write when the stored time is recent, even on a fresh server', async () => {
    const db = new FakeDb();
    const t0 = Date.parse('2026-11-13T22:00:00Z');
    db.docs.set('users/u2', { lastActiveAt: t0 });
    await noteActive(db.asFirestore(), 'u2', t0, t0 + 1000);
    expect(db.docs.get('users/u2')).toEqual({ lastActiveAt: t0 });
  });
});
