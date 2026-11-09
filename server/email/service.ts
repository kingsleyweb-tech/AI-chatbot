/**
 * The one entry point for sending app email.
 *
 * sendEmail() never throws: an email that cannot be sent is logged (admin
 * dashboard) and reported in the result, so a failed alert never breaks the
 * sign-in, reset or verification that triggered it.
 *
 * Guards, in order:
 * 1. provider configured
 * 2. the person's email preferences (only for optional categories)
 * 3. de-duplication by key (e.g. one login alert per sign-in session)
 * 4. per-recipient limit for notifications (codes have their own limits)
 * 5. app-wide daily cap (protects the provider's free quota)
 */
import { createHash } from 'node:crypto';
import type { Firestore } from '../firestore.js';
import { emailHash, logEmail, maskEmail } from './log.js';
import { EmailError, type EmailProvider } from './provider.js';
import { render, type EmailType, type TemplateData } from './templates.js';

/** critical emails cannot be turned off; the others follow users/{uid}.emailPrefs */
export type EmailCategory =
  'critical' | 'newLogin' | 'suspicious' | 'security' | 'announcements' | 'support';

/**
 * Notification preferences (users/{uid}.emailPrefs). `supportSms` is the
 * text-message switch for support updates; it lives here so every
 * notification preference is in one place.
 */
export const EMAIL_PREF_KEYS = [
  'newLogin',
  'suspicious',
  'security',
  'announcements',
  'support',
  'supportSms',
] as const;
export type EmailPrefKey = (typeof EMAIL_PREF_KEYS)[number];
export type EmailPrefs = Record<EmailPrefKey, boolean>;
/** Everything on unless the person turned it off. */
export const DEFAULT_EMAIL_PREFS: EmailPrefs = {
  newLogin: true,
  suspicious: true,
  security: true,
  announcements: true,
  support: true,
  supportSms: true,
};

export function prefsFrom(stored: unknown): EmailPrefs {
  const s = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  return Object.fromEntries(EMAIL_PREF_KEYS.map((k) => [k, s[k] !== false])) as EmailPrefs;
}

export interface EmailDeps {
  db: Firestore;
  provider: EmailProvider | null;
  /** public app address for links and the logo */
  baseUrl: string;
  dailyCap: number;
  now?: () => number;
}

export interface SendRequest {
  type: EmailType;
  category: EmailCategory;
  to: string;
  uid?: string | null;
  data?: TemplateData;
  /** skip when an email with this key was sent within `dedupeMs` */
  dedupeKey?: string;
  dedupeMs?: number;
}

export type SendOutcome =
  | { sent: true; status: 'accepted'; messageId: string | null; logId: string }
  | {
      sent: false;
      status:
        | 'unconfigured'
        | 'opted_out'
        | 'duplicate'
        | 'rate_limited'
        | 'daily_cap'
        | 'reserved'
        | 'invalid'
        | 'failed';
      error?: string;
      logId?: string;
    };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** notifications to one address per hour (codes are limited by their own flows) */
const NOTIFY_PER_HOUR = 6;
/**
 * Optional emails (alerts, support updates…) stop once this share of the daily
 * limit is used; the rest is kept for codes and other critical emails.
 */
export const OPTIONAL_SHARE = 0.8;
export const optionalLimit = (dailyCap: number) => Math.floor(dailyCap * OPTIONAL_SHARE);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const keyHash = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 40);

export async function sendEmail(deps: EmailDeps, req: SendRequest): Promise<SendOutcome> {
  const now = (deps.now ?? Date.now)();
  const to = req.to.trim().toLowerCase();
  if (!EMAIL_RE.test(to)) return { sent: false, status: 'invalid' };
  const base = {
    at: now,
    uid: req.uid ?? null,
    type: req.type,
    to: maskEmail(to),
    provider: deps.provider?.name ?? 'none',
    from: deps.provider?.sender ? maskEmail(deps.provider.sender) : null,
    messageId: null,
  };

  try {
    if (!deps.provider) {
      console.warn('[email] not configured; skipped', req.type);
      return { sent: false, status: 'unconfigured' };
    }

    if (req.category !== 'critical' && req.uid) {
      const profile = await deps.db.get<{ emailPrefs?: unknown }>(`users/${req.uid}`);
      if (!prefsFrom(profile?.data.emailPrefs)[req.category])
        return { sent: false, status: 'opted_out' };
    }

    if (req.dedupeKey) {
      const path = `emailDedupe/${keyHash(req.dedupeKey)}`;
      const seen = await deps.db.get<{ at?: number }>(path);
      if (seen && now - (seen.data.at ?? 0) < (req.dedupeMs ?? DAY))
        return { sent: false, status: 'duplicate' };
      // Claim the key first, so two parallel requests cannot both send.
      try {
        await deps.db.commit([
          {
            op: 'set',
            path,
            data: { at: now },
            precondition: seen?.updateTime ? { updateTime: seen.updateTime } : { exists: false },
          },
        ]);
      } catch {
        return { sent: false, status: 'duplicate' };
      }
    }

    if (req.category !== 'critical') {
      const path = `rateLimits/en_${emailHash(to)}`;
      const doc = await deps.db.get<{ sends?: number[] }>(path);
      const recent = (doc?.data.sends ?? []).filter((t) => now - t < HOUR);
      if (recent.length >= NOTIFY_PER_HOUR) return { sent: false, status: 'rate_limited' };
      await deps.db.set(path, { sends: [...recent, now] });
    }

    const day = new Date(now).toISOString().slice(0, 10);
    const stats = await deps.db.get<{ sent?: number }>(`emailStats/${day}`);
    const sentToday = stats?.data.sent ?? 0;
    if (req.category !== 'critical' && sentToday >= optionalLimit(deps.dailyCap)) {
      console.warn('[email] optional email held back near the daily limit', req.type);
      const logId = await logEmail(deps.db, {
        ...base,
        accepted: false,
        status: 'failed',
        error: 'Held back: the daily limit is nearly used and the rest is kept for codes',
        errorCode: 'reserved',
      });
      return { sent: false, status: 'reserved', logId };
    }
    if (sentToday >= deps.dailyCap) {
      console.warn('[email] daily cap reached; skipped', req.type);
      const logId = await logEmail(deps.db, {
        ...base,
        accepted: false,
        status: 'failed',
        error: 'App daily email limit reached',
        errorCode: 'daily_cap',
      });
      return { sent: false, status: 'daily_cap', logId };
    }

    const msg = render(req.type, { ...req.data, at: req.data?.at ?? now }, deps.baseUrl);
    try {
      const r = await deps.provider.send({
        to: { email: to, name: req.data?.name ?? null },
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        tags: [req.type],
      });
      await deps.db
        .commit([{ op: 'increment', path: `emailStats/${day}`, increments: { sent: 1 } }])
        .catch(() => undefined);
      const logId = await logEmail(deps.db, {
        ...base,
        messageId: r.messageId,
        accepted: true,
        status: 'accepted',
        attempts: r.attempts,
      });
      return { sent: true, status: 'accepted', messageId: r.messageId, logId };
    } catch (err) {
      const e =
        err instanceof EmailError
          ? err
          : new EmailError(
              'network',
              err instanceof Error ? err.message.slice(0, 200) : 'Email failed',
            );
      console.error('[email] send failed', req.type, e.code, e.httpStatus ?? '');
      const logId = await logEmail(deps.db, {
        ...base,
        accepted: false,
        status: 'failed',
        error: e.message,
        errorCode: e.code,
        httpStatus: e.httpStatus,
        attempts: e.attempts,
      });
      return { sent: false, status: 'failed', error: e.code, logId };
    }
  } catch (err) {
    // Firestore trouble: still never break the caller.
    console.error(
      '[email] skipped after an internal error',
      req.type,
      err instanceof Error ? err.message : err,
    );
    return { sent: false, status: 'failed', error: 'internal' };
  }
}
