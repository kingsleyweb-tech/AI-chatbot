/**
 * SMS delivery behind a small interface so the provider can be swapped
 * (SMS_PROVIDER). Credentials stay on the server; only status codes are logged.
 */
import { env } from '../env.js';
import { HttpError } from '../http.js';

export interface SmsProvider {
  name: string;
  /** `to` is E.164, e.g. +233241234567 */
  send(to: string, message: string): Promise<{ id?: string }>;
}

export class VynfyProvider implements SmsProvider {
  name = 'vynfy';
  constructor(
    private key: string,
    private sender: string,
    private sandbox = false,
  ) {}

  async send(to: string, message: string) {
    const path = this.sandbox ? '/smssandbox/v1/send' : '/api/v1/send';
    let res: Response;
    try {
      res = await fetch(`https://sms.vynfy.com${path}`, {
        method: 'POST',
        headers: { 'x-api-key': this.key, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sender: this.sender, recipients: [to.replace(/^\+/, '')], message }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new HttpError(502, 'sms_failed', 'The text message could not be sent. Please try again.');
    }
    const body = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string; data?: { task_id?: string } };
    if (!res.ok || body.success === false) {
      console.error(`[sms] vynfy send failed: ${res.status}`);
      const msg = body.error ?? '';
      if (/invalid phone/i.test(msg)) throw new HttpError(400, 'invalid_phone', 'This phone number cannot receive text messages.');
      if (res.status === 402 || /balance|insufficient/i.test(msg)) {
        throw new HttpError(503, 'sms_unavailable', 'Text messages are temporarily unavailable. Please try again later.');
      }
      throw new HttpError(502, 'sms_failed', 'The text message could not be sent. Please try again.');
    }
    return { id: body.data?.task_id };
  }
}

let override: SmsProvider | null = null;
/** test hook */
export function setSmsProvider(p: SmsProvider | null) {
  override = p;
}

export function getSmsProvider(): SmsProvider | null {
  if (override) return override;
  const e = env();
  if (e.smsProvider === 'vynfy' && e.vynfyKey && e.vynfySender) return new VynfyProvider(e.vynfyKey, e.vynfySender, e.vynfySandbox);
  return null;
}
