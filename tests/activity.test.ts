/**
 * Admin › Activity & Requests feed (server/account/events.ts): every account
 * event also lands in activity/{id}, newest first with paging, kept 90 days,
 * and removed with the account on permanent deletion. Never message content.
 */
import { describe, expect, it } from 'vitest';
import { deleteActivityOf, listActivity, pruneActivity, recordSecurityEvent } from '../server/account/events.js';
import { FakeDb } from './fakeDb.js';

const DAY = 86_400_000;

describe('activity feed', () => {
  it('records every account event centrally, newest first, with paging', async () => {
    const db = new FakeDb();
    const t0 = Date.parse('2026-11-13T10:00:00Z');
    for (let i = 0; i < 5; i++) await recordSecurityEvent(db.asFirestore(), `u${i % 2}`, 'login', { device: 'Chrome on Android' }, t0 + i * 1000);
    const first = await listActivity(db.asFirestore(), undefined, 3);
    expect(first.map((r) => r.data.atMs)).toEqual([t0 + 4000, t0 + 3000, t0 + 2000]);
    expect(first[0].data).toMatchObject({ uid: 'u0', type: 'login', device: 'Chrome on Android', by: 'user' });
    const next = await listActivity(db.asFirestore(), first.at(-1)!.data.atMs, 3);
    expect(next.map((r) => r.data.atMs)).toEqual([t0 + 1000, t0]);
    // the per-account copy is still written
    expect([...db.docs.keys()].filter((k) => k.startsWith('users/u0/securityEvents/'))).toHaveLength(3);
  });

  it('keeps entries for 90 days', async () => {
    const db = new FakeDb();
    const now = Date.parse('2026-11-13T10:00:00Z');
    await recordSecurityEvent(db.asFirestore(), 'u1', 'login', {}, now - 91 * DAY);
    await recordSecurityEvent(db.asFirestore(), 'u1', 'login', {}, now - 10 * DAY);
    expect(await pruneActivity(db.asFirestore(), now)).toBe(1);
    expect(await listActivity(db.asFirestore())).toHaveLength(1);
  });

  it("removes an account's entries when it is permanently deleted", async () => {
    const db = new FakeDb();
    await recordSecurityEvent(db.asFirestore(), 'gone', 'login');
    await recordSecurityEvent(db.asFirestore(), 'stays', 'login');
    expect(await deleteActivityOf(db.asFirestore(), 'gone')).toBe(1);
    expect((await listActivity(db.asFirestore())).map((r) => r.data.uid)).toEqual(['stays']);
  });
});
