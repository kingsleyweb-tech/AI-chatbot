/**
 * Vynfy SMS delivery webhooks (events: sent, delivered, failed, expired).
 *
 * Vynfy signs each request with HMAC-SHA256 of the JSON payload (hex, header
 * X-Webhook-Signature) when a webhook secret is configured in the Vynfy
 * dashboard. Unsigned or wrongly signed requests are rejected, so no secret
 * configured here = webhooks disabled. Valid events are applied once
 * (idempotent by event + message id) and only move a status forward.
 * Vynfy documents webhooks for ordinary SMS only (not the OTP service).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Firestore } from '../firestore.js';
import { advances, deliveryOf, updateSms, type SmsLogEntry } from './log.js';

interface WebhookPayload {
  event?: string;
  timestamp?: string;
  data?: { message_id?: string; status?: string; error_message?: string; recipient?: string; delivered_at?: string };
}

function sameHex(a: string, b: string) {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

export function verifySignature(raw: string, signature: string | null, secret: string): boolean {
  if (!secret || !signature) return false;
  const sig = signature.trim().toLowerCase().replace(/^sha256=/, '');
  const sign = (s: string) => createHmac('sha256', secret).update(s).digest('hex');
  if (sameHex(sign(raw), sig)) return true;
  // Vynfy's examples sign the compact re-serialised JSON.
  try {
    return sameHex(sign(JSON.stringify(JSON.parse(raw))), sig);
  } catch {
    return false;
  }
}

export async function handleVynfyWebhook(db: Firestore, secret: string, raw: string, signature: string | null): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!secret) return { status: 503, body: { ok: false, error: 'webhook secret not configured' } };
  if (!verifySignature(raw, signature, secret)) return { status: 401, body: { ok: false, error: 'bad signature' } };
  let p: WebhookPayload;
  try {
    p = JSON.parse(raw) as WebhookPayload;
  } catch {
    return { status: 400, body: { ok: false } };
  }
  const id = p.data?.message_id;
  const event = (p.event ?? p.data?.status ?? '').toLowerCase();
  if (!id || !/^[\w-]{8,64}$/.test(id) || !event) return { status: 200, body: { ok: true, ignored: true } };

  try {
    // message_id is Vynfy's per-message id; the "sent" event may carry the task id.
    const [byMessage, byTask] = await Promise.all([
      db.list<SmsLogEntry>('smsLog', { where: [['messageId', 'EQUAL', id]], limit: 1 }),
      db.list<SmsLogEntry>('smsLog', { where: [['ref', 'EQUAL', id]], limit: 1 }),
    ]);
    const doc = byMessage[0] ?? byTask[0];
    if (!doc) return { status: 200, body: { ok: true, unknown: true } };
    const key = `${event}:${id}:${p.timestamp ?? ''}`.slice(0, 160);
    const seen = doc.data.events ?? [];
    if (seen.includes(key)) return { status: 200, body: { ok: true, duplicate: true } };
    const delivery = deliveryOf(event === 'sent' ? 'sent' : (p.data?.status ?? event));
    await updateSms(db, doc.id, {
      events: [...seen, key].slice(-20),
      providerStatus: p.data?.status ?? event,
      ...(byMessage[0] ? {} : { messageId: id }),
      ...(advances(doc.data.delivery, delivery) ? { delivery } : {}),
      ...(p.data?.error_message ? { error: p.data.error_message.slice(0, 300) } : {}),
    });
  } catch (err) {
    // Vynfy: respond 200 even if processing fails (it does not retry).
    console.error('[sms] webhook processing failed', (err as Error).message);
  }
  return { status: 200, body: { ok: true } };
}
