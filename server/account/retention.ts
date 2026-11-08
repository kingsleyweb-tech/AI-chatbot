/**
 * Retention of the records kept after an account is permanently deleted.
 *
 * purgeAccount removes everything under users/{uid} at once, but keeps two
 * kinds of record for accountability: the administrator log entries about the
 * account (adminLogs, which include its email address) and its access request
 * (accessRequests/{uid}). This job deletes both RETAIN_AFTER_PURGE_DAYS after
 * the purge. It runs daily with the purge job (vercel.json cron).
 *
 * The purge time comes from the account's `user_purged` log entry; its
 * document id starts with the time in milliseconds (eventId), which is also
 * how the entry itself is aged, so no extra index or field is needed.
 */
import type { Firestore } from '../firestore.js';
import { recordAdminAction } from './events.js';

export const RETAIN_AFTER_PURGE_DAYS = 30;
const DAY = 86_400_000;

/** Milliseconds encoded at the start of an eventId ("00001731024000000_ab12cd34"). */
export function eventTime(id: string): number | null {
  const ms = Number(id.split('_')[0]);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

export async function cleanupPurgedRecords(db: Firestore, now = Date.now()): Promise<{ accounts: number; removed: number }> {
  const cutoff = now - RETAIN_AFTER_PURGE_DAYS * DAY;
  const purgedLogs = await db.list<{ targetUid?: string }>('adminLogs', { where: [['action', 'EQUAL', 'user_purged']], limit: 200 });
  const due = new Set<string>();
  for (const l of purgedLogs) {
    const at = eventTime(l.id);
    if (at !== null && at <= cutoff && l.data.targetUid) due.add(l.data.targetUid);
  }
  let removed = 0;
  for (const uid of due) {
    // Never touch an account that exists again (for example restored from a backup).
    if (await db.get(`users/${uid}`)) continue;
    const request = await db.get(`accessRequests/${uid}`);
    if (request) {
      await db.delete(request.path);
      removed++;
    }
    const logs = await db.list('adminLogs', { where: [['targetUid', 'EQUAL', uid]], limit: 500 });
    for (const l of logs) await db.delete(l.path);
    removed += logs.length;
  }
  if (due.size) {
    await recordAdminAction(
      db,
      {
        action: 'retention_cleanup',
        adminUid: 'system',
        adminEmail: null,
        targetUid: 'retention',
        targetEmail: null,
        detail: `${removed} records of ${due.size} account(s) deleted ${RETAIN_AFTER_PURGE_DAYS} days after permanent deletion`,
      },
      now,
    );
  }
  return { accounts: due.size, removed };
}
