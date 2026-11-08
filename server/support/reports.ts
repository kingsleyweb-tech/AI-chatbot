/**
 * Support reports: users report problems, administrators answer them.
 *
 * Firestore layout (all written only by the server identity; see firestore.rules):
 *   supportReports/{ref}                  the report; ref is human readable, e.g. ATL-2611-7KQ3M
 *     messages/{id}                       conversation the user sees (user, admin and status messages)
 *     internal/{id}                       administrator notes, never shown to the user
 *     activity/{id}                       administrator timeline
 *     attachments/{id}                    compressed screenshots (JPEG data URLs)
 *   supportSubmissions/{uid_submissionId} de-duplicates double submissions
 *   users/{uid}/notifications/{ref-kind}  the user's notifications (one per report and kind)
 *   adminNotifications/{ref-kind}         notifications for every administrator
 *
 * Authorization is decided here, not in the browser: users only reach their
 * own reports and can only add messages, confirm a resolution or reopen;
 * everything else needs an administrator (checked by the caller from the
 * server-side access decision).
 */
import { randomBytes } from 'node:crypto';
import { eventId, recordAdminAction, type AdminAction } from '../account/events.js';
import type { FsDoc, Firestore, Write } from '../firestore.js';
import { HttpError } from '../http.js';
import {
  categoryLabel,
  priorityLabel,
  statusLabel,
  SUPPORT_LIMITS,
  type NotificationKind,
  type SupportActivityView,
  type SupportAttachmentRef,
  type SupportCategory,
  type SupportMessageView,
  type SupportNoteView,
  type SupportPriority,
  type SupportReportAdminView,
  type SupportReportView,
  type SupportStats,
  type SupportStatus,
} from '../shared/support.js';

export interface Person {
  uid: string;
  email: string | null;
  name: string;
}

export interface ReportDoc {
  ref: string;
  uid: string;
  userName: string;
  userEmail: string;
  title: string;
  category: SupportCategory;
  description: string;
  status: SupportStatus;
  priority: SupportPriority;
  assignedTo: string | null;
  attachments: SupportAttachmentRef[];
  createdAt: number;
  updatedAt: number;
  lastAdminReply: { text: string; at: number } | null;
  lastMessageBy: 'user' | 'admin' | null;
  messageCount: number;
  userConfirmedAt: number | null;
  submissionId: string;
}

interface MessageDoc {
  author: 'user' | 'admin' | 'system';
  authorUid: string | null;
  kind: SupportMessageView['kind'];
  text: string;
  attachments: SupportAttachmentRef[];
  at: number;
}

export interface NewAttachment {
  name: string;
  dataUrl: string;
}

const REF_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // no 0/O, 1/I/L
const DATA_URL = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;
export const SUPPORT_NAME = 'Atlas Support';

const reportPath = (ref: string) => `supportReports/${ref}`;
export const REF_PATTERN = /^ATL-\d{4}-[2-9A-HJKMNP-Z]{5}$/;

export function newRef(now = Date.now()): string {
  const d = new Date(now);
  const yymm = String(d.getUTCFullYear() % 100).padStart(2, '0') + String(d.getUTCMonth() + 1).padStart(2, '0');
  const bytes = randomBytes(5);
  let tail = '';
  for (const b of bytes) tail += REF_ALPHABET[b % REF_ALPHABET.length];
  return `ATL-${yymm}-${tail}`;
}

function clean(text: string, max: number) {
  // strip control characters except newlines and tabs; collapse runs of blank lines
  return text
    .replace(/[^\P{Cc}\n\t]/gu, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
    .slice(0, max);
}

/** Validate screenshots server-side: type, encoding and size. */
export function checkAttachments(list: NewAttachment[] | undefined): NewAttachment[] {
  const items = list ?? [];
  if (items.length > SUPPORT_LIMITS.attachments) throw new HttpError(400, 'too_many_files', `Attach at most ${SUPPORT_LIMITS.attachments} images.`);
  return items.map((a) => {
    if (a.dataUrl.length > SUPPORT_LIMITS.attachmentChars) throw new HttpError(413, 'file_too_large', `${a.name} is too large. Try a smaller screenshot.`);
    if (!DATA_URL.test(a.dataUrl)) throw new HttpError(400, 'file_type', `${a.name} is not a supported image (PNG, JPEG or WebP).`);
    return { name: clean(a.name, 120) || 'screenshot.jpg', dataUrl: a.dataUrl };
  });
}

function attachmentWrites(ref: string, items: NewAttachment[], uploadedBy: string, now: number): { refs: SupportAttachmentRef[]; writes: Write[] } {
  const refs: SupportAttachmentRef[] = [];
  const writes: Write[] = [];
  for (const a of items) {
    const id = eventId(now) + refs.length;
    const mime = a.dataUrl.slice(5, a.dataUrl.indexOf(';'));
    const size = Math.floor(((a.dataUrl.length - a.dataUrl.indexOf(',') - 1) * 3) / 4);
    refs.push({ id, name: a.name, mime, size });
    writes.push({ op: 'set', path: `${reportPath(ref)}/attachments/${id}`, data: { name: a.name, mime, size, dataUrl: a.dataUrl, uploadedBy, at: now } });
  }
  return { refs, writes };
}

// ---------- notifications ----------

/**
 * One notification per report and kind: a repeat event (a second reply)
 * updates the same document, marks it unread and bumps its count, so
 * notifications never pile up as duplicates.
 */
async function notify(db: Firestore, target: { uid: string } | 'admins', n: { kind: NotificationKind; ref: string; title: string; body: string; link: string }, now: number) {
  const path = target === 'admins' ? `adminNotifications/${n.ref}-${n.kind}` : `users/${target.uid}/notifications/${n.ref}-${n.kind}`;
  try {
    const prev = await db.get<{ count?: number; read?: boolean; readBy?: string[] }>(path);
    const unreadBefore = prev && (target === 'admins' ? !(prev.data.readBy ?? []).length : prev.data.read === false);
    await db.set(path, {
      kind: n.kind,
      ref: n.ref,
      title: n.title,
      body: n.body.slice(0, 240),
      link: n.link,
      count: unreadBefore ? (prev.data.count ?? 1) + 1 : 1,
      at: now,
      ...(target === 'admins' ? { readBy: [] } : { read: false }),
    });
  } catch (err) {
    // A failed notification must never fail the action that caused it.
    console.warn('[support] notification not delivered', n.kind, err instanceof Error ? err.message : err);
  }
}

// ---------- views ----------

function userView(r: ReportDoc): SupportReportView {
  return {
    ref: r.ref,
    title: r.title,
    category: r.category,
    description: r.description,
    status: r.status,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    attachments: r.attachments ?? [],
    lastAdminReply: r.lastAdminReply ?? null,
    userConfirmedAt: r.userConfirmedAt ?? null,
  };
}

function adminView(r: ReportDoc): SupportReportAdminView {
  return {
    ...userView(r),
    uid: r.uid,
    userName: r.userName,
    userEmail: r.userEmail,
    priority: r.priority ?? 'medium',
    assignedTo: r.assignedTo ?? null,
    messageCount: r.messageCount ?? 0,
    lastMessageBy: r.lastMessageBy ?? null,
  };
}

function messageView(d: FsDoc<MessageDoc>): SupportMessageView {
  return {
    id: d.id,
    author: d.data.author,
    authorName: d.data.author === 'admin' ? SUPPORT_NAME : d.data.author === 'system' ? 'Atlas' : 'You',
    kind: d.data.kind ?? 'message',
    text: d.data.text,
    attachments: d.data.attachments ?? [],
    at: d.data.at,
  };
}

export function supportStats(rows: Pick<ReportDoc, 'status' | 'category'>[]): SupportStats {
  const by = (s: SupportStatus) => rows.filter((r) => r.status === s).length;
  return {
    total: rows.length,
    new: by('new'),
    pending: by('pending'),
    underReview: by('under_review'),
    awaitingUser: by('awaiting_user'),
    resolved: by('resolved'),
    closed: by('closed'),
    featureRequests: rows.filter((r) => r.category === 'feature_request').length,
  };
}

// ---------- loading with authorization ----------

async function loadReport(db: Firestore, ref: string): Promise<ReportDoc> {
  if (!REF_PATTERN.test(ref)) throw new HttpError(404, 'not_found', 'Report not found.');
  const doc = await db.get<ReportDoc>(reportPath(ref));
  if (!doc) throw new HttpError(404, 'not_found', 'Report not found.');
  return doc.data;
}

/** The owner's report; another user's report looks exactly like a missing one. */
async function ownReport(db: Firestore, user: Person, ref: string): Promise<ReportDoc> {
  const r = await loadReport(db, ref);
  if (r.uid !== user.uid) throw new HttpError(404, 'not_found', 'Report not found.');
  return r;
}

async function thread(db: Firestore, ref: string) {
  const docs = await db.list<MessageDoc>(`${reportPath(ref)}/messages`, { orderBy: 'at', limit: 500 });
  return docs.map(messageView);
}

// ---------- user actions ----------

export async function createReport(
  db: Firestore,
  user: Person,
  input: { title: string; category: SupportCategory; description: string; attachments?: NewAttachment[]; submissionId: string },
  now = Date.now(),
): Promise<{ ref: string; duplicate: boolean }> {
  const title = clean(input.title, SUPPORT_LIMITS.title);
  const description = clean(input.description, SUPPORT_LIMITS.description);
  if (title.length < 3) throw new HttpError(400, 'title_required', 'Add a short title (at least 3 characters).');
  if (description.length < 10) throw new HttpError(400, 'description_required', 'Describe what happened (at least 10 characters).');
  if (!user.email) throw new HttpError(400, 'email_required', 'Your account needs an email address to report an issue.');
  const files = checkAttachments(input.attachments);

  // The same form submitted twice (double tap, retry after a timeout) returns the first report.
  const subPath = `supportSubmissions/${user.uid}_${input.submissionId}`;
  const existing = await db.get<{ ref: string }>(subPath);
  if (existing) return { ref: existing.data.ref, duplicate: true };

  const mine = await db.list<Pick<ReportDoc, 'createdAt'>>('supportReports', { where: [['uid', 'EQUAL', user.uid]], limit: 500 });
  if (mine.filter((r) => r.data.createdAt > now - 86_400_000).length >= SUPPORT_LIMITS.reportsPerDay) {
    throw new HttpError(429, 'too_many_reports', 'You have sent a lot of reports today. Please add details to an existing report or try again tomorrow.');
  }

  for (let attempt = 0; attempt < 4; attempt++) {
    const ref = newRef(now);
    const { refs, writes } = attachmentWrites(ref, files, user.uid, now);
    const report: ReportDoc = {
      ref,
      uid: user.uid,
      userName: user.name,
      userEmail: user.email,
      title,
      category: input.category,
      description,
      status: 'new',
      priority: 'medium',
      assignedTo: null,
      attachments: refs,
      createdAt: now,
      updatedAt: now,
      lastAdminReply: null,
      lastMessageBy: 'user',
      messageCount: 0,
      userConfirmedAt: null,
      submissionId: input.submissionId,
    };
    try {
      await db.commit([
        // fails if this reference already exists (retry with another) or this submission was already stored
        { op: 'set', path: reportPath(ref), data: report, precondition: { exists: false } },
        { op: 'set', path: subPath, data: { ref, uid: user.uid, at: now }, precondition: { exists: false } },
        { op: 'set', path: `${reportPath(ref)}/activity/${eventId(now)}`, data: { type: 'created', detail: categoryLabel(input.category), by: user.uid, byEmail: user.email, at: now } },
        ...writes,
      ]);
    } catch (err) {
      if ((err as { status?: number }).status !== 409) throw err;
      const raced = await db.get<{ ref: string }>(subPath);
      if (raced) return { ref: raced.data.ref, duplicate: true };
      continue; // reference collision: try a new one
    }
    await notify(db, 'admins', { kind: 'new_report', ref, title: `New report ${ref}`, body: `${user.name}: ${title}`, link: `/admin/support/${ref}` }, now);
    return { ref, duplicate: false };
  }
  throw new HttpError(503, 'busy', 'Could not create the report. Please try again.');
}

export async function listOwnReports(db: Firestore, user: Person): Promise<SupportReportView[]> {
  const docs = await db.list<ReportDoc>('supportReports', { where: [['uid', 'EQUAL', user.uid]], limit: 500 });
  return docs.map((d) => userView(d.data)).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getOwnReport(db: Firestore, user: Person, ref: string) {
  const r = await ownReport(db, user, ref);
  return { report: userView(r), messages: await thread(db, ref) };
}

export async function addUserMessage(db: Firestore, user: Person, ref: string, input: { text: string; attachments?: NewAttachment[] }, now = Date.now()) {
  const r = await ownReport(db, user, ref);
  if (r.status === 'closed') throw new HttpError(400, 'closed', 'This report is closed. Reopen it to add more information.');
  const text = clean(input.text, SUPPORT_LIMITS.message);
  const files = checkAttachments(input.attachments);
  if (!text && !files.length) throw new HttpError(400, 'empty', 'Write a message or attach a screenshot.');
  const { refs, writes } = attachmentWrites(ref, files, user.uid, now);
  // A reply to "awaiting your response" goes back to the support queue.
  const status: SupportStatus = r.status === 'awaiting_user' ? 'pending' : r.status;
  await db.commit([
    ...writes,
    { op: 'set', path: `${reportPath(ref)}/messages/${eventId(now)}`, data: { author: 'user', authorUid: user.uid, kind: 'message', text, attachments: refs, at: now } satisfies MessageDoc },
    { op: 'set', path: reportPath(ref), merge: true, data: { status, updatedAt: now, lastMessageBy: 'user', messageCount: (r.messageCount ?? 0) + 1 } },
  ]);
  await notify(db, 'admins', { kind: 'user_message', ref, title: `New message on ${ref}`, body: `${r.userName}: ${text || 'Sent a screenshot'}`, link: `/admin/support/${ref}` }, now);
  return getOwnReport(db, user, ref);
}

async function setStatusInternal(db: Firestore, r: ReportDoc, status: SupportStatus, by: { uid: string; email: string | null; role: 'user' | 'admin' }, now: number, extra: Partial<ReportDoc> = {}, note?: string) {
  const text = by.role === 'user' ? (status === 'closed' ? 'You confirmed the issue is resolved.' : 'You reopened this report.') : `Status changed to ${statusLabel(status)}.`;
  await db.commit([
    { op: 'set', path: `${reportPath(r.ref)}/messages/${eventId(now)}`, data: { author: 'system', authorUid: null, kind: 'status', text: note ? `${text} ${note}` : text, attachments: [], at: now } satisfies MessageDoc },
    { op: 'set', path: `${reportPath(r.ref)}/activity/${eventId(now)}s`, data: { type: 'status', detail: `${statusLabel(r.status, true)} → ${statusLabel(status, true)}`, by: by.uid, byEmail: by.email, at: now } },
    { op: 'set', path: reportPath(r.ref), merge: true, data: { status, updatedAt: now, ...extra } },
  ]);
}

/** The user confirms an administrator's resolution; the report is then closed. */
export async function confirmResolved(db: Firestore, user: Person, ref: string, now = Date.now()) {
  const r = await ownReport(db, user, ref);
  if (r.status !== 'resolved') throw new HttpError(400, 'not_resolved', 'Only a report marked resolved by Atlas Support can be confirmed.');
  await setStatusInternal(db, r, 'closed', { uid: user.uid, email: user.email, role: 'user' }, now, { userConfirmedAt: now });
  return getOwnReport(db, user, ref);
}

export async function reopenOwn(db: Firestore, user: Person, ref: string, now = Date.now()) {
  const r = await ownReport(db, user, ref);
  if (r.status !== 'resolved' && r.status !== 'closed') throw new HttpError(400, 'not_closed', 'This report is still open.');
  await setStatusInternal(db, r, 'pending', { uid: user.uid, email: user.email, role: 'user' }, now, { userConfirmedAt: null });
  await notify(db, 'admins', { kind: 'user_message', ref, title: `${ref} was reopened`, body: `${r.userName} reopened “${r.title}”`, link: `/admin/support/${ref}` }, now);
  return getOwnReport(db, user, ref);
}

/** Screenshot bytes, for the report owner or an administrator only. */
export async function getAttachment(db: Firestore, caller: Person, isAdmin: boolean, ref: string, id: string) {
  const r = await loadReport(db, ref);
  if (!isAdmin && r.uid !== caller.uid) throw new HttpError(404, 'not_found', 'Attachment not found.');
  if (!/^[0-9_a-f]+$/.test(id)) throw new HttpError(404, 'not_found', 'Attachment not found.');
  const a = await db.get<{ name: string; mime: string; dataUrl: string }>(`${reportPath(ref)}/attachments/${id}`);
  if (!a) throw new HttpError(404, 'not_found', 'Attachment not found.');
  return a.data;
}

// ---------- administrator actions ----------

export interface AdminActor {
  uid: string;
  email: string | null;
}

async function audit(db: Firestore, actor: AdminActor, r: ReportDoc, action: AdminAction, detail: string) {
  await recordAdminAction(db, { action, adminUid: actor.uid, adminEmail: actor.email, targetUid: r.uid, targetEmail: r.userEmail, detail: `${r.ref}: ${detail}` }).catch((err) =>
    console.warn('[support] audit entry not recorded', err instanceof Error ? err.message : err),
  );
}

export async function adminList(db: Firestore) {
  const docs = await db.list<ReportDoc>('supportReports', { orderBy: 'updatedAt', direction: 'DESCENDING', limit: 2000 });
  const rows = docs.map((d) => adminView(d.data));
  return { reports: rows, stats: supportStats(rows) };
}

export async function adminDetail(db: Firestore, ref: string) {
  const r = await loadReport(db, ref);
  const [messages, notes, activity] = await Promise.all([
    thread(db, ref),
    db.list<{ text: string; adminEmail: string | null; at: number }>(`${reportPath(ref)}/internal`, { orderBy: 'at', limit: 500 }),
    db.list<{ type: string; detail: string | null; byEmail: string | null; at: number }>(`${reportPath(ref)}/activity`, { orderBy: 'at', limit: 500 }),
  ]);
  return {
    report: adminView(r),
    messages,
    notes: notes.map((n): SupportNoteView => ({ id: n.id, text: n.data.text, adminEmail: n.data.adminEmail ?? null, at: n.data.at })),
    activity: activity.map((a): SupportActivityView => ({ id: a.id, type: a.data.type, detail: a.data.detail ?? null, byEmail: a.data.byEmail ?? null, at: a.data.at })),
  };
}

export async function adminReply(db: Firestore, actor: AdminActor, ref: string, input: { text: string; attachments?: NewAttachment[]; requestInfo?: boolean }, now = Date.now()) {
  const r = await loadReport(db, ref);
  const text = clean(input.text, SUPPORT_LIMITS.message);
  const files = checkAttachments(input.attachments);
  if (!text && !files.length) throw new HttpError(400, 'empty', 'Write a reply.');
  const { refs, writes } = attachmentWrites(ref, files, actor.uid, now);
  // Asking for more information waits for the user; any other reply moves a new report into review.
  const status: SupportStatus = input.requestInfo ? 'awaiting_user' : r.status === 'new' || r.status === 'pending' ? 'under_review' : r.status;
  await db.commit([
    ...writes,
    {
      op: 'set',
      path: `${reportPath(ref)}/messages/${eventId(now)}`,
      data: { author: 'admin', authorUid: actor.uid, kind: input.requestInfo ? 'info_request' : 'message', text, attachments: refs, at: now } satisfies MessageDoc,
    },
    { op: 'set', path: `${reportPath(ref)}/activity/${eventId(now)}`, data: { type: input.requestInfo ? 'info_requested' : 'reply', detail: null, by: actor.uid, byEmail: actor.email, at: now } },
    {
      op: 'set',
      path: reportPath(ref),
      merge: true,
      data: { status, updatedAt: now, lastMessageBy: 'admin', lastAdminReply: { text: text.slice(0, 300) || 'Sent a screenshot', at: now }, messageCount: (r.messageCount ?? 0) + 1 },
    },
  ]);
  await notify(
    db,
    { uid: r.uid },
    input.requestInfo
      ? { kind: 'info_request', ref, title: 'More information needed', body: `${r.title}: ${text}`, link: `/support/${ref}` }
      : { kind: 'reply', ref, title: 'Atlas Support replied', body: `${r.title}: ${text || 'Sent a screenshot'}`, link: `/support/${ref}` },
    now,
  );
  await audit(db, actor, r, 'support_replied', input.requestInfo ? 'requested more information' : 'replied');
  return adminDetail(db, ref);
}

export async function adminSetStatus(db: Firestore, actor: AdminActor, ref: string, status: SupportStatus, now = Date.now()) {
  const r = await loadReport(db, ref);
  if (r.status === status) return adminDetail(db, ref);
  await setStatusInternal(db, r, status, { ...actor, role: 'admin' }, now, status === 'resolved' || status === 'closed' ? {} : { userConfirmedAt: null });
  await notify(
    db,
    { uid: r.uid },
    status === 'resolved'
      ? { kind: 'resolved', ref, title: 'Your report was resolved', body: `${r.title}. Please confirm, or reopen it if the problem continues.`, link: `/support/${ref}` }
      : { kind: 'status', ref, title: `Report ${statusLabel(status).toLowerCase()}`, body: `${r.title}: status changed to ${statusLabel(status)}.`, link: `/support/${ref}` },
    now,
  );
  await audit(db, actor, r, 'support_status_changed', `${r.status} → ${status}`);
  return adminDetail(db, ref);
}

export async function adminSetPriority(db: Firestore, actor: AdminActor, ref: string, priority: SupportPriority, now = Date.now()) {
  const r = await loadReport(db, ref);
  if ((r.priority ?? 'medium') === priority) return adminDetail(db, ref);
  await db.commit([
    { op: 'set', path: `${reportPath(ref)}/activity/${eventId(now)}`, data: { type: 'priority', detail: `${priorityLabel(r.priority ?? 'medium')} → ${priorityLabel(priority)}`, by: actor.uid, byEmail: actor.email, at: now } },
    { op: 'set', path: reportPath(ref), merge: true, data: { priority, updatedAt: now } },
  ]);
  if ((priority === 'high' || priority === 'critical') && r.priority !== 'high' && r.priority !== 'critical') {
    await notify(db, 'admins', { kind: 'high_priority', ref, title: `${priorityLabel(priority)} priority: ${ref}`, body: r.title, link: `/admin/support/${ref}` }, now);
  }
  await audit(db, actor, r, 'support_priority_changed', `${r.priority ?? 'medium'} → ${priority}`);
  return adminDetail(db, ref);
}

export async function adminAssign(db: Firestore, actor: AdminActor, ref: string, assignee: string | null, admins: string[], now = Date.now()) {
  const r = await loadReport(db, ref);
  const email = assignee?.trim().toLowerCase() || null;
  if (email && !admins.includes(email)) throw new HttpError(400, 'not_admin', 'Reports can only be assigned to an administrator.');
  if ((r.assignedTo ?? null) === email) return adminDetail(db, ref);
  await db.commit([
    { op: 'set', path: `${reportPath(ref)}/activity/${eventId(now)}`, data: { type: 'assigned', detail: email ? `Assigned to ${email}` : 'Unassigned', by: actor.uid, byEmail: actor.email, at: now } },
    { op: 'set', path: reportPath(ref), merge: true, data: { assignedTo: email, updatedAt: now } },
  ]);
  await audit(db, actor, r, 'support_assigned', email ?? 'unassigned');
  return adminDetail(db, ref);
}

export async function adminAddNote(db: Firestore, actor: AdminActor, ref: string, text: string, now = Date.now()) {
  const r = await loadReport(db, ref);
  const note = clean(text, SUPPORT_LIMITS.note);
  if (!note) throw new HttpError(400, 'empty', 'Write a note.');
  await db.commit([
    { op: 'set', path: `${reportPath(ref)}/internal/${eventId(now)}`, data: { text: note, adminUid: actor.uid, adminEmail: actor.email, at: now } },
    { op: 'set', path: `${reportPath(ref)}/activity/${eventId(now)}`, data: { type: 'note', detail: null, by: actor.uid, byEmail: actor.email, at: now } },
  ]);
  await audit(db, actor, r, 'support_note_added', 'internal note');
  return adminDetail(db, ref);
}

/** Permanently delete a report (spam or abuse). The caller must type the reference to confirm. */
export async function adminDelete(db: Firestore, actor: AdminActor, ref: string, confirmRef: string) {
  const r = await loadReport(db, ref);
  if (confirmRef.trim().toUpperCase() !== ref) throw new HttpError(400, 'confirm_mismatch', 'Type the report reference to confirm.');
  await deleteReportTree(db, r);
  await audit(db, actor, r, 'support_deleted', `deleted “${r.title.slice(0, 80)}”`);
  return { ok: true };
}

export async function deleteReportTree(db: Firestore, r: Pick<ReportDoc, 'ref' | 'uid' | 'submissionId'>) {
  const base = reportPath(r.ref);
  for (const sub of ['messages', 'internal', 'activity', 'attachments']) {
    for (let guard = 0; guard < 100; guard++) {
      const docs = await db.list(`${base}/${sub}`, { limit: 400 });
      if (!docs.length) break;
      await db.commit(docs.map((d) => ({ op: 'delete' as const, path: d.path })));
    }
  }
  const kinds: NotificationKind[] = ['reply', 'status', 'resolved', 'info_request'];
  const adminKinds: NotificationKind[] = ['new_report', 'user_message', 'high_priority'];
  await db.commit([
    ...kinds.map((k) => ({ op: 'delete' as const, path: `users/${r.uid}/notifications/${r.ref}-${k}` })),
    ...adminKinds.map((k) => ({ op: 'delete' as const, path: `adminNotifications/${r.ref}-${k}` })),
    ...(r.submissionId ? [{ op: 'delete' as const, path: `supportSubmissions/${r.uid}_${r.submissionId}` }] : []),
    { op: 'delete', path: base },
  ]);
}

/** Every report of an account, removed when the account is permanently deleted. */
export async function deleteReportsOf(db: Firestore, uid: string): Promise<number> {
  const docs = await db.list<ReportDoc>('supportReports', { where: [['uid', 'EQUAL', uid]], limit: 500 });
  for (const d of docs) await deleteReportTree(db, d.data);
  return docs.length;
}

/** Administrators mark an admin notification read for themselves. */
export async function markAdminNotificationsRead(db: Firestore, actor: AdminActor, ids: string[]) {
  for (const id of ids.slice(0, 50)) {
    if (!/^ATL-\d{4}-[2-9A-HJKMNP-Z]{5}-[a-z_]+$/.test(id)) continue;
    const path = `adminNotifications/${id}`;
    const n = await db.get<{ readBy?: string[] }>(path);
    if (!n || (n.data.readBy ?? []).includes(actor.uid)) continue;
    await db.set(path, { readBy: [...(n.data.readBy ?? []), actor.uid] }, true);
  }
}
