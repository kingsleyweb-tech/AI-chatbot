import { z } from 'zod';
import { requireAllowedUser, type AccessConfig } from '../server/access.js';
import { adminConfigured, adminDb } from '../server/admin.js';
import { env } from '../server/env.js';
import { handle, HttpError, json, readJson } from '../server/http.js';
import { CATEGORY_IDS, STATUS_IDS, SUPPORT_LIMITS, SUPPORT_PRIORITIES } from '../server/shared/support.js';
import { removeArticle, saveArticle } from '../server/support/help.js';
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
  confirmResolved,
  createReport,
  getAttachment,
  getOwnReport,
  listOwnReports,
  markAdminNotificationsRead,
  reopenOwn,
  type Person,
} from '../server/support/reports.js';

const ref = z.string().min(5).max(20);
const attachment = z.object({ name: z.string().max(200), dataUrl: z.string().max(SUPPORT_LIMITS.attachmentChars + 100) });
const attachments = z.array(attachment).max(SUPPORT_LIMITS.attachments).optional();

const userActions = [
  z.object({
    action: z.literal('create'),
    title: z.string().max(SUPPORT_LIMITS.title + 50),
    category: z.enum(CATEGORY_IDS),
    description: z.string().max(SUPPORT_LIMITS.description + 50),
    attachments,
    submissionId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  }),
  z.object({ action: z.literal('mine') }),
  z.object({ action: z.literal('get'), ref }),
  z.object({ action: z.literal('message'), ref, text: z.string().max(SUPPORT_LIMITS.message + 50), attachments }),
  z.object({ action: z.literal('confirm'), ref }),
  z.object({ action: z.literal('reopen'), ref }),
  z.object({ action: z.literal('attachment'), ref, id: z.string().max(40) }),
] as const;

const adminActions = [
  z.object({ action: z.literal('adminList') }),
  z.object({ action: z.literal('adminGet'), ref }),
  z.object({ action: z.literal('adminReply'), ref, text: z.string().max(SUPPORT_LIMITS.message + 50), attachments, requestInfo: z.boolean().optional() }),
  z.object({ action: z.literal('adminStatus'), ref, status: z.enum(STATUS_IDS) }),
  z.object({ action: z.literal('adminPriority'), ref, priority: z.enum(SUPPORT_PRIORITIES) }),
  z.object({ action: z.literal('adminAssign'), ref, assignee: z.string().max(320).nullable() }),
  z.object({ action: z.literal('adminNote'), ref, text: z.string().max(SUPPORT_LIMITS.note + 50) }),
  z.object({ action: z.literal('adminDelete'), ref, confirmRef: z.string().max(20) }),
  z.object({ action: z.literal('adminNotificationsRead'), ids: z.array(z.string().max(60)).max(50) }),
  z.object({
    action: z.literal('helpSave'),
    id: z.string().max(60),
    title: z.string().min(3).max(120),
    category: z.string().min(2).max(60),
    summary: z.string().max(240),
    body: z.string().min(10).max(20_000),
    keywords: z.array(z.string().max(40)).max(20).optional(),
  }),
  z.object({ action: z.literal('helpRemove'), id: z.string().max(60), mode: z.enum(['remove', 'restore']) }),
] as const;

const schema = z.discriminatedUnion('action', [...userActions, ...adminActions]);
const ADMIN_ONLY = new Set<string>(adminActions.map((a) => a.shape.action.value));

/**
 * Support reports and Help Centre management.
 * Every request is authenticated and checked on the server: users reach only
 * their own reports; administrator actions require the server-side admin
 * decision (bootstrap owner or config/access.adminEmails). All reads and
 * writes go through the server identity; clients cannot write these
 * collections at all (firestore.rules).
 */
export const POST = handle(async (request) => {
  const ctx = await requireAllowedUser(request);
  // 3 screenshots of up to ~950 KB each, plus text
  const parsed = schema.safeParse(await readJson(request, 3_200_000));
  if (!parsed.success) throw new HttpError(400, 'bad_request', 'Invalid request.');
  const b = parsed.data;
  if (ADMIN_ONLY.has(b.action) && !ctx.admin) throw new HttpError(403, 'not_admin', 'Administrator access is required.');
  if (!adminConfigured()) throw new HttpError(503, 'admin_unconfigured', 'Support needs FIREBASE_SERVICE_ACCOUNT on the server.');
  const db = await adminDb();

  const profile = (await db.get<{ displayName?: string }>(`users/${ctx.user.uid}`))?.data;
  const me: Person = {
    uid: ctx.user.uid,
    email: ctx.user.email,
    name: (profile?.displayName || ctx.user.name || ctx.user.email?.split('@')[0] || 'User').slice(0, 120),
  };
  const actor = { uid: me.uid, email: me.email };

  switch (b.action) {
    case 'create':
      return json(await createReport(db, me, b));
    case 'mine':
      return json({ reports: await listOwnReports(db, me) });
    case 'get':
      return json(await getOwnReport(db, me, b.ref));
    case 'message':
      return json(await addUserMessage(db, me, b.ref, b));
    case 'confirm':
      return json(await confirmResolved(db, me, b.ref));
    case 'reopen':
      return json(await reopenOwn(db, me, b.ref));
    case 'attachment':
      return json(await getAttachment(db, me, ctx.admin, b.ref, b.id));
    case 'adminList': {
      const access = (await db.get<AccessConfig>('config/access'))?.data;
      const admins = [...new Set([...env().adminEmails, ...(access?.adminEmails ?? []).map((e) => e.toLowerCase())])];
      return json({ ...(await adminList(db)), admins });
    }
    case 'adminGet':
      return json(await adminDetail(db, b.ref));
    case 'adminReply':
      return json(await adminReply(db, actor, b.ref, b));
    case 'adminStatus':
      return json(await adminSetStatus(db, actor, b.ref, b.status));
    case 'adminPriority':
      return json(await adminSetPriority(db, actor, b.ref, b.priority));
    case 'adminAssign': {
      const access = (await db.get<AccessConfig>('config/access'))?.data;
      const admins = [...env().adminEmails, ...(access?.adminEmails ?? []).map((e) => e.toLowerCase())];
      return json(await adminAssign(db, actor, b.ref, b.assignee, admins));
    }
    case 'adminNote':
      return json(await adminAddNote(db, actor, b.ref, b.text));
    case 'adminDelete':
      return json(await adminDelete(db, actor, b.ref, b.confirmRef));
    case 'adminNotificationsRead':
      await markAdminNotificationsRead(db, actor, b.ids);
      return json({ ok: true });
    case 'helpSave':
      await saveArticle(db, actor, b);
      return json({ ok: true });
    case 'helpRemove':
      await removeArticle(db, actor, b.id, b.mode);
      return json({ ok: true });
  }
});
