import { beforeEach, describe, expect, it } from 'vitest';
import { mergeArticles, searchArticles, HELP_ARTICLES } from '../server/shared/help.js';
import { SUPPORT_LIMITS } from '../server/shared/support.js';
import {
  addUserMessage,
  adminAddNote,
  adminAssign,
  adminDelete,
  adminDetail,
  adminList,
  adminReply,
  adminSetPriority,
  adminSetStatus,
  checkAttachments,
  confirmResolved,
  createReport,
  deleteReportsOf,
  getAttachment,
  getOwnReport,
  listOwnReports,
  markAdminNotificationsRead,
  newRef,
  REF_PATTERN,
  reopenOwn,
  type Person,
} from '../server/support/reports.js';
import { FakeDb } from './fakeDb.js';

const ama: Person = { uid: 'u1', email: 'ama@example.com', name: 'Ama Mensah' };
const kojo: Person = { uid: 'u2', email: 'kojo@example.com', name: 'Kojo' };
const admin = { uid: 'a1', email: 'owner@example.com' };
const PNG = 'data:image/png;base64,' + 'A'.repeat(400);

let db: FakeDb;
let fs: ReturnType<FakeDb['asFirestore']>;
let n = 0;
const sub = () => `submission${++n}`;
const report = (who = ama, o: Partial<Parameters<typeof createReport>[2]> = {}) =>
  createReport(fs, who, { title: 'Upload fails', category: 'documents', description: 'The PDF upload spins forever.', submissionId: sub(), ...o });

beforeEach(() => {
  db = new FakeDb();
  fs = db.asFirestore();
});

describe('references', () => {
  it('are human readable and unambiguous', () => {
    const r = newRef(Date.UTC(2026, 10, 8));
    expect(r).toMatch(REF_PATTERN);
    expect(r.startsWith('ATL-2611-')).toBe(true);
    expect(r.slice(9)).not.toMatch(/[01OIL]/);
  });
});

describe('creating a report', () => {
  it('stores every required field, starts as new / medium and notifies administrators', async () => {
    const { ref, duplicate } = await report(ama, { attachments: [{ name: 'shot.png', dataUrl: PNG }] });
    expect(duplicate).toBe(false);
    const doc = db.docs.get(`supportReports/${ref}`)!;
    expect(doc).toMatchObject({ ref, uid: 'u1', userName: 'Ama Mensah', userEmail: 'ama@example.com', title: 'Upload fails', category: 'documents', status: 'new', priority: 'medium' });
    expect(typeof doc.createdAt).toBe('number');
    expect((doc.attachments as unknown[]).length).toBe(1);
    expect(db.under(`supportReports/${ref}/attachments/`)).toHaveLength(1);
    expect(db.docs.get(`adminNotifications/${ref}-new_report`)).toMatchObject({ kind: 'new_report', count: 1, readBy: [] });
  });

  it('returns the first report when the same form is submitted twice', async () => {
    const input = { title: 'Twice', category: 'bug' as const, description: 'Double tapped the button.', submissionId: 'same-submission' };
    const a = await createReport(fs, ama, input);
    const b = await createReport(fs, ama, input);
    expect(b).toEqual({ ref: a.ref, duplicate: true });
    expect(db.under('supportReports/').filter((p) => p.split('/').length === 2)).toHaveLength(1);
  });

  it('validates title, description, attachments and the daily limit', async () => {
    await expect(report(ama, { title: 'x' })).rejects.toMatchObject({ code: 'title_required' });
    await expect(report(ama, { description: 'short' })).rejects.toMatchObject({ code: 'description_required' });
    await expect(report(ama, { attachments: [{ name: 'a.svg', dataUrl: 'data:image/svg+xml;base64,AAAA' }] })).rejects.toMatchObject({ code: 'file_type' });
    await expect(report(ama, { attachments: [{ name: 'big.png', dataUrl: 'data:image/png;base64,' + 'A'.repeat(SUPPORT_LIMITS.attachmentChars) }] })).rejects.toMatchObject({ code: 'file_too_large' });
    expect(() => checkAttachments(Array.from({ length: 4 }, () => ({ name: 'x.png', dataUrl: PNG })))).toThrow(/at most 3/);
    for (let i = 0; i < SUPPORT_LIMITS.reportsPerDay; i++) await report(ama);
    await expect(report(ama)).rejects.toMatchObject({ code: 'too_many_reports' });
  });
});

describe('isolation between users', () => {
  it('lists and opens only the caller’s own reports', async () => {
    const { ref } = await report(ama);
    await report(kojo, { title: 'Kojo problem' });
    expect((await listOwnReports(fs, ama)).map((r) => r.ref)).toEqual([ref]);
    await expect(getOwnReport(fs, kojo, ref)).rejects.toMatchObject({ status: 404 });
    await expect(addUserMessage(fs, kojo, ref, { text: 'hi' })).rejects.toMatchObject({ status: 404 });
    await expect(confirmResolved(fs, kojo, ref)).rejects.toMatchObject({ status: 404 });
    await expect(reopenOwn(fs, kojo, ref)).rejects.toMatchObject({ status: 404 });
  });

  it('serves screenshots only to the owner or an administrator', async () => {
    const { ref } = await report(ama, { attachments: [{ name: 's.png', dataUrl: PNG }] });
    const id = (db.docs.get(`supportReports/${ref}`)!.attachments as { id: string }[])[0].id;
    expect((await getAttachment(fs, ama, false, ref, id)).dataUrl).toBe(PNG);
    expect((await getAttachment(fs, { uid: 'a1', email: admin.email, name: 'A' }, true, ref, id)).dataUrl).toBe(PNG);
    await expect(getAttachment(fs, kojo, false, ref, id)).rejects.toMatchObject({ status: 404 });
  });

  it('never returns internal fields to the user', async () => {
    const { ref } = await report(ama);
    await adminAddNote(fs, admin, ref, 'Looks like a duplicate of ATL-xxx; user is rude.');
    await adminSetPriority(fs, admin, ref, 'high');
    const view = await getOwnReport(fs, ama, ref);
    const text = JSON.stringify(view);
    expect(text).not.toContain('rude');
    expect(text).not.toContain('priority');
    expect(text).not.toContain('owner@example.com');
    expect(view.report).not.toHaveProperty('uid');
  });
});

describe('conversation and statuses', () => {
  it('delivers an admin reply to the user and keeps the full history', async () => {
    const { ref } = await report(ama);
    await adminReply(fs, admin, ref, { text: 'Which browser are you using?', requestInfo: true });
    let mine = await getOwnReport(fs, ama, ref);
    expect(mine.report.status).toBe('awaiting_user');
    expect(mine.report.lastAdminReply?.text).toBe('Which browser are you using?');
    expect(mine.messages.at(-1)).toMatchObject({ author: 'admin', authorName: 'Atlas Support', kind: 'info_request' });
    expect(db.docs.get(`users/u1/notifications/${ref}-info_request`)).toMatchObject({ read: false, count: 1, link: `/support/${ref}` });

    mine = await addUserMessage(fs, ama, ref, { text: 'Safari on iPhone', attachments: [{ name: 'b.png', dataUrl: PNG }] });
    expect(mine.report.status).toBe('pending');
    await adminReply(fs, admin, ref, { text: 'Thanks, fixed in the next version.' });
    mine = await getOwnReport(fs, ama, ref);
    expect(mine.messages.map((m) => m.author)).toEqual(['admin', 'user', 'admin']);
    expect(mine.messages[1].attachments).toHaveLength(1);
    expect(db.docs.get(`adminNotifications/${ref}-user_message`)).toMatchObject({ count: 1 });
  });

  it('collapses repeated events into one unread notification instead of duplicates', async () => {
    const { ref } = await report(ama);
    await adminReply(fs, admin, ref, { text: 'one' });
    await adminReply(fs, admin, ref, { text: 'two' });
    expect(db.under('users/u1/notifications/')).toHaveLength(1);
    expect(db.docs.get(`users/u1/notifications/${ref}-reply`)).toMatchObject({ count: 2, read: false });
    // after the user reads it, the next reply starts a fresh count
    db.docs.set(`users/u1/notifications/${ref}-reply`, { ...db.docs.get(`users/u1/notifications/${ref}-reply`)!, read: true });
    await adminReply(fs, admin, ref, { text: 'three' });
    expect(db.docs.get(`users/u1/notifications/${ref}-reply`)).toMatchObject({ count: 1, read: false });
  });

  it('records status changes in the thread, notifies the user, and lets them confirm or reopen', async () => {
    const { ref } = await report(ama);
    await expect(confirmResolved(fs, ama, ref)).rejects.toMatchObject({ code: 'not_resolved' });
    await expect(reopenOwn(fs, ama, ref)).rejects.toMatchObject({ code: 'not_closed' });
    await adminSetStatus(fs, admin, ref, 'resolved');
    expect(db.docs.get(`users/u1/notifications/${ref}-resolved`)).toBeTruthy();
    let mine = await getOwnReport(fs, ama, ref);
    expect(mine.messages.at(-1)).toMatchObject({ author: 'system', kind: 'status', text: 'Status changed to Resolved.' });
    mine = await reopenOwn(fs, ama, ref);
    expect(mine.report.status).toBe('pending');
    await adminSetStatus(fs, admin, ref, 'resolved');
    mine = await confirmResolved(fs, ama, ref);
    expect(mine.report.status).toBe('closed');
    expect(mine.report.userConfirmedAt).toBeTypeOf('number');
    await expect(addUserMessage(fs, ama, ref, { text: 'more' })).rejects.toMatchObject({ code: 'closed' });
  });
});

describe('administrator tools', () => {
  it('computes statistics from real records only', async () => {
    expect((await adminList(fs)).stats.total).toBe(0);
    const a = await report(ama);
    await report(kojo, { category: 'feature_request', title: 'Dark mode schedule' });
    await adminSetStatus(fs, admin, a.ref, 'under_review');
    const { stats, reports } = await adminList(fs);
    expect(stats).toMatchObject({ total: 2, new: 1, underReview: 1, featureRequests: 1 });
    expect(reports[0]).toHaveProperty('userEmail');
  });

  it('assigns only to administrators, sets priority with a high-priority alert, keeps notes internal and audits everything', async () => {
    const { ref } = await report(ama);
    await expect(adminAssign(fs, admin, ref, 'random@example.com', ['owner@example.com'])).rejects.toMatchObject({ code: 'not_admin' });
    await adminAssign(fs, admin, ref, 'owner@example.com', ['owner@example.com']);
    await adminSetPriority(fs, admin, ref, 'critical');
    expect(db.docs.get(`adminNotifications/${ref}-high_priority`)).toBeTruthy();
    await adminAddNote(fs, admin, ref, 'Check the logs');
    const d = await adminDetail(fs, ref);
    expect(d.report).toMatchObject({ assignedTo: 'owner@example.com', priority: 'critical' });
    expect(d.notes.map((x) => x.text)).toEqual(['Check the logs']);
    expect(d.activity.map((x) => x.type)).toEqual(expect.arrayContaining(['created', 'assigned', 'priority', 'note']));
    const actions = [...db.docs.entries()].filter(([p]) => p.startsWith('adminLogs/')).map(([, v]) => v.action);
    expect(actions).toEqual(expect.arrayContaining(['support_assigned', 'support_priority_changed', 'support_note_added']));
  });

  it('deletes spam only with the typed reference, removing every related record', async () => {
    const { ref } = await report(ama, { attachments: [{ name: 's.png', dataUrl: PNG }] });
    await adminReply(fs, admin, ref, { text: 'hello' });
    await adminAddNote(fs, admin, ref, 'spam');
    await expect(adminDelete(fs, admin, ref, 'ATL-0000-XXXXX')).rejects.toMatchObject({ code: 'confirm_mismatch' });
    await adminDelete(fs, admin, ref, ref.toLowerCase());
    expect(db.under(`supportReports/${ref}`)).toEqual([]);
    expect(db.under('users/u1/notifications/')).toEqual([]);
    expect(db.under('adminNotifications/')).toEqual([]);
    expect(db.under('supportSubmissions/')).toEqual([]);
    expect([...db.docs.values()].some((v) => v.action === 'support_deleted')).toBe(true);
  });

  it('removes all reports of a permanently deleted account', async () => {
    await report(ama);
    await report(ama);
    const keep = await report(kojo);
    expect(await deleteReportsOf(fs, 'u1')).toBe(2);
    expect((await adminList(fs)).reports.map((r) => r.ref)).toEqual([keep.ref]);
  });

  it('marks admin notifications read per administrator', async () => {
    const { ref } = await report(ama);
    await markAdminNotificationsRead(fs, admin, [`${ref}-new_report`, '../../users/x']);
    expect(db.docs.get(`adminNotifications/${ref}-new_report`)!.readBy).toEqual(['a1']);
  });
});

describe('help centre', () => {
  it('ships an article for every required topic', () => {
    const ids = HELP_ARTICLES.map((a) => a.id);
    for (const id of ['getting-started', 'chat', 'models', 'web-search', 'documents', 'image-generation', 'memory', 'account', 'password-recovery', 'privacy-security', 'reporting-problems']) {
      expect(ids).toContain(id);
    }
  });
  it('says plainly that image generation is not available', () => {
    expect(HELP_ARTICLES.find((a) => a.id === 'image-generation')!.body).toMatch(/does not currently generate/);
  });
  it('merges administrator overrides, hides removed articles and adds custom ones', () => {
    const merged = mergeArticles([
      { id: 'chat', title: 'Chat (edited)', category: 'Using Atlas AI', summary: '', body: 'x' },
      { id: 'models', hidden: true } as never,
      { id: 'billing', title: 'Billing', category: 'Account', summary: '', body: 'No billing yet.' },
    ]);
    expect(merged.find((a) => a.id === 'chat')!.title).toBe('Chat (edited)');
    expect(merged.some((a) => a.id === 'models')).toBe(false);
    expect(merged.find((a) => a.id === 'billing')!.custom).toBe(true);
  });
  it('searches titles, keywords and text', () => {
    expect(searchArticles(HELP_ARTICLES, 'forgot password')[0].id).toBe('password-recovery');
    expect(searchArticles(HELP_ARTICLES, 'pdf')[0].id).toBe('documents');
    expect(searchArticles(HELP_ARTICLES, 'zzzz')).toEqual([]);
  });
});
