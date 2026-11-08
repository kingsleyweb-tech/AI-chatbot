import { exportPKCS8, generateKeyPair } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The server's own Firebase identity (atlas-server) must keep working even if
 * someone disables it: the server re-enables it once and signs in again.
 */
describe('serverIdToken', () => {
  beforeAll(async () => {
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({ client_email: 'sa@test.iam.gserviceaccount.com', private_key: await exportPKCS8(privateKey) });
    process.env.FIREBASE_WEB_API_KEY = 'test-key';
    process.env.FIREBASE_PROJECT_ID = 'demo-test';
    delete process.env.FIRESTORE_EMULATOR_HOST;
    delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('re-enables a disabled server account and signs in again', async () => {
    const calls: string[] = [];
    let disabled = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push(url.replace(/\?.*$/, ''));
        if (url.includes('signInWithCustomToken')) {
          return disabled ? reply(400, { error: { message: 'USER_DISABLED' } }) : reply(200, { idToken: 'id-token', expiresIn: '3600' });
        }
        if (url.includes('oauth2.googleapis.com')) return reply(200, { access_token: 'oauth', expires_in: 3600 });
        if (url.endsWith('/accounts:update')) {
          expect(JSON.parse(String(init.body))).toEqual({ localId: 'atlas-server', disableUser: false });
          disabled = false;
          return reply(200, {});
        }
        throw new Error(`unexpected ${url}`);
      }),
    );
    const { serverIdToken } = await import('../server/admin.js');
    await expect(serverIdToken()).resolves.toBe('id-token');
    expect(calls.filter((c) => c.includes('signInWithCustomToken'))).toHaveLength(2);
    expect(calls.some((c) => c.endsWith('/accounts:update'))).toBe(true);
  });

  it('does not retry other sign-in failures', async () => {
    const fetchMock = vi.fn(async () => reply(400, { error: { message: 'INVALID_CUSTOM_TOKEN' } }));
    vi.stubGlobal('fetch', fetchMock);
    const { serverIdToken } = await import('../server/admin.js');
    await expect(serverIdToken()).rejects.toMatchObject({ code: 'admin_unavailable' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
