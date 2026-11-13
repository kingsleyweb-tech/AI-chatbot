/**
 * Getting a deleted account back (server/account/restore.ts): the "Cancel
 * deletion" link, restore requests from the sign-in screen, and the reminder
 * 7 days before permanent deletion. In-memory database, accounts and mail.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { restoreAccount, scheduleDeletion } from '../server/account/lifecycle.js';
import {
  cancelDeletion,
  closeRequest,
  confirmRestore,
  pendingRestoreRequests,
  readRestoreToken,
  remindDue,
  requestRestore,
  restoreToken,
  type RestoreDeps,
} from '../server/account/restore.js';
import { setAccountAdmin } from '../server/admin.js';
import type { EmailMessage, EmailProvider } from '../server/email/provider.js';
import { FakeAccounts } from './fakeAccounts.js';
import { FakeDb } from './fakeDb.js';

class FakeMail implements EmailProvider {
  name = 'fake';
  sent: EmailMessage[] = [];
  async send(m: EmailMessage) {
    this.sent.push(m);
    return { messageId: `<m${this.sent.length}@test>`, attempts: 1 };
  }
}

const SECRET = 'r'.repeat(64);
const DAY = 86_400_000;
let db: FakeDb;
let accounts: FakeAccounts;
let mail: FakeMail;
let now: number;
let deps: RestoreDeps;
const owner = { uid: 'u1', email: 'ama@example.com' };

/** the token inside the last email's link */
const lastToken = () => decodeURIComponent(/(?:&amp;|[?&])t=([^"&\s<]+)/.exec(mail.sent.at(-1)!.html)![1]);

async function deleteAccount(by: 'admin' | 'user' = 'user') {
  const account = (await accounts.get('u1'))!;
  await scheduleDeletion(db.asFirestore(), owner, account, now, by);
}

beforeEach(() => {
  db = new FakeDb();
  accounts = new FakeAccounts();
  mail = new FakeMail();
  setAccountAdmin(accounts);
  now = Date.parse('2026-11-13T10:00:00Z');
  accounts.add({ uid: 'u1', email: owner.email, displayName: 'Ama', providers: ['password'] });
  db.docs.set('users/u1', { email: owner.email, accountStatus: 'active' });
  deps = {
    db: db.asFirestore(),
    accounts,
    mail: { db: db.asFirestore(), provider: mail, baseUrl: 'https://atlas.test', dailyCap: 100, now: () => now },
    secret: SECRET,
    now: () => now,
  };
});
afterEach(() => setAccountAdmin(null));

describe('restore links', () => {
  it('are signed: a changed uid, time or signature is refused', () => {
    const t = restoreToken(SECRET, 'cancel', 'u1', now);
    expect(readRestoreToken(SECRET, 'cancel', t)).toEqual({ uid: 'u1', stamp: now });
    expect(readRestoreToken(SECRET, 'confirm', t)).toBeNull();
    expect(readRestoreToken('x'.repeat(64), 'cancel', t)).toBeNull();
    expect(readRestoreToken(SECRET, 'cancel', t.replace('u1.', 'u2.'))).toBeNull();
    expect(readRestoreToken(SECRET, 'cancel', 'garbage')).toBeNull();
  });
});

describe('cancel deletion from the email link', () => {
  it('restores an account its owner deleted', async () => {
    await deleteAccount('user');
    expect((await accounts.get('u1'))!.disabled).toBe(true);
    await cancelDeletion(deps, restoreToken(SECRET, 'cancel', 'u1', now));
    expect(db.docs.get('users/u1')).toMatchObject({ accountStatus: 'active', purgeAfter: null, deletedBy: null });
    expect((await accounts.get('u1'))!.disabled).toBe(false);
  });

  it('works only once and not for an older deletion', async () => {
    await deleteAccount('user');
    const t = restoreToken(SECRET, 'cancel', 'u1', now);
    await cancelDeletion(deps, t);
    await expect(cancelDeletion(deps, t)).rejects.toMatchObject({ code: 'link_invalid' });
    now += 1000;
    await deleteAccount('user'); // deleted again: the first link stays dead
    await expect(cancelDeletion(deps, t)).rejects.toMatchObject({ code: 'link_invalid' });
  });

  it('never restores an account an administrator deleted', async () => {
    await deleteAccount('admin');
    await expect(cancelDeletion(deps, restoreToken(SECRET, 'cancel', 'u1', now))).rejects.toMatchObject({ code: 'link_invalid' });
    expect(db.docs.get('users/u1')).toMatchObject({ accountStatus: 'deleted' });
  });

  it('stops working after the 30 days', async () => {
    await deleteAccount('user');
    const t = restoreToken(SECRET, 'cancel', 'u1', now);
    now += 31 * DAY;
    await expect(cancelDeletion(deps, t)).rejects.toMatchObject({ code: 'link_invalid' });
  });
});

describe('restore requests from the sign-in screen', () => {
  it('emails a confirmation link; once confirmed, administrators see it', async () => {
    await deleteAccount('admin');
    await requestRestore(deps, 'Ama@Example.com', 'I deleted it by mistake', '1.2.3.4');
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to.email).toBe(owner.email);
    expect(await pendingRestoreRequests(deps.db)).toHaveLength(0); // not confirmed yet
    await confirmRestore(deps, lastToken());
    const pending = await pendingRestoreRequests(deps.db);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ uid: 'u1', reason: 'I deleted it by mistake', deletedBy: 'admin' });
  });

  it('answers the same for unknown, active and deleted addresses, and only emails the deleted one', async () => {
    await requestRestore(deps, 'nobody@example.com', undefined, '1.2.3.4');
    await requestRestore(deps, owner.email, undefined, '1.2.3.4'); // active account
    expect(mail.sent).toHaveLength(0);
  });

  it('refuses an expired or replayed confirmation link', async () => {
    await deleteAccount('user');
    await requestRestore(deps, owner.email, undefined, '1.2.3.4');
    const t = lastToken();
    now += 25 * 3_600_000;
    await expect(confirmRestore(deps, t)).rejects.toMatchObject({ code: 'link_invalid' });
  });

  it('limits how often an address can ask', async () => {
    await deleteAccount('user');
    for (let i = 0; i < 3; i++) await requestRestore(deps, owner.email, undefined, `10.0.0.${i}`);
    await expect(requestRestore(deps, owner.email, undefined, '10.0.0.9')).rejects.toMatchObject({ status: 429 });
  });

  it('approving or declining tells the person by email', async () => {
    await deleteAccount('user');
    await requestRestore(deps, owner.email, undefined, '1.2.3.4');
    await confirmRestore(deps, lastToken());
    expect(await closeRequest(deps.db, 'u1', 'declined', now, 'admin1', deps.mail)).toBe(true);
    expect(mail.sent.at(-1)!.subject).toBe('Your Atlas AI restore request');
    expect(db.docs.get('restoreRequests/u1')).toMatchObject({ status: 'declined', decidedBy: 'admin1' });
    // nothing waiting any more
    expect(await closeRequest(deps.db, 'u1', 'restored', now, 'admin1', deps.mail)).toBe(false);
  });
});

describe('reminder 7 days before permanent deletion', () => {
  it('is sent once, with a working cancel link, only for self-deleted accounts', async () => {
    await deleteAccount('user');
    now += 22 * DAY; // 8 days left
    expect(await remindDue(deps)).toBe(0);
    now += 2 * DAY; // 6 days left
    expect(await remindDue(deps)).toBe(1);
    expect(mail.sent.at(-1)!.subject).toBe('Your Atlas AI account will be deleted in 7 days');
    expect(await remindDue(deps)).toBe(0); // only once
    await cancelDeletion(deps, lastToken());
    expect(db.docs.get('users/u1')).toMatchObject({ accountStatus: 'active' });
  });

  it('is not sent for accounts an administrator deleted', async () => {
    await deleteAccount('admin');
    now += 25 * DAY;
    expect(await remindDue(deps)).toBe(0);
  });

  it('starts again after a restore and a new deletion', async () => {
    await deleteAccount('user');
    now += 25 * DAY;
    await remindDue(deps);
    await restoreAccount(deps.db, owner, (await accounts.get('u1'))!, now, 'admin');
    await deleteAccount('user');
    expect(db.docs.get('users/u1')).toMatchObject({ deletionReminderAt: null });
  });
});
