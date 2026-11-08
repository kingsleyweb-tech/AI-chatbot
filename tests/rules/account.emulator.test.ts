/**
 * End-to-end account security against the Auth and Firestore emulators:
 * SMS password recovery, admin suspension, soft delete and purge, using the
 * real API handlers, the real admin REST calls and the real security rules.
 * Only the SMS sender is replaced (nothing is sent or charged).
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
  OTP_HMAC_SECRET: 'r'.repeat(64),
  ADMIN_EMAILS: 'boss@example.com',
});

const phoneApi = (await import('../../api/phone.js')).POST;
const recoveryApi = await import('../../api/recovery.js');
const adminApi = (await import('../../api/admin.js')).POST;
const accountApi = (await import('../../api/account.js')).POST;
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
  if (!res.ok) throw Object.assign(new Error(`${path}: ${JSON.stringify(json.error)}`), { body: json.error });
  return json;
}
const signIn = (email: string, password = 'secret123') =>
  authCall<{ idToken: string; localId: string }>('accounts:signInWithPassword', { email, password, returnSecureToken: true });

async function call(handler: (r: Request) => Promise<Response>, path: string, body: object, token?: string) {
  const res = await handler(
    new Request(`http://x/api/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130' },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> & { error?: Record<string, unknown> } };
}
const fsStatus = async (token: string, method: string, path: string, fields?: object) =>
  (await fetch(`${DOCS}/${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: fields ? JSON.stringify({ fields }) : undefined })).status;
const fsGet = async (path: string) => (await (await fetch(`${DOCS}/${path}`, { headers: { authorization: 'Bearer owner' } })).json()) as { fields?: Record<string, Record<string, unknown>> };
const lastCode = () => /code is (\d{6})/.exec(sent.at(-1)!.message)![1];

/** sign up, verify email, verify phone through the real phone API; returns a fresh token */
async function verifiedUser(email: string, phone: string) {
  const r = await authCall<{ localId: string }>('accounts:signUp', { email, password: 'secret123', returnSecureToken: true });
  await authCall(`projects/${PROJECT}/accounts:update`, { localId: r.localId, emailVerified: true }, true);
  let token = (await signIn(email)).idToken;
  // Registration records the Terms of Use / Privacy Policy acceptance through the real API.
  expect((await call(accountApi, 'account', { action: 'acceptTerms', termsVersion: '1.1', privacyVersion: '1.1' }, token)).status).toBe(200);
  expect((await call(phoneApi, 'phone', { action: 'send', phone }, token)).status).toBe(200);
  expect((await call(phoneApi, 'phone', { action: 'verify', code: lastCode() }, token)).status).toBe(200);
  token = (await signIn(email)).idToken;
  return { uid: r.localId, token };
}

async function googleUser(email: string, sub: string) {
  const r = await authCall<{ idToken: string; localId: string }>('accounts:signInWithIdp', {
    postBody: `id_token=${encodeURIComponent(JSON.stringify({ sub, email, email_verified: true }))}&providerId=google.com`,
    requestUri: 'http://localhost',
    returnSecureToken: true,
  });
  expect((await call(accountApi, 'account', { action: 'acceptTerms', termsVersion: '1.1', privacyVersion: '1.1' }, r.idToken)).status).toBe(200);
  return { uid: r.localId, token: r.idToken };
}

const allow = (emails: string[]) =>
  fsStatus('owner', 'PATCH', 'config/access', { allowedEmails: { arrayValue: { values: emails.map((v) => ({ stringValue: v })) } }, adminEmails: { arrayValue: {} } });

beforeAll(async () => {
  up = Boolean(await fetch(`http://${AUTH}/`).catch(() => null)) && Boolean(await fetch(`http://${FS}/`).catch(() => null));
  if (!up) return;
  setTokenVerifier(async (t) => decodeJwt(t));
  setSmsProvider({ name: 'test', send: async (to, message) => (sent.push({ to, message }), {}) });
  recoveryApi.setRecoveryDeps({ decoyDelayMs: 0 });
  await fetch(`http://${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
  await fetch(`http://${FS}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  // the rules only know the real bootstrap admin, so the test admin is also allow-listed
  await allow(['esi@example.com', 'yaw@example.com', 'abena@example.com', 'boss@example.com']);
});

afterAll(() => {
  setTokenVerifier(null);
  setSmsProvider(null);
  recoveryApi.setRecoveryDeps(null);
});

describe.runIf(process.env.FIREBASE_AUTH_EMULATOR_HOST)('account security end to end', () => {
  it('resets a password by SMS code and signs out old sessions', async (ctx) => {
    if (!up) ctx.skip();
    const { uid, token: oldToken } = await verifiedUser('esi@example.com', '0241112222');
    await new Promise((r) => setTimeout(r, 1100)); // auth_time has 1 s resolution

    const start = await call(recoveryApi.POST, 'recovery', { action: 'start', email: 'ESI@example.com' });
    expect(start.status).toBe(200);
    expect(start.body.phoneMasked).toBeNull(); // never shown, real or made up
    expect(sent.at(-1)!.to).toBe('+233241112222');
    expect(sent.at(-1)!.message).toContain('password reset code');

    // unknown address: same response shape, no text
    const before = sent.length;
    const unknown = await call(recoveryApi.POST, 'recovery', { action: 'start', email: 'nobody@example.com' });
    expect(Object.keys(unknown.body).sort()).toEqual(Object.keys(start.body).sort());
    expect(sent.length).toBe(before);

    const v = await call(recoveryApi.POST, 'recovery', { action: 'verify', recoveryId: start.body.recoveryId, code: lastCode() });
    expect(v.status).toBe(200);
    const reset = await call(recoveryApi.POST, 'recovery', { action: 'reset', recoveryId: start.body.recoveryId, resetToken: v.body.resetToken, password: 'brandnew42' });
    expect(reset.status).toBe(200);

    await expect(signIn('esi@example.com', 'secret123')).rejects.toThrow();
    const fresh = (await signIn('esi@example.com', 'brandnew42')).idToken;
    // the old session is refused by the rules and the API; the new one works
    expect(await fsStatus(oldToken, 'GET', `users/${uid}`)).toBe(403);
    await expect(requireAllowedUser(new Request('http://x', { headers: { authorization: `Bearer ${oldToken}` } }))).rejects.toMatchObject({ code: 'session_revoked' });
    expect(await fsStatus(fresh, 'GET', `users/${uid}`)).toBe(200);
    // the reset was recorded; the recovery record is gone
    const events = await (await fetch(`${DOCS}/users/${uid}/securityEvents`, { headers: { authorization: `Bearer ${fresh}` } })).json();
    expect(JSON.stringify(events)).toContain('password_reset');
    expect((await call(recoveryApi.POST, 'recovery', { action: 'reset', recoveryId: start.body.recoveryId, resetToken: v.body.resetToken, password: 'again1234' })).status).toBe(400);
  });

  it('admin suspends, reactivates, schedules deletion, restores and purges a user', async (ctx) => {
    if (!up) ctx.skip();
    const admin = await googleUser('boss@example.com', 'g-boss');
    const { uid, token } = await verifiedUser('yaw@example.com', '0243334444');
    await fsStatus(token, 'PATCH', `users/${uid}/conversations/c1`, { title: { stringValue: 'Hi' }, projectId: { nullValue: null }, saved: { booleanValue: false } });

    // non-admins are refused
    expect((await call(adminApi, 'admin', { action: 'list' }, token)).status).toBe(403);

    const list = await call(adminApi, 'admin', { action: 'list' }, admin.token);
    expect(list.status).toBe(200);
    const users = list.body.users as { uid: string; phoneMasked: string | null; status: string }[];
    const row = users.find((u) => u.uid === uid)!;
    expect(row).toMatchObject({ status: 'active', phoneMasked: '+233 •• ••• 4444' });
    expect(JSON.stringify(list.body)).not.toContain('243334444');
    expect((list.body.stats as { total: number }).total).toBe(users.length);

    // admins cannot act on themselves
    expect((await call(adminApi, 'admin', { action: 'suspend', uid: admin.uid }, admin.token)).body.error).toMatchObject({ code: 'self' });

    expect((await call(adminApi, 'admin', { action: 'suspend', uid, reason: 'testing' }, admin.token)).status).toBe(200);
    await expect(signIn('yaw@example.com')).rejects.toThrow(/USER_DISABLED/);
    expect(await fsStatus(token, 'GET', `users/${uid}/conversations/c1`)).toBe(403);
    await expect(requireAllowedUser(new Request('http://x', { headers: { authorization: `Bearer ${token}` } }))).rejects.toMatchObject({ code: 'account_suspended' });
    expect((await call(accountApi, 'account', { action: 'status' }, token)).body).toMatchObject({ accountStatus: 'suspended' });

    expect((await call(adminApi, 'admin', { action: 'reactivate', uid }, admin.token)).status).toBe(200);
    const back = (await signIn('yaw@example.com')).idToken;
    expect(await fsStatus(back, 'GET', `users/${uid}/conversations/c1`)).toBe(200);

    expect((await call(adminApi, 'admin', { action: 'delete', uid, confirmEmail: 'wrong@example.com' }, admin.token)).body.error).toMatchObject({ code: 'confirm_mismatch' });
    const del = await call(adminApi, 'admin', { action: 'delete', uid, confirmEmail: 'yaw@example.com' }, admin.token);
    expect(del.status).toBe(200);
    expect(del.body.purgeAfter).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    await expect(signIn('yaw@example.com')).rejects.toThrow(/USER_DISABLED/);
    expect((await call(adminApi, 'admin', { action: 'restore', uid }, admin.token)).status).toBe(200);
    expect(await fsStatus((await signIn('yaw@example.com')).idToken, 'GET', `users/${uid}/conversations/c1`)).toBe(200);

    // permanent deletion needs the typed email and an explicit acknowledgement
    expect((await call(adminApi, 'admin', { action: 'purge', uid, confirmEmail: 'yaw@example.com' }, admin.token)).status).toBe(400);
    expect((await call(adminApi, 'admin', { action: 'purge', uid, confirmEmail: 'yaw@example.com', acknowledge: true }, admin.token)).status).toBe(200);
    await expect(signIn('yaw@example.com')).rejects.toThrow(/EMAIL_NOT_FOUND|INVALID_LOGIN_CREDENTIALS/);
    expect((await fsGet(`users/${uid}/conversations/c1`)).fields).toBeUndefined();
    expect((await fsGet(`users/${uid}`)).fields).toBeUndefined();

    const logs = await call(adminApi, 'admin', { action: 'logs' }, admin.token);
    const actions = (logs.body.logs as { action: string }[]).map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(['user_suspended', 'user_reactivated', 'user_deletion_scheduled', 'user_restored', 'user_purged']));
  });

  it('signing out everywhere revokes the current session', async (ctx) => {
    if (!up) ctx.skip();
    const { uid, token } = await verifiedUser('abena@example.com', '0245556666');
    await new Promise((r) => setTimeout(r, 1100));
    expect((await call(accountApi, 'account', { action: 'revokeSessions' }, token)).status).toBe(200);
    expect(await fsStatus(token, 'GET', `users/${uid}`)).toBe(403);
    await new Promise((r) => setTimeout(r, 1100));
    const fresh = (await signIn('abena@example.com')).idToken;
    expect(await fsStatus(fresh, 'GET', `users/${uid}`)).toBe(200);
  });
});
