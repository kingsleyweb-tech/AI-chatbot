/**
 * Vynfy SMS integration (https://sms.vynfy.com/api/v1/docs).
 *
 * Two services, both authenticated with the X-API-Key header:
 * - OTP service: POST /otp/generate (Vynfy creates the code, texts it and
 *   keeps it; the code is never returned to us), POST /otp/verify (max 3
 *   attempts, one pending code per number), GET /otp/balance. Charged from
 *   the separate OTP balance. Vynfy publishes no delivery receipts for it.
 * - Bulk SMS: POST /api/v1/send -> task_id, GET /api/v1/status/<task_id>
 *   for per-recipient delivery (queued / sent / delivered / not_delivered /
 *   failed / expired), GET /api/v1/check/balance. Used for password-reset
 *   texts and as the fallback for verification codes.
 *
 * Credentials stay on the server. Logs carry status codes and Vynfy's error
 * text only, never the key, the message body or a code.
 */
import { env } from '../env.js';
import { HttpError } from '../http.js';

const BASE = 'https://sms.vynfy.com';

/** Provider failure with Vynfy's own reason kept for the admin SMS log. */
export class SmsError extends HttpError {
  constructor(
    status: number,
    code: string,
    message: string,
    public provider: { httpStatus?: number; code?: string; message?: string },
    details?: Record<string, unknown>,
  ) {
    super(status, code, message, details);
  }
}

export interface SendResult {
  /** Vynfy task id */
  id?: string;
  /** Vynfy's status for the request, e.g. "queued" */
  status?: string;
}

export interface DeliveryReport {
  /** per-recipient status: queued | sent | delivered | not_delivered | failed | expired | … */
  status: string;
  messageId?: string;
  deliveredAt?: string;
  error?: string;
}

export interface SmsProvider {
  name: string;
  /** `to` is E.164, e.g. +233241234567 */
  send(to: string, message: string): Promise<SendResult>;
  /** Delivery report for a task (first recipient). */
  delivery?(taskId: string): Promise<DeliveryReport | null>;
}

export interface OtpGateway {
  name: string;
  /** Vynfy texts the code; resolves to its otp_id. `to` is E.164. */
  generate(to: string, opts: { message: string; length: number; expiryMin: number }): Promise<{ otpId: string }>;
  /** Resolves when the code is right; otherwise throws SmsError (invalid_code, expired, no_code, …). */
  verify(to: string, code: string): Promise<void>;
  /** Vynfy's state of the code: pending | verified | expired | failed */
  status?(otpId: string): Promise<{ status: string; attempts?: number } | null>;
}

type Body = Record<string, unknown> & { success?: boolean; error?: string; message?: string; code?: string };

async function call(key: string, path: string, init: { method: 'GET' | 'POST'; body?: unknown }): Promise<{ res: Response; body: Body }> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: init.method,
      headers: { 'X-API-Key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new SmsError(502, 'sms_failed', 'The SMS provider could not be reached. Please try again.', { message: 'network error or timeout' });
  }
  const body = (await res.json().catch(() => ({}))) as Body;
  return { res, body };
}

const reasonOf = (b: Body) => String(b.error ?? b.message ?? '').slice(0, 300);
const toNumber = (e164: string) => e164.replace(/^\+/, '');

/** Map a failed send/generate to a user-facing error that keeps Vynfy's reason. */
function sendError(res: Response, b: Body): SmsError {
  const provider = { httpStatus: res.status, code: typeof b.code === 'string' ? b.code : undefined, message: reasonOf(b) };
  const why = provider.message;
  console.error(`[sms] vynfy ${res.status} ${provider.code ?? ''} ${why}`.trim());
  if (provider.code === 'INSUFFICIENT_BALANCE' || res.status === 402 || /balance|insufficient|credit/i.test(why)) {
    return new SmsError(503, 'sms_unavailable', 'Verification texts are temporarily unavailable. Please try again later.', provider);
  }
  if (provider.code === 'OTP_PENDING' || /already pending/i.test(why)) {
    return new SmsError(429, 'otp_pending', 'A code was already sent to this number and is still valid.', provider);
  }
  if (/phone|number|recipient/i.test(provider.code ?? '') || /phone|number|recipient/i.test(why)) {
    return new SmsError(400, 'invalid_phone', `The SMS provider rejected this number${why ? `: ${why}` : ''}. Check it and try again.`, provider);
  }
  if (/sender/i.test(provider.code ?? '') || /sender/i.test(why)) {
    return new SmsError(503, 'sms_unavailable', 'Verification texts are temporarily unavailable. Please try again later.', provider);
  }
  return new SmsError(502, 'sms_failed', `The text message could not be sent${why ? ` (${why})` : ''}. Please try again.`, provider);
}

export class VynfyProvider implements SmsProvider {
  name = 'vynfy';
  constructor(
    private key: string,
    private sender: string,
    private sandbox = false,
  ) {}

  async send(to: string, message: string): Promise<SendResult> {
    const path = this.sandbox ? '/smssandbox/v1/send' : '/api/v1/send';
    const { res, body } = await call(this.key, path, { method: 'POST', body: { sender: this.sender, recipients: [toNumber(to)], message } });
    if (!res.ok || body.success === false) throw sendError(res, body);
    const data = (body.data ?? {}) as { task_id?: string; status?: string };
    return { id: data.task_id, status: data.status ?? 'queued' };
  }

  async delivery(taskId: string): Promise<DeliveryReport | null> {
    if (!/^[\w-]{8,64}$/.test(taskId)) return null;
    const { res, body } = await call(this.key, `/api/v1/status/${taskId}`, { method: 'GET' });
    if (!res.ok) return null;
    const m = (body.messages as Record<string, unknown>[] | undefined)?.[0];
    if (!m) return null;
    const err = m.error_message ?? m.error ?? m.reason ?? m.failure_reason;
    return {
      status: String(m.status ?? 'unknown'),
      messageId: typeof m.message_id === 'string' ? m.message_id : undefined,
      deliveredAt: typeof m.delivered_at === 'string' ? m.delivered_at : undefined,
      error: typeof err === 'string' ? err : undefined,
    };
  }
}

export class VynfyOtp implements OtpGateway {
  name = 'vynfy-otp';
  constructor(
    private key: string,
    private sender: string,
  ) {}

  async generate(to: string, opts: { message: string; length: number; expiryMin: number }) {
    const { res, body } = await call(this.key, '/otp/generate', {
      method: 'POST',
      body: {
        number: toNumber(to),
        message: opts.message,
        sender_id: this.sender,
        otp_type: 'numeric',
        medium: 'sms',
        length: opts.length,
        expiry: opts.expiryMin,
      },
    });
    if (!res.ok || body.success !== true || body.otp_id === undefined) throw sendError(res, body);
    return { otpId: String(body.otp_id) };
  }

  async verify(to: string, code: string) {
    const { res, body } = await call(this.key, '/otp/verify', { method: 'POST', body: { number: toNumber(to), code } });
    if (res.ok && body.success === true) return;
    const provider = { httpStatus: res.status, code: typeof body.code === 'string' ? body.code : undefined, message: reasonOf(body) };
    const left = [body.attempts_remaining, body.remaining_attempts, body.attempts_left].find((v) => typeof v === 'number') as number | undefined;
    switch (provider.code) {
      case 'INVALID_OTP':
        throw new SmsError(400, 'invalid_code', 'That code is not correct.', provider, left === undefined ? undefined : { attemptsLeft: left });
      case 'OTP_EXPIRED':
        throw new SmsError(400, 'expired', 'This code has expired. Request a new one.', provider);
      case 'NO_OTP_FOUND':
      case 'ALREADY_VERIFIED':
        throw new SmsError(400, 'no_code', 'This code is no longer valid. Request a new one.', provider);
      case 'INVALID_PHONE':
        throw new SmsError(400, 'invalid_phone', 'This phone number is not valid.', provider);
      case 'EMPTY_CODE':
      case 'MISSING_FIELD':
        throw new SmsError(400, 'bad_code', 'Enter the code from the text message.', provider);
    }
    if (/max(imum)? attempts|too many/i.test(provider.message)) {
      throw new SmsError(429, 'too_many_attempts', 'Too many wrong attempts. Request a new code.', provider);
    }
    console.error(`[sms] vynfy verify ${res.status} ${provider.code ?? ''}`.trim());
    throw new SmsError(502, 'verify_failed', 'The code could not be checked right now. Please try again.', provider);
  }

  async status(otpId: string) {
    if (!/^\d{1,18}$/.test(otpId)) return null;
    const { res, body } = await call(this.key, `/otp/status/${otpId}`, { method: 'GET' });
    const otp = body.otp as { status?: string; verification_attempts?: number } | undefined;
    if (!res.ok || !otp?.status) return null;
    return { status: otp.status, attempts: otp.verification_attempts };
  }
}

/** Free account checks for the admin SMS panel (never throws). */
export async function vynfyBalances(): Promise<{ sms: number | null; otp: number | null; senderStatus: string | null }> {
  const e = env();
  if (!e.vynfyKey) return { sms: null, otp: null, senderStatus: null };
  const num = (v: unknown) => (v === undefined || v === null || Number.isNaN(Number(v)) ? null : Number(v));
  const [sms, otp, sender] = await Promise.all([
    call(e.vynfyKey, '/api/v1/check/balance', { method: 'GET' }).then((r) => num(r.body.sms_balance), () => null),
    call(e.vynfyKey, '/otp/balance', { method: 'GET' }).then((r) => num(r.body.balance), () => null),
    e.vynfySender
      ? call(e.vynfyKey, `/sender/id/status?sender_name=${encodeURIComponent(e.vynfySender)}`, { method: 'GET' }).then(
          (r) => (typeof r.body.status === 'string' ? r.body.status : null),
          () => null,
        )
      : Promise.resolve(null),
  ]);
  return { sms, otp, senderStatus: sender };
}

let override: SmsProvider | null = null;
let otpOverride: OtpGateway | null | undefined;
/** test hooks */
export function setSmsProvider(p: SmsProvider | null) {
  override = p;
}
export function setOtpGateway(g: OtpGateway | null | undefined) {
  otpOverride = g;
}

export function getSmsProvider(): SmsProvider | null {
  if (override) return override;
  const e = env();
  if (e.smsProvider === 'vynfy' && e.vynfyKey && e.vynfySender) return new VynfyProvider(e.vynfyKey, e.vynfySender, e.vynfySandbox);
  return null;
}

/** Vynfy's OTP service, unless disabled (VYNFY_OTP=0) or running in the sandbox. */
export function getOtpGateway(): OtpGateway | null {
  if (otpOverride !== undefined) return otpOverride;
  const e = env();
  if (e.smsProvider === 'vynfy' && e.vynfyKey && e.vynfySender && e.vynfyOtp && !e.vynfySandbox) return new VynfyOtp(e.vynfyKey, e.vynfySender);
  return null;
}
