import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OTP_MAX_ATTEMPTS, otpStatus, otpTemplate, sendCode, verifyCode, type OtpDeps } from '../server/auth/otp.js';
import { formatPhone, normalizeInternational, normalizePhone, toVynfy } from '../server/auth/phone.js';
import { HttpError } from '../server/http.js';
import { advances, deliveryOf, smsOverview, type SmsLogEntry } from '../server/sms/log.js';
import { SmsError, VynfyOtp, VynfyProvider, type OtpGateway, type SmsProvider } from '../server/sms/provider.js';
import { handleVynfyWebhook, verifySignature } from '../server/sms/webhook.js';
import { FakeDb } from './fakeDb.js';

/** Simulates Vynfy's OTP service: one pending code per number, 3 attempts, expiry. */
class FakeOtp implements OtpGateway {
  name = 'fake-otp';
  codes = new Map<string, { code: string; id: string; expiresAt: number; attempts: number; state: string }>();
  calls: { to: string; message: string; length: number; expiryMin: number }[] = [];
  next = 100;
  fail: SmsError | null = null;
  constructor(private clock: () => number) {}
  async generate(to: string, opts: { message: string; length: number; expiryMin: number }) {
    if (this.fail) throw this.fail;
    const cur = this.codes.get(to);
    if (cur && cur.state === 'pending' && cur.expiresAt > this.clock()) throw new SmsError(429, 'otp_pending', 'pending', { httpStatus: 429, code: 'OTP_PENDING' });
    this.calls.push({ to, ...opts });
    const id = String(this.next++);
    this.codes.set(to, { code: '4'.repeat(opts.length - 1) + '7', id, expiresAt: this.clock() + opts.expiryMin * 60_000, attempts: 0, state: 'pending' });
    return { otpId: id };
  }
  async verify(to: string, code: string) {
    const c = this.codes.get(to);
    if (!c || c.state !== 'pending') throw new SmsError(400, 'no_code', 'none', { code: 'NO_OTP_FOUND' });
    if (c.expiresAt <= this.clock()) throw new SmsError(400, 'expired', 'expired', { code: 'OTP_EXPIRED' });
    if (code !== c.code) {
      c.attempts++;
      if (c.attempts >= 3) c.state = 'failed';
      throw new SmsError(400, 'invalid_code', 'wrong', { code: 'INVALID_OTP' }, { attemptsLeft: 3 - c.attempts });
    }
    c.state = 'verified';
  }
}

class FakeSms implements SmsProvider {
  name = 'fake';
  sent: { to: string; message: string }[] = [];
  async send(to: string, message: string) {
    this.sent.push({ to, message });
    return { id: 'task-1234567890', status: 'queued' };
  }
  async delivery() {
    return { status: 'not_delivered', messageId: 'msg-1234567890' };
  }
}

const SECRET = 'x'.repeat(64);
let db: FakeDb;
let otp: FakeOtp;
let sms: FakeSms;
let now: number;
let deps: OtpDeps;

async function code(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    return (err as HttpError).code;
  }
  return 'ok';
}

beforeEach(() => {
  db = new FakeDb();
  now = Date.parse('2026-11-08T10:00:00Z');
  otp = new FakeOtp(() => now);
  sms = new FakeSms();
  deps = { db: db.asFirestore(), sms, otp, secret: SECRET, dailyCap: 200, otpLength: 6, otpExpiryMin: 5, smsFallback: true, now: () => now };
});

describe('phone numbers (Ghana and international)', () => {
  it.each([
    ['0501901401', '+233501901401'],
    ['+233501901401', '+233501901401'],
    ['233501901401', '+233501901401'],
    ['+233 50 190 1401', '+233501901401'],
    ['+2330501901401', '+233501901401'], // domestic 0 kept after +233 is dropped
    ['00233 50 190 1401', '+233501901401'],
    ['050-190-1401', '+233501901401'],
  ])('%s -> %s', (input, e164) => {
    expect(normalizePhone(input)).toEqual({ ok: true, e164 });
  });

  it('never produces +2330… and sends 233XXXXXXXXX to Vynfy', () => {
    const r = normalizePhone('+233 024 123 4567');
    expect(r).toEqual({ ok: true, e164: '+233241234567' });
    expect(toVynfy('+233241234567')).toBe('233241234567');
    expect(formatPhone('+233501901401')).toBe('+233 50 190 1401');
  });

  it('rejects numbers that are not valid Ghana mobiles', () => {
    expect(normalizePhone('+233 11 123 4567').ok).toBe(false); // not a Ghana range
    expect(normalizePhone('0302123456').ok).toBe(false); // Accra landline
    expect(normalizePhone('05019014011').ok).toBe(false); // one digit too many
    expect(normalizePhone('050190140').ok).toBe(false); // one too few
    expect(normalizePhone('+233').ok).toBe(false);
    expect(normalizePhone('+2348031234567')).toEqual({ ok: false, reason: 'country' });
  });

  it('international contact numbers keep their country code without duplicating it', () => {
    expect(normalizeInternational('0803 123 4567', '+234')).toEqual({ ok: true, e164: '+2348031234567' });
    expect(normalizeInternational('+234 803 123 4567', '+234')).toEqual({ ok: true, e164: '+2348031234567' });
    expect(normalizeInternational('050 190 1401', '+233')).toEqual({ ok: true, e164: '+233501901401' });
  });
});

describe('Vynfy OTP route', () => {
  it('asks Vynfy to generate the code; nothing secret is stored and the number is not verified yet', async () => {
    const r = await sendCode(deps, 'u1', '0501901401');
    expect(r).toMatchObject({ route: 'otp', codeLength: 6, expiresIn: 300, resendIn: 60, delivery: 'unavailable', phoneDisplay: '+233 50 190 1401' });
    expect(otp.calls).toEqual([{ to: '+233501901401', message: otpTemplate(5), length: 6, expiryMin: 5 }]);
    expect(otp.calls[0].message).toContain('%otp_code%');
    expect(otp.calls[0].message.length).toBeLessThanOrEqual(160);
    expect(sms.sent).toHaveLength(0);
    const d = db.docs.get('otp/u1')!;
    expect(d.codeHash).toBeNull();
    expect(d.otpId).toBe('100');
    expect(db.docs.has(`users/u1`)).toBe(false);
    const log = [...db.docs.entries()].find(([p]) => p.startsWith('smsLog/'))![1] as unknown as SmsLogEntry;
    expect(log).toMatchObject({ purpose: 'verify', route: 'otp', ref: '100', accepted: true, delivery: 'unavailable', outcome: 'none', uid: 'u1' });
    expect(JSON.stringify(log)).not.toContain('444447');
  });

  it('verifies through Vynfy and only then binds the number', async () => {
    await sendCode(deps, 'u1', '0501901401');
    expect(await verifyCode(deps, 'u1', '444447')).toEqual({ phone: '+233501901401' });
    expect(db.docs.size).toBeGreaterThan(0);
    // the same code cannot be used again
    expect(await code(verifyCode(deps, 'u1', '444447'))).toBe('no_code');
    const log = [...db.docs.entries()].find(([p]) => p.startsWith('smsLog/'))![1] as unknown as SmsLogEntry;
    expect(log.outcome).toBe('verified');
  });

  it('wrong codes count down from 3 and then lock the code', async () => {
    await sendCode(deps, 'u1', '0501901401');
    await expect(verifyCode(deps, 'u1', '000000')).rejects.toMatchObject({ code: 'invalid_code', details: { attemptsLeft: 2 } });
    await expect(verifyCode(deps, 'u1', '000001')).rejects.toMatchObject({ code: 'invalid_code', details: { attemptsLeft: 1 } });
    expect(await code(verifyCode(deps, 'u1', '000002'))).toBe('too_many_attempts');
    expect(await code(verifyCode(deps, 'u1', '444447'))).toBe('no_code'); // even the right code is dead
    expect(OTP_MAX_ATTEMPTS).toBe(3);
  });

  it('expired codes are refused', async () => {
    await sendCode(deps, 'u1', '0501901401');
    now += 5 * 60_000 + 1;
    expect(await code(verifyCode(deps, 'u1', '444447'))).toBe('expired');
  });

  it('resend: 60 s cooldown, then explains the pending code instead of paying for a refused request', async () => {
    await sendCode(deps, 'u1', '0501901401');
    now += 30_000;
    expect(await code(sendCode(deps, 'u1', null))).toBe('resend_cooldown');
    now += 31_000;
    const err = await sendCode(deps, 'u1', null).catch((e: HttpError) => e);
    expect(err).toMatchObject({ code: 'otp_pending', details: { ussd: '*928*01#' } });
    expect((err as HttpError).message).toMatch(/still valid for 3:59/);
    expect(otp.calls).toHaveLength(1); // Vynfy was not asked again
    now += 4 * 60_000;
    expect(await code(sendCode(deps, 'u1', null))).toBe('ok'); // resend to the same number after expiry
    expect(otp.calls).toHaveLength(2);
  });

  it('a different number can be requested while a code is pending', async () => {
    await sendCode(deps, 'u1', '0501901401');
    now += 61_000;
    expect(await code(sendCode(deps, 'u1', '0241234567'))).toBe('ok');
  });

  it('shows Vynfy rejections with their reason and logs them', async () => {
    otp.fail = new SmsError(400, 'invalid_phone', 'The SMS provider rejected this number: Invalid phone format. Check it and try again.', { httpStatus: 400, code: 'INVALID_PHONE', message: 'Invalid phone format' });
    const err = await sendCode(deps, 'u1', '0501901401').catch((e: HttpError) => e);
    expect(err).toMatchObject({ code: 'invalid_phone' });
    expect((err as HttpError).message).toContain('Invalid phone format');
    const log = [...db.docs.entries()].find(([p]) => p.startsWith('smsLog/'))![1] as unknown as SmsLogEntry;
    expect(log).toMatchObject({ accepted: false, delivery: 'failed', error: 'Invalid phone format', providerStatus: 'INVALID_PHONE' });
    // the failed request does not block an immediate retry
    otp.fail = null;
    expect(await code(sendCode(deps, 'u1', '0501901401'))).toBe('ok');
  });

  it('falls back to an app code over ordinary SMS only when the OTP balance is empty', async () => {
    otp.fail = new SmsError(503, 'sms_unavailable', 'unavailable', { httpStatus: 402, code: 'INSUFFICIENT_BALANCE', message: 'Not enough credits' });
    const r = await sendCode(deps, 'u1', '0501901401');
    expect(r.route).toBe('sms');
    expect(sms.sent).toHaveLength(1);
    const c = /code is (\d{6})/.exec(sms.sent[0].message)![1];
    expect(await verifyCode(deps, 'u1', c)).toEqual({ phone: '+233501901401' });
  });

  it('does not fall back when disabled, or for other failures', async () => {
    deps.smsFallback = false;
    otp.fail = new SmsError(503, 'sms_unavailable', 'unavailable', { httpStatus: 402, code: 'INSUFFICIENT_BALANCE', message: 'Not enough credits' });
    expect(await code(sendCode(deps, 'u1', '0501901401'))).toBe('sms_unavailable');
    deps.smsFallback = true;
    otp.fail = new SmsError(502, 'sms_failed', 'down', { httpStatus: 500, message: 'GENERATION_FAILED' });
    now += 61_000;
    expect(await code(sendCode(deps, 'u1', '0501901401'))).toBe('sms_failed');
    expect(sms.sent).toHaveLength(0);
  });

  it('status reports a failed SMS delivery with the provider status', async () => {
    deps.otp = null;
    await sendCode(deps, 'u1', '0501901401');
    const s = await otpStatus(deps, 'u1');
    expect(s.delivery).toEqual({ state: 'failed', error: 'Vynfy status: not_delivered' });
  });
});

describe('Vynfy HTTP client (documented request and error formats)', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());
  const reply = (status: number, body: unknown) => fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));

  it('POST /otp/generate with the documented fields and X-API-Key', async () => {
    reply(200, { success: true, otp_id: 123, message: 'OTP sent successfully', ussd_code: '*928*01#' });
    const g = new VynfyOtp('k', 'ATLAS');
    expect(await g.generate('+233501901401', { message: otpTemplate(5), length: 6, expiryMin: 5 })).toEqual({ otpId: '123' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://sms.vynfy.com/otp/generate');
    expect(init.method).toBe('POST');
    expect(init.headers['X-API-Key']).toBe('k');
    expect(JSON.parse(init.body)).toEqual({ number: '233501901401', message: otpTemplate(5), sender_id: 'ATLAS', otp_type: 'numeric', medium: 'sms', length: 6, expiry: 5 });
  });

  it.each([
    [402, { code: 'INSUFFICIENT_BALANCE', error: 'Not enough credits' }, 'sms_unavailable'],
    [429, { code: 'OTP_PENDING', error: 'OTP already pending' }, 'otp_pending'],
    [400, { error: 'Ghana local numbers must be 10 digits (0XXXXXXXXX)' }, 'invalid_phone'],
    [500, { code: 'GENERATION_FAILED', error: 'API error' }, 'sms_failed'],
  ])('generate %i %j -> %s', async (status, body, expected) => {
    reply(status, body);
    const err = await new VynfyOtp('k', 'ATLAS').generate('+233501901401', { message: 'x %otp_code%', length: 6, expiryMin: 5 }).catch((e) => e);
    expect(err).toBeInstanceOf(SmsError);
    expect(err.code).toBe(expected);
    expect(err.provider.httpStatus).toBe(status);
  });

  it.each([
    [400, { code: 'INVALID_OTP', error: 'Wrong code', attempts_remaining: 1 }, 'invalid_code'],
    [400, { code: 'OTP_EXPIRED', error: 'OTP has expired' }, 'expired'],
    [404, { code: 'NO_OTP_FOUND', error: 'No pending OTP found for this number', success: false }, 'no_code'],
    [400, { code: 'ALREADY_VERIFIED', error: 'Already verified' }, 'no_code'],
    [500, { code: 'VERIFICATION_FAILED', error: 'API error' }, 'verify_failed'],
  ])('verify %i %j -> %s', async (status, body, expected) => {
    reply(status, body);
    const err = await new VynfyOtp('k', 'ATLAS').verify('+233501901401', '123456').catch((e) => e);
    expect(err.code).toBe(expected);
  });

  it('verify success and request body', async () => {
    reply(200, { success: true, otp_id: 123, phone_number: '233501901401', verified_at: '2026-11-08T11:00:00' });
    await new VynfyOtp('k', 'ATLAS').verify('+233501901401', '123456');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ number: '233501901401', code: '123456' });
  });

  it('bulk send returns the task id; status maps per-recipient delivery', async () => {
    reply(200, { success: true, data: { task_id: 'a17813e3-7511-47bb-95c9-a2c980306a75', status: 'queued' } });
    const p = new VynfyProvider('k', 'ATLAS');
    expect(await p.send('+233501901401', 'hi')).toEqual({ id: 'a17813e3-7511-47bb-95c9-a2c980306a75', status: 'queued' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ sender: 'ATLAS', recipients: ['233501901401'], message: 'hi' });
    reply(200, { success: true, messages: [{ message_id: 'm1-abcdefgh', recipient: '233501901401', status: 'not_delivered' }] });
    expect(await p.delivery('a17813e3-7511-47bb-95c9-a2c980306a75')).toEqual({ status: 'not_delivered', messageId: 'm1-abcdefgh', deliveredAt: undefined, error: undefined });
  });

  it('a network failure is a clear error, not success', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    expect((await new VynfyOtp('k', 'ATLAS').generate('+233501901401', { message: 'x %otp_code%', length: 6, expiryMin: 5 }).catch((e) => e)).code).toBe('sms_failed');
  });
});

describe('delivery states and webhooks', () => {
  it('maps provider statuses and only moves forward', () => {
    expect(deliveryOf('delivered')).toBe('delivered');
    expect(deliveryOf('not_delivered')).toBe('failed');
    expect(deliveryOf('sent')).toBe('sent');
    expect(deliveryOf('queued')).toBe('pending');
    expect(advances('pending', 'sent')).toBe(true);
    expect(advances('delivered', 'sent')).toBe(false);
    expect(advances('failed', 'delivered')).toBe(false);
  });

  const WH = 'whsec-test';
  const sign = (body: string) => createHmac('sha256', WH).update(body).digest('hex');

  it('rejects unsigned, wrongly signed, or unconfigured webhooks', async () => {
    const body = JSON.stringify({ event: 'delivered', data: { message_id: 'msg-1234567890', status: 'delivered' } });
    expect((await handleVynfyWebhook(db.asFirestore(), WH, body, null)).status).toBe(401);
    expect((await handleVynfyWebhook(db.asFirestore(), WH, body, 'deadbeef')).status).toBe(401);
    expect((await handleVynfyWebhook(db.asFirestore(), '', body, sign(body))).status).toBe(503);
    expect(verifySignature(body, sign(body), WH)).toBe(true);
  });

  it('applies a signed event once and ignores duplicates and stale events', async () => {
    deps.otp = null;
    await sendCode(deps, 'u1', '0501901401');
    const [path] = [...db.docs.keys()].filter((p) => p.startsWith('smsLog/'));
    const sent = JSON.stringify({ event: 'sent', timestamp: 't1', data: { message_id: 'task-1234567890', recipients: ['233501901401'] } });
    const delivered = JSON.stringify({ event: 'delivered', timestamp: 't2', data: { message_id: 'task-1234567890', status: 'delivered', recipient: '233501901401' } });
    expect((await handleVynfyWebhook(db.asFirestore(), WH, sent, sign(sent))).body).toEqual({ ok: true });
    expect((await handleVynfyWebhook(db.asFirestore(), WH, delivered, sign(delivered))).body).toEqual({ ok: true });
    expect((await handleVynfyWebhook(db.asFirestore(), WH, delivered, sign(delivered))).body).toEqual({ ok: true, duplicate: true });
    const late = JSON.stringify({ event: 'sent', timestamp: 't3', data: { message_id: 'task-1234567890' } });
    await handleVynfyWebhook(db.asFirestore(), WH, late, sign(late));
    expect(db.docs.get(path)).toMatchObject({ delivery: 'delivered', providerStatus: 'sent' });
  });

  it('records the failure reason Vynfy reports', async () => {
    deps.otp = null;
    await sendCode(deps, 'u1', '0501901401');
    const failed = JSON.stringify({ event: 'failed', data: { message_id: 'task-1234567890', status: 'failed', error_message: 'DND active' } });
    await handleVynfyWebhook(db.asFirestore(), WH, failed, sign(failed));
    const [path] = [...db.docs.keys()].filter((p) => p.startsWith('smsLog/'));
    expect(db.docs.get(path)).toMatchObject({ delivery: 'failed', error: 'DND active' });
  });

  it('admin overview counts requests, outcomes and refreshes receipts', async () => {
    await sendCode(deps, 'u1', '0501901401'); // OTP route, no receipt
    await verifyCode(deps, 'u1', '444447');
    deps.otp = null;
    await sendCode(deps, 'u2', '0241234567'); // SMS route -> not_delivered
    otp.fail = null;
    const o = await smsOverview(db.asFirestore(), sms, now);
    expect(o.totals).toMatchObject({ requests: 2, accepted: 2, failed: 1, noReceipt: 1, verified: 1, verificationRate: 50 });
    expect(JSON.stringify(o)).not.toContain('444447');
  });
});

describe('OTP service status as a delivery signal', () => {
  it("records Vynfy's 'sent' status, and ignores code states", async () => {
    let st = 'pending';
    const g = Object.assign(otp, { status: async () => ({ status: st }) });
    deps.otp = g;
    await sendCode(deps, 'u1', '0501901401');
    expect((await otpStatus(deps, 'u1')).delivery).toEqual({ state: 'unavailable', error: null });
    st = 'sent';
    expect((await otpStatus(deps, 'u1')).delivery).toEqual({ state: 'sent', error: null });
    st = 'verified';
    expect((await otpStatus(deps, 'u1')).delivery).toEqual({ state: 'sent', error: null });
  });
});
