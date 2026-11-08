/**
 * End-to-end phone verification against the Auth and Firestore emulators:
 * real /api/phone handler, real custom claims, real security rules. Only the
 * SMS sender is replaced (no text is sent, nothing is charged).
 */
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const FS = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';
const PROJECT = process.env.GCLOUD_PROJECT ?? 'demo-tessera';
Object.assign(process.env, {
  FIRESTORE_EMULATOR_HOST: FS,
  FIREBASE_AUTH_EMULATOR_HOST: AUTH,
  FIREBASE_PROJECT_ID: PROJECT,
  OTP_HMAC_SECRET: 'e'.repeat(64),
});

const { POST } = await import('../../api/phone.js');
const { setTokenVerifier } = await import('../../server/auth.js');
const { requireAllowedUser } = await import('../../server/access.js');
const { setSmsProvider } = await import('../../server/sms/provider.js');

const sent: { to: string; message: string }[] = [];
const ID = `http://${AUTH}/identitytoolkit.googleapis.com/v1`;
const DOCS = `http://${FS}/v1/projects/${PROJECT}/databases/(default)/documents`;
let up = true;

async function authCall<T>(path: string, body: object, owner = false): Promise<T> {
  const res = await fetch(`${ID}/${path}${owner ? '' : '?key=fake-key'}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(owner ? { authorization: 'Bearer owner' } : {}) },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as T & { error?: unknown };
  if (!res.ok) throw new Error(`${path}: ${JSON.stringify(json.error)}`);
  return json;
}
const signIn = (email: string) => authCall<{ idToken: string; localId: string }>('accounts:signInWithPassword', { email, password: 'secret123', returnSecureToken: true });

async function newPasswordUser(email: string) {
  const r = await authCall<{ localId: string }>('accounts:signUp', { email, password: 'secret123', returnSecureToken: true });
  await authCall(`projects/${PROJECT}/accounts:update`, { localId: r.localId, emailVerified: true }, true);
  return (await signIn(email)).idToken;
}

async function phone(token: string, body: object) {
  const res = await POST(new Request('http://x/api/phone', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> & { error?: Record<string, unknown> } };
}

const fsStatus = async (token: string, method: string, path: string, fields?: object) =>
  (await fetch(`${DOCS}/${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: fields ? JSON.stringify({ fields }) : undefined })).status;

beforeAll(async () => {
  up = Boolean(await fetch(`http://${AUTH}/`).catch(() => null)) && Boolean(await fetch(`http://${FS}/`).catch(() => null));
  if (!up) return;
  // Emulator tokens are unsigned; skip signature checks here only.
  setTokenVerifier(async (t) => decodeJwt(t));
  setSmsProvider({ name: 'test', send: async (to, message) => (sent.push({ to, message }), {}) });
  await fetch(`http://${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
  await fetch(`http://${FS}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await fsStatus('owner', 'PATCH', 'config/access', { allowedEmails: { arrayValue: { values: [{ stringValue: 'ama@example.com' }] } }, adminEmails: { arrayValue: {} } });
});

afterAll(() => {
  setTokenVerifier(null);
  setSmsProvider(null);
});

describe.runIf(process.env.FIREBASE_AUTH_EMULATOR_HOST)('phone verification end to end', () => {
  it('email/password sign-up -> SMS code -> claim -> access', async (ctx) => {
    if (!up) ctx.skip();
    let token = await newPasswordUser('ama@example.com');
    const uid = decodeJwt(token).sub!;

    // Locked out everywhere before verification.
    await expect(requireAllowedUser(new Request('http://x', { headers: { authorization: `Bearer ${token}` } }))).rejects.toMatchObject({ code: 'phone_unverified' });
    expect(await fsStatus(token, 'GET', `users/${uid}`)).toBe(403);

    const s = await phone(token, { action: 'status' });
    expect(s.body).toMatchObject({ required: true, verified: false, configured: true, pending: false });

    const send = await phone(token, { action: 'send', phone: '024 123 4567' });
    expect(send.status).toBe(200);
    expect(send.body).toMatchObject({ phoneMasked: '+233 •• ••• 4567', expiresIn: 300, resendIn: 60 });
    expect(sent.at(-1)!.to).toBe('+233241234567');
    const code = /code is (\d{6})/.exec(sent.at(-1)!.message)![1];

    // Immediate resend is refused.
    expect((await phone(token, { action: 'send', phone: '0241234567' })).body.error).toMatchObject({ code: 'resend_cooldown' });

    // The browser can never read the code record.
    expect(await fsStatus(token, 'GET', `otp/${uid}`)).toBe(403);

    const wrong = await phone(token, { action: 'verify', code: code === '000000' ? '111111' : '000000' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toMatchObject({ code: 'invalid_code', attemptsLeft: 4 });

    const ok = await phone(token, { action: 'verify', code });
    expect(ok).toMatchObject({ status: 200, body: { ok: true, verified: true } });

    // Claim is on the account; a refreshed token carries it.
    const look = await authCall<{ users: { customAttributes?: string }[] }>(`projects/${PROJECT}/accounts:lookup`, { localId: [uid] }, true);
    expect(JSON.parse(look.users[0].customAttributes!)).toMatchObject({ phoneVerified: true });
    const stale = token;
    token = (await signIn('ama@example.com')).idToken;
    expect(decodeJwt(token).phoneVerified).toBe(true);

    expect(await fsStatus(stale, 'GET', `users/${uid}`)).toBe(403);
    expect(await fsStatus(token, 'GET', `users/${uid}`)).toBe(200);
    await expect(requireAllowedUser(new Request('http://x', { headers: { authorization: `Bearer ${token}` } }))).resolves.toMatchObject({ user: { uid } });
    // Profile phone fields are server-written and cannot be changed by the client.
    expect(await fsStatus(token, 'PATCH', `users/${uid}?updateMask.fieldPaths=phoneVerified`, { phoneVerified: { booleanValue: false } })).toBe(403);
    expect((await phone(token, { action: 'status' })).body).toMatchObject({ verified: true });
    // The code was single use.
    expect((await phone(token, { action: 'verify', code })).body.error).toMatchObject({ code: 'no_code' });
  });

  it('accounts that are not approved cannot trigger texts', async (ctx) => {
    if (!up) ctx.skip();
    const before = sent.length;
    const token = await newPasswordUser('stranger@example.com');
    const r = await phone(token, { action: 'send', phone: '0551234567' });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatchObject({ code: 'not_allowed' });
    expect(sent.length).toBe(before);
  });

  it('a number verified by one account cannot verify another', async (ctx) => {
    if (!up) ctx.skip();
    await fsStatus('owner', 'PATCH', 'config/access', {
      allowedEmails: { arrayValue: { values: [{ stringValue: 'ama@example.com' }, { stringValue: 'kofi@example.com' }] } },
      adminEmails: { arrayValue: {} },
    });
    const token = await newPasswordUser('kofi@example.com');
    const r = await phone(token, { action: 'send', phone: '0241234567' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'phone_in_use' });
  });

  it('Google sign-ins do not need a phone but can add, change and remove one', async (ctx) => {
    if (!up) ctx.skip();
    await fsStatus('owner', 'PATCH', 'config/access', {
      allowedEmails: { arrayValue: { values: ['ama@example.com', 'kofi@example.com', 'ama.g@example.com'].map((v) => ({ stringValue: v })) } },
      adminEmails: { arrayValue: {} },
    });
    const fakeIdToken = JSON.stringify({ sub: 'g-123', email: 'ama.g@example.com', email_verified: true });
    const r = await authCall<{ idToken: string; localId: string }>('accounts:signInWithIdp', {
      postBody: `id_token=${encodeURIComponent(fakeIdToken)}&providerId=google.com`,
      requestUri: 'http://localhost',
      returnSecureToken: true,
    });
    expect((decodeJwt(r.idToken).firebase as { sign_in_provider: string }).sign_in_provider).toBe('google.com');
    expect((await phone(r.idToken, { action: 'status' })).body).toMatchObject({ required: false, verified: true, phoneVerified: false });
    const send = await phone(r.idToken, { action: 'send', phone: '0201234567' });
    expect(send.status).toBe(200);
    const code = /code is (\d{6})/.exec(sent.at(-1)!.message)![1];
    expect((await phone(r.idToken, { action: 'verify', code })).body).toMatchObject({ ok: true, verified: true });
    const look = await authCall<{ users: { customAttributes?: string }[] }>(`projects/${PROJECT}/accounts:lookup`, { localId: [r.localId] }, true);
    expect(JSON.parse(look.users[0].customAttributes!)).toMatchObject({ phoneVerified: true });
    // Google accounts may remove their number again
    expect((await phone(r.idToken, { action: 'remove' })).status).toBe(200);
    const after = await authCall<{ users: { customAttributes?: string }[] }>(`projects/${PROJECT}/accounts:lookup`, { localId: [r.localId] }, true);
    expect(JSON.parse(after.users[0].customAttributes ?? '{}').phoneVerified).toBeUndefined();
  });

  it('email/password accounts cannot remove their verified number', async (ctx) => {
    if (!up) ctx.skip();
    const token = (await signIn('ama@example.com')).idToken;
    const r = await phone(token, { action: 'remove' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatchObject({ code: 'phone_required' });
  });
});
