/**
 * Email records (emailLog/{id}): kept 90 days, then removed by the daily cron,
 * and removed at once when their account is permanently deleted.
 */
import { describe, expect, it } from 'vitest';
import { deleteEmailLogOf, pruneEmailLog } from '../server/email/log.js';
import { FakeDb } from './fakeDb.js';

const DAY = 86_400_000;
const row = (uid: string | null, at: number) => ({ at, updatedAt: at, uid, type: 'otp', to: 'ki•••@gmail.com', provider: 'brevo', messageId: null, accepted: true, status: 'delivered' });

describe('email record retention', () => {
  it('removes records older than 90 days', async () => {
    const db = new FakeDb();
    const now = Date.parse('2026-11-13T10:00:00Z');
    db.docs.set('emailLog/old', row('u1', now - 91 * DAY));
    db.docs.set('emailLog/recent', row('u1', now - 89 * DAY));
    expect(await pruneEmailLog(db.asFirestore(), now)).toBe(1);
    expect([...db.docs.keys()].filter((k) => k.startsWith('emailLog/'))).toEqual(['emailLog/recent']);
  });

  it("removes an account's records when it is permanently deleted", async () => {
    const db = new FakeDb();
    db.docs.set('emailLog/a', row('gone', 1));
    db.docs.set('emailLog/b', row('gone', 2));
    db.docs.set('emailLog/c', row('stays', 3));
    expect(await deleteEmailLogOf(db.asFirestore(), 'gone')).toBe(2);
    expect([...db.docs.keys()].filter((k) => k.startsWith('emailLog/'))).toEqual(['emailLog/c']);
  });
});
