/**
 * Transactional email providers.
 *
 * The app talks to an `EmailProvider`; Brevo (https://developers.brevo.com)
 * is the one implemented. Another provider only needs `send` (and,
 * optionally, `events`/`account`) and a case in `getEmailProvider`.
 *
 * Brevo, authenticated with the `api-key` header (server-only):
 * - POST /v3/smtp/email                    send; 201 { messageId } means *accepted*, not delivered
 * - GET  /v3/smtp/statistics/events        delivery events per messageId (delivered, bounces, blocked…)
 * - GET  /v3/account                       plan and remaining email credits
 *
 * Errors carry Brevo's status and short reason for the admin log, never the
 * key, the recipient's full address or the message.
 */
import { env } from '../env.js';

const BASE = 'https://api.brevo.com/v3';

export interface EmailMessage {
  to: { email: string; name?: string | null };
  subject: string;
  html: string;
  text: string;
  /** provider tags (e.g. the template type), for the provider's own statistics */
  tags?: string[];
}

export interface EmailSendResult {
  /** provider message id */
  messageId: string | null;
  /** attempts made (1 = first try succeeded) */
  attempts: number;
}

/** One delivery event reported by the provider. */
export interface EmailEvent {
  /** delivered | deferred | softBounces | hardBounces | blocked | invalid | error | spam | opened | clicks | requests | unsubscribed */
  event: string;
  date: string | null;
  reason?: string | null;
}

export interface EmailAccount {
  plan: string | null;
  /** remaining email credits on the plan, when the provider reports them */
  credits: number | null;
}

export interface EmailProvider {
  name: string;
  /** sender address the provider sends from */
  sender?: string;
  send(message: EmailMessage): Promise<EmailSendResult>;
  events?(messageId: string): Promise<EmailEvent[] | null>;
  account?(): Promise<EmailAccount | null>;
}

export type EmailErrorCode =
  | 'unconfigured'
  | 'not_activated'
  | 'auth'
  | 'ip_blocked'
  | 'rejected'
  | 'rate_limited'
  | 'unavailable'
  | 'network';

export class EmailError extends Error {
  constructor(
    public code: EmailErrorCode,
    message: string,
    public httpStatus: number | null = null,
    public retryable = false,
    public attempts = 1,
  ) {
    super(message);
  }
}

/** Provider error text, trimmed and without anything that looks like a key. */
export function cleanReason(text: string | null | undefined): string {
  return (text ?? '')
    .replace(/xkeysib-[\w-]+|xsmtpsib-[\w-]+/g, '[key]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

export interface BrevoOptions {
  apiKey: string;
  sender: { email: string; name: string };
  /** test hooks */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** attempts for temporary failures (network, 429, 5xx); default 3 */
  maxAttempts?: number;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function brevoProvider(o: BrevoOptions): EmailProvider {
  const f = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? wait;
  const headers = {
    'api-key': o.apiKey,
    accept: 'application/json',
    'content-type': 'application/json',
  };

  async function request(
    path: string,
    init: { method: 'GET' | 'POST'; body?: unknown },
    timeoutMs = 15_000,
  ) {
    let res: Response;
    try {
      res = await f(`${BASE}${path}`, {
        method: init.method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new EmailError(
        'network',
        'Brevo could not be reached (network error or timeout).',
        null,
        true,
      );
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return body;
    const reason = cleanReason(
      typeof body.message === 'string' ? body.message : `HTTP ${res.status}`,
    );
    if (res.status === 401 && /ip address/i.test(reason))
      throw new EmailError('ip_blocked', reason, 401);
    if (/not yet activated|account is not activated/i.test(reason))
      throw new EmailError('not_activated', reason, res.status);
    if (res.status === 401 || res.status === 403)
      throw new EmailError('auth', reason || 'Brevo refused the API key.', res.status);
    if (res.status === 429)
      throw new EmailError('rate_limited', reason || 'Brevo rate limit reached.', 429, true);
    if (res.status >= 500)
      throw new EmailError(
        'unavailable',
        reason || 'Brevo is temporarily unavailable.',
        res.status,
        true,
      );
    throw new EmailError('rejected', reason || 'Brevo rejected the email.', res.status);
  }

  return {
    name: 'brevo',
    sender: o.sender.email,
    async send(m) {
      const body = {
        sender: o.sender,
        to: [{ email: m.to.email, ...(m.to.name ? { name: m.to.name.slice(0, 70) } : {}) }],
        subject: m.subject,
        htmlContent: m.html,
        textContent: m.text,
        ...(m.tags?.length ? { tags: m.tags } : {}),
      };
      const max = Math.max(1, o.maxAttempts ?? 3);
      for (let attempt = 1; ; attempt++) {
        try {
          const r = await request('/smtp/email', { method: 'POST', body });
          return {
            messageId: typeof r.messageId === 'string' ? r.messageId : null,
            attempts: attempt,
          };
        } catch (err) {
          const e =
            err instanceof EmailError
              ? err
              : new EmailError('network', 'Email send failed.', null, true);
          if (!e.retryable || attempt >= max) {
            e.attempts = attempt;
            throw e;
          }
          await sleep(attempt === 1 ? 500 : 1500);
        }
      }
    },
    async events(messageId) {
      const qs = new URLSearchParams({ messageId, limit: '50', sort: 'desc' });
      const r = await request(`/smtp/statistics/events?${qs}`, { method: 'GET' }, 10_000);
      const list = Array.isArray(r.events) ? (r.events as Record<string, unknown>[]) : [];
      return list.map((e) => ({
        event: String(e.event ?? ''),
        date: typeof e.date === 'string' ? e.date : null,
        reason: typeof e.reason === 'string' ? cleanReason(e.reason) : null,
      }));
    },
    async account() {
      const r = await request('/account', { method: 'GET' }, 10_000);
      const plans = Array.isArray(r.plan) ? (r.plan as Record<string, unknown>[]) : [];
      const p = plans.find((x) => x.creditsType === 'sendLimit') ?? plans[0];
      return {
        plan: typeof p?.type === 'string' ? p.type : null,
        credits: typeof p?.credits === 'number' ? p.credits : null,
      };
    },
  };
}

let override: EmailProvider | null | undefined;
/** test hook */
export function setEmailProvider(p: EmailProvider | null | undefined) {
  override = p;
}

/** The configured provider, or null when email is not set up (callers carry on without email). */
export function getEmailProvider(): EmailProvider | null {
  if (override !== undefined) return override;
  const e = env();
  if (e.emailProvider !== 'brevo' || !e.brevoKey || !e.emailFrom) return null;
  return brevoProvider({
    apiKey: e.brevoKey,
    sender: { email: e.emailFrom, name: e.emailFromName },
  });
}
