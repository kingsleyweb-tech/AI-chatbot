/**
 * The Atlas AI API (/api/v1) and its Super Admin management.
 *
 * Runs the real pipeline (authentication, CORS, end-user isolation, environment pinning,
 * idempotency, rate/concurrency limits, the chat engine, logging and the admin operations) against
 * the in-memory database. Only the outside world is scripted: the AI provider stream, the web
 * search service and the image generator.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderChunk } from '../server/providers/types.js';
import { FakeDb } from './fakeDb.js';
import { fakeModel } from './helpers.js';

const MODEL = 'gemini:gemini-3.8-flash';
const OTHER = 'openrouter/other-model:free';
const PAID = 'openrouter/paid-model';
let script: (signal: AbortSignal) => AsyncGenerator<ProviderChunk>;
let db: FakeDb;
let webResult: unknown = null;
let imageImpl: () => Promise<unknown>;

vi.mock('../server/providers/registry.js', () => ({
  getCatalog: async () => ({
    models: [
      fakeModel(MODEL, { contextLength: 100_000, free: true, pricing: { prompt: 0, completion: 0 } }),
      fakeModel(OTHER, { contextLength: 100_000, free: true }),
      fakeModel(PAID, { contextLength: 100_000, free: false }),
    ],
    defaultModel: MODEL,
    fallbackModels: [],
    paidAvailable: false,
  }),
  providerFor: () => ({ id: 'gemini', stream: (req: { signal: AbortSignal }) => script(req.signal) }),
}));
vi.mock('../server/embeddings.js', async (orig) => ({ ...(await orig<object>()), embed: async () => null }));
vi.mock('../server/admin.js', async (orig) => ({ ...(await orig<object>()), adminConfigured: () => true, adminDb: async () => db.asFirestore() }));
vi.mock('../server/search/web.js', async (orig) => ({
  ...(await orig<object>()),
  gatherWebContext: vi.fn(async (args: { options: { webSearch?: boolean } }) => (args.options.webSearch ? webResult : null)),
}));
vi.mock('../server/cloudflare/client.js', async (orig) => ({ ...(await orig<object>()), cloudflareConfigured: () => true }));
vi.mock('../server/images/generate.js', async (orig) => ({ ...(await orig<object>()), runImageTurn: vi.fn(() => imageImpl()) }));

const { handleV1, errorOf } = await import('../server/apiPlatform/router.js');
const { apiManagement, apiManagementOpSchema } = await import('../server/apiPlatform/admin.js');
const { resetAuthThrottle } = await import('../server/apiPlatform/auth.js');
const { resetBurst, dayStatsPath, readNum } = await import('../server/apiPlatform/limits.js');
const { generateKey, parseKey, hashKey } = await import('../server/apiPlatform/keys.js');
const { integrationPin } = await import('../server/apiPlatform/env.js');
const { endUserUid } = await import('../server/apiPlatform/store.js');
const { pruneApiRecords } = await import('../server/apiPlatform/log.js');
const { currentPin } = await import('../server/environments/index.js');
const { utcDay } = await import('../server/environments/index.js');
const { ImageError } = await import('../server/images/generate.js');
import type { ApiKeyView, IntegrationConfig } from '../server/shared/apiPlatform.js';

/* ------------------------------------------------------------------ helpers */

const actor = { uid: 'sa', email: 'owner@example.com' };
let bg: Promise<unknown>[];

const admin = async <T = Record<string, unknown>>(op: Record<string, unknown>) => (await apiManagement({ db: db.asFirestore(), actor }, apiManagementOpSchema.parse(op))) as T;

interface App {
  id: string;
  secret: string;
  keyId: string;
  integration: IntegrationConfig;
}
async function makeApp(config: Record<string, unknown> = {}, mode: 'live' | 'test' = 'live'): Promise<App> {
  const r = await admin<{ integration: IntegrationConfig; key: { view: ApiKeyView; secret: string } }>({
    op: 'create',
    config: { name: 'Messenger', appType: 'mobile', allowedEnvironments: ['main'], permissions: ['chat'], ...config },
    firstKey: { name: 'server', mode },
  });
  return { id: r.integration.id, secret: r.key.secret, keyId: r.key.view.id, integration: r.integration };
}

async function v1(path: string, opts: { key?: string | null; method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const method = opts.method ?? (opts.body === undefined ? 'GET' : 'POST');
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.key) headers.authorization = `Bearer ${opts.key}`;
  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    if (typeof opts.body === 'string' || opts.body instanceof Uint8Array) body = opts.body as BodyInit;
    else {
      body = JSON.stringify(opts.body);
      headers['content-type'] ??= 'application/json';
    }
  }
  const req = new Request(`https://atlas.test/api/v1/${path}`, { method, headers, body });
  return handleV1(req, path.split('?')[0], { background: (p) => bg.push(p), db: db.asFirestore() });
}
async function j(res: Response) {
  const out = (await res.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  await settle();
  return out;
}
async function settle() {
  for (let i = 0; i < 5 && bg.length; i++) {
    const now = bg.splice(0);
    await Promise.all(now.map((p) => p.catch(() => undefined)));
  }
}
async function* reply(text: string): AsyncGenerator<ProviderChunk> {
  for (const part of text.split(' ')) yield { type: 'delta', text: part + ' ' };
  yield { type: 'finish', reason: 'stop', model: MODEL };
}
function sse(text: string) {
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const ev = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      return { event: ev, data: data ? JSON.parse(data) : null };
    });
}
const todayStats = () => db.docs.get(dayStatsPath(utcDay())) as Record<string, unknown> | undefined;

beforeEach(() => {
  db = new FakeDb();
  bg = [];
  webResult = null;
  script = () => reply('Hello from Atlas');
  imageImpl = async () => ({ meta: { id: 'img1', kind: 'generate', mime: 'image/png', width: 64, height: 64, model: 'flux' }, bytes: new Uint8Array([1, 2, 3]), stored: false });
  resetAuthThrottle();
  resetBurst();
});

/* --------------------------------------------------------------------- keys */

describe('API keys', () => {
  it('are generated with a CSPRNG secret and the atlas_live_ / atlas_test_ prefixes', () => {
    const a = generateKey('live');
    const b = generateKey('test');
    expect(a.secret).toMatch(/^atlas_live_[a-f0-9]{16}_[A-Za-z0-9_-]{43}$/);
    expect(b.secret).toMatch(/^atlas_test_[a-f0-9]{16}_[A-Za-z0-9_-]{43}$/);
    expect(a.secret).not.toBe(generateKey('live').secret);
    expect(parseKey(a.secret)).toMatchObject({ mode: 'live' });
    expect(parseKey('sk-something')).toBeNull();
    expect(parseKey(a.secret.replace('atlas_live_', 'atlas_prod_'))).toBeNull();
  });

  it('only a hash is stored, and the full key is returned once, at creation', async () => {
    const app = await makeApp();
    const stored = db.docs.get(`apiKeys/${app.keyId}`)!;
    expect(stored.hash).toBe(hashKey(app.secret));
    // the secret appears nowhere in the database (keys, integration, audit trail, admin logs)
    const everything = JSON.stringify([...db.docs.entries()]);
    expect(everything).not.toContain(app.secret);
    expect(everything).not.toContain(app.secret.split('_').pop()!);
    // later views never contain the secret or the hash
    const detail = await admin<{ keys: Record<string, unknown>[] }>({ op: 'get', id: app.id });
    expect(detail.keys).toHaveLength(1);
    expect(detail.keys[0]).not.toHaveProperty('hash');
    expect(JSON.stringify(detail)).not.toContain(app.secret);
    expect(detail.keys[0].display).toMatch(/^atlas_live_[a-f0-9]{4}…[A-Za-z0-9_-]{4}$|^atlas_live_/);
  });

  it('several keys per application; at most 25 that are not revoked', async () => {
    const app = await makeApp();
    for (let i = 0; i < 24; i++) await admin({ op: 'keyCreate', integrationId: app.id, name: `k${i}`, mode: i % 2 ? 'test' : 'live' });
    await expect(admin({ op: 'keyCreate', integrationId: app.id, name: 'one too many', mode: 'live' })).rejects.toMatchObject({ status: 409 });
  });
});

/* ------------------------------------------------------------ authentication */

describe('authentication', () => {
  it('accepts a valid key (Bearer or X-Atlas-Key) and returns the standard envelope', async () => {
    const app = await makeApp();
    const res = await v1('app', { key: app.secret });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toMatch(/^req_/);
    expect(res.headers.get('atlas-api-version')).toBe('v1');
    const body = await j(res);
    expect(body).toMatchObject({ success: true, api_version: 'v1', app_id: app.id, error: null, data: { app_id: app.id, permissions: ['chat'], key: { id: app.keyId, mode: 'live' } } });
    expect(body.data.key).not.toHaveProperty('hash');
    expect(body.request_id).toBe(res.headers.get('x-request-id'));
    expect(JSON.stringify(body)).not.toContain(app.secret);

    const alt = await v1('app', { headers: { 'x-atlas-key': app.secret } });
    expect(alt.status).toBe(200);
  });

  it('refuses a missing, malformed or wrong key with 401 and a safe message', async () => {
    const app = await makeApp();
    const missing = await v1('app');
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toContain('Bearer');
    expect((await j(missing)).error.code).toBe('missing_api_key');

    expect((await j(await v1('app', { key: 'not-a-key' }))).error.code).toBe('invalid_api_key');
    // right shape and key id, wrong secret
    const forged = app.secret.slice(0, -4) + (app.secret.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    const r = await v1('app', { key: forged });
    expect(r.status).toBe(401);
    expect((await j(r)).error.code).toBe('invalid_api_key');
    // a live key presented as a test key
    expect((await v1('app', { key: app.secret.replace('atlas_live_', 'atlas_test_') })).status).toBe(401);
  });

  it('revoked and expired keys get 401, disabled keys 403', async () => {
    const app = await makeApp();
    await admin({ op: 'keySetStatus', keyId: app.keyId, status: 'disabled' });
    let r = await v1('app', { key: app.secret });
    expect(r.status).toBe(403);
    expect((await j(r)).error.code).toBe('key_disabled');

    await admin({ op: 'keySetStatus', keyId: app.keyId, status: 'active' });
    expect((await v1('app', { key: app.secret })).status).toBe(200);

    db.docs.set(`apiKeys/${app.keyId}`, { ...db.docs.get(`apiKeys/${app.keyId}`)!, expiresAt: Date.now() - 1000 });
    r = await v1('app', { key: app.secret });
    expect(r.status).toBe(401);
    expect((await j(r)).error.code).toBe('key_expired');

    db.docs.set(`apiKeys/${app.keyId}`, { ...db.docs.get(`apiKeys/${app.keyId}`)!, expiresAt: null });
    await admin({ op: 'keyRevoke', keyId: app.keyId });
    r = await v1('app', { key: app.secret });
    expect(r.status).toBe(401);
    expect((await j(r)).error.code).toBe('key_revoked');
    // a revoked key can never be turned back on
    await expect(admin({ op: 'keySetStatus', keyId: app.keyId, status: 'active' })).rejects.toMatchObject({ status: 409 });
  });

  it('too many failed attempts from one address are throttled', async () => {
    for (let i = 0; i < 20; i++) await v1('app', { key: 'atlas_live_0000000000000000_' + 'x'.repeat(43), headers: { 'x-forwarded-for': '203.0.113.9' } });
    const r = await v1('app', { key: 'whatever', headers: { 'x-forwarded-for': '203.0.113.9' } });
    expect(r.status).toBe(429);
    expect((await j(r)).error.code).toBe('too_many_auth_failures');
    // another address is unaffected
    expect((await v1('app', { headers: { 'x-forwarded-for': '198.51.100.1' } })).status).toBe(401);
  });

  it('suspension, reactivation, expiry and deletion of the application', async () => {
    const app = await makeApp();
    await admin({ op: 'setStatus', id: app.id, status: 'suspended' });
    let r = await v1('app', { key: app.secret });
    expect(r.status).toBe(403);
    expect((await j(r)).error.code).toBe('integration_suspended');

    await admin({ op: 'setStatus', id: app.id, status: 'active' });
    expect((await v1('app', { key: app.secret })).status).toBe(200);

    db.docs.set(`apiIntegrations/${app.id}`, { ...db.docs.get(`apiIntegrations/${app.id}`)!, expiresAt: Date.now() - 1 });
    r = await v1('app', { key: app.secret });
    expect((await j(r)).error.code).toBe('integration_expired');
    db.docs.set(`apiIntegrations/${app.id}`, { ...db.docs.get(`apiIntegrations/${app.id}`)!, expiresAt: null });

    await expect(admin({ op: 'delete', id: app.id, confirmName: 'wrong name' })).rejects.toMatchObject({ code: 'confirm_mismatch' });
    expect((await v1('app', { key: app.secret })).status).toBe(200);
    await admin({ op: 'delete', id: app.id, confirmName: 'Messenger' });
    expect((await v1('app', { key: app.secret })).status).toBe(401);
    expect(db.docs.get(`apiKeys/${app.keyId}`)!.status).toBe('revoked');
    const list = await admin<{ integrations: unknown[] }>({ op: 'list' });
    expect(list.integrations).toHaveLength(0);
  });
});

/* --------------------------------------------------------------- rotation */

describe('key rotation', () => {
  it('without a grace period the old key stops at once and the new one works', async () => {
    const app = await makeApp();
    const r = await admin<{ key: ApiKeyView; secret: string }>({ op: 'keyRotate', keyId: app.keyId });
    expect(r.secret).toMatch(/^atlas_live_/);
    expect(r.secret).not.toBe(app.secret);
    expect((await v1('app', { key: app.secret })).status).toBe(401);
    expect((await v1('app', { key: r.secret })).status).toBe(200);
    expect(db.docs.get(`apiKeys/${r.key.id}`)!.rotatedFrom).toBe(app.keyId);
  });

  it('with a grace period both keys work until it ends', async () => {
    const app = await makeApp();
    const r = await admin<{ key: ApiKeyView; secret: string }>({ op: 'keyRotate', keyId: app.keyId, graceMinutes: 30 });
    expect((await v1('app', { key: app.secret })).status).toBe(200);
    expect((await v1('app', { key: r.secret })).status).toBe(200);
    const old = db.docs.get(`apiKeys/${app.keyId}`)!;
    expect(old.expiresAt).toBeGreaterThan(Date.now() + 29 * 60_000);
    expect(old.expiresAt).toBeLessThanOrEqual(Date.now() + 30 * 60_000);
  });
});

/* ------------------------------------------------------------ permissions */

describe('permissions', () => {
  it('nothing is granted by default', async () => {
    const r = await admin<{ integration: IntegrationConfig }>({ op: 'create', config: { name: 'Bare', appType: 'web', allowedEnvironments: ['main'] }, firstKey: { name: 'k', mode: 'live' } });
    expect(r.integration.permissions).toEqual([]);
  });

  it('each feature is refused with 403 permission_denied unless granted', async () => {
    const app = await makeApp({ permissions: [] });
    const cases: [string, { method?: string; body?: unknown }, string][] = [
      ['models', {}, 'chat'],
      ['chat', { body: { message: 'hi' } }, 'chat'],
      ['images', { body: { prompt: 'a red bicycle' } }, 'images'],
      ['research', { body: { query: 'atlas ai', mode: 'search' } }, 'research'],
      ['documents', {}, 'documents'],
      ['conversations', {}, 'conversations_read'],
      ['memory', {}, 'memory'],
      ['voice/speech', { body: { text: 'hello' } }, 'voice_tts'],
    ];
    for (const [path, o, perm] of cases) {
      const r = await v1(path, { key: app.secret, ...o });
      const body = await j(r);
      expect([path, r.status, body.error?.code, body.error?.details?.permission]).toEqual([path, 403, 'permission_denied', perm]);
    }
    // nothing ran: no conversation, no image, no document was created
    expect(db.under('users/').length).toBe(0);
    // denials are counted for analytics
    expect(readNum(todayStats(), 'total.denied')).toBe(cases.length);
  });

  it('streaming needs chat_stream; model choice needs models; deep research needs research', async () => {
    const app = await makeApp({ permissions: ['chat'] });
    let r = await v1('chat', { key: app.secret, body: { message: 'hi', stream: true } });
    expect((await j(r)).error).toMatchObject({ code: 'permission_denied', details: { permission: 'chat_stream' } });
    r = await v1('chat', { key: app.secret, body: { message: 'hi', model: OTHER } });
    expect((await j(r)).error).toMatchObject({ code: 'permission_denied', details: { permission: 'models' } });
    // "auto" never needs the models permission
    r = await v1('chat', { key: app.secret, body: { message: 'hi', model: 'auto' } });
    expect(r.status).toBe(200);
  });

  it('a permission without its prerequisite is refused by the server', async () => {
    await expect(admin({ op: 'create', config: { name: 'Odd', appType: 'web', allowedEnvironments: ['main'], permissions: ['chat_stream'] } })).rejects.toMatchObject({ code: 'bad_permissions' });
    await expect(admin({ op: 'create', config: { name: 'Odd', appType: 'web', allowedEnvironments: ['main'], permissions: ['made_up'] } })).rejects.toThrow();
  });

  it('only free, allowed models can be selected', async () => {
    const app = await makeApp({ permissions: ['chat', 'models'], allowedModels: [MODEL] });
    let r = await v1('chat', { key: app.secret, body: { message: 'hi', model: OTHER } });
    expect((await j(r)).error.code).toBe('model_not_allowed');
    const open = await makeApp({ name: 'Open', permissions: ['chat', 'models'] });
    r = await v1('chat', { key: open.secret, body: { message: 'hi', model: PAID } });
    expect((await j(r)).error.code).toBe('model_unavailable');
    const models = await j(await v1('models', { key: open.secret }));
    expect(models.data.models.map((m: { id: string }) => m.id)).toEqual([MODEL, OTHER]);
    expect(models.data.selectable).toBe(true);
  });
});

/* --------------------------------------------------------------------- chat */

describe('chat', () => {
  it('a reply with a new conversation, then a follow-up in the same conversation', async () => {
    const app = await makeApp({ permissions: ['chat', 'conversations_read'] });
    const r = await v1('chat', { key: app.secret, body: { message: 'Hello' }, headers: { 'x-atlas-user': 'alice' } });
    expect(r.status).toBe(200);
    const body = await j(r);
    expect(body).toMatchObject({ success: true, data: { content: 'Hello from Atlas ', model: MODEL, error: null } });
    const cid = body.conversation_id as string;
    expect(cid).toMatch(/^conv_[a-f0-9]{16}$/);
    expect(body.data.conversation_id).toBe(cid);

    script = () => reply('Second answer');
    const again = await j(await v1('chat', { key: app.secret, body: { message: 'And again', conversation_id: cid }, headers: { 'x-atlas-user': 'alice' } }));
    expect(again.conversation_id).toBe(cid);

    const conv = await j(await v1(`conversations/${cid}`, { key: app.secret, headers: { 'x-atlas-user': 'alice' } }));
    expect(conv.data.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(conv.data.messages[3].content.trim()).toBe('Second answer');
  });

  it('streams Server-Sent Events as they are produced (meta first, then deltas and done)', async () => {
    const app = await makeApp({ permissions: ['chat', 'chat_stream'] });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    script = async function* () {
      yield { type: 'delta', text: 'first ' };
      await gate;
      yield { type: 'delta', text: 'second' };
      yield { type: 'finish', reason: 'stop', model: MODEL };
    };
    const res = await v1('chat', { key: app.secret, body: { message: 'Hi', stream: true } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let seen = '';
    // the first delta arrives while the provider is still waiting: nothing is buffered
    while (!seen.includes('first')) seen += dec.decode((await reader.read()).value);
    expect(seen).not.toContain('second');
    expect(seen.startsWith('event: meta')).toBe(true);
    release();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += dec.decode(value);
    }
    await settle();
    const events = sse(seen);
    expect(events[0]).toMatchObject({ event: 'meta', data: { app_id: app.id } });
    expect(events.map((e) => e.event)).toContain('done');
    expect(events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('')).toBe('first second');
  });

  it('a provider failure is reported safely (no internal names) and counted', async () => {
    const app = await makeApp();
    const { ProviderError } = await import('../server/providers/types.js');
    // eslint-disable-next-line require-yield -- a provider that fails before producing anything
    script = async function* () {
      throw new ProviderError('not_configured', 'Set OPENROUTER_API_KEY in the server environment', 503);
    };
    const r = await v1('chat', { key: app.secret, body: { message: 'Hi' } });
    const body = await j(r);
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(body.success).toBe(false);
    expect(JSON.stringify(body)).not.toContain('OPENROUTER');
    expect(readNum(todayStats(), 'total.providerErrors')).toBe(1);
  });

  it('API use never touches the website’s user allowances', async () => {
    const app = await makeApp();
    await j(await v1('chat', { key: app.secret, body: { message: 'Hi' }, headers: { 'x-atlas-user': 'alice' } }));
    expect(db.under('usage').length + db.under('usageAccounts').length).toBe(0);
    const euid = endUserUid(app.id, 'alice');
    expect(db.under(`users/${euid}/conversations`).length).toBeGreaterThan(0);
    expect(readNum(todayStats(), `apps.${app.id}.requests`)).toBe(1);
  });

  it('input larger than the application’s limit is refused with 413', async () => {
    const app = await makeApp({ profile: 'restricted' });
    const r = await v1('chat', { key: app.secret, body: { message: 'x'.repeat(4_001) } });
    expect(r.status).toBe(413);
  });
});

/* --------------------------------------------------------------- isolation */

describe('isolation', () => {
  it('applications and end users never see each other’s data', async () => {
    const perms = ['chat', 'conversations_read', 'conversations_delete'];
    const a = await makeApp({ permissions: perms });
    const b = await makeApp({ name: 'Other app', permissions: perms });
    const made = await j(await v1('chat', { key: a.secret, body: { message: 'secret plans' }, headers: { 'x-atlas-user': 'alice' } }));
    const cid = made.conversation_id as string;

    // the same application, another end user
    expect((await v1(`conversations/${cid}`, { key: a.secret, headers: { 'x-atlas-user': 'bob' } })).status).toBe(404);
    expect((await j(await v1('conversations', { key: a.secret, headers: { 'x-atlas-user': 'bob' } }))).data.conversations).toEqual([]);
    // another application, even with the same end-user id
    expect((await v1(`conversations/${cid}`, { key: b.secret, headers: { 'x-atlas-user': 'alice' } })).status).toBe(404);
    expect((await v1(`conversations/${cid}`, { key: b.secret, method: 'DELETE', headers: { 'x-atlas-user': 'alice' } })).status).toBe(404);
    // continuing someone else's conversation is refused too
    expect((await v1('chat', { key: b.secret, body: { message: 'hi', conversation_id: cid }, headers: { 'x-atlas-user': 'alice' } })).status).toBe(404);
    // the owner still sees it
    expect((await v1(`conversations/${cid}`, { key: a.secret, headers: { 'x-atlas-user': 'alice' } })).status).toBe(200);
    expect(endUserUid(a.id, 'alice')).not.toBe(endUserUid(b.id, 'alice'));
  });

  it('end-user ids cannot reach outside the application’s space', async () => {
    const app = await makeApp({ permissions: ['chat', 'conversations_read'] });
    for (const bad of ['../users/admin', 'a/b', 'x'.repeat(129), 'name with space']) {
      const r = await v1('conversations', { key: app.secret, headers: { 'x-atlas-user': bad } });
      expect([bad, r.status]).toEqual([bad, 400]);
    }
    // a website user's id is just an opaque label: it maps into the application's own space
    await j(await v1('chat', { key: app.secret, body: { message: 'hi' }, headers: { 'x-atlas-user': 'u1' } }));
    expect(db.under('users/u1/').length).toBe(0);
  });
});

/* ------------------------------------------------------------------ limits */

describe('limits', () => {
  // per-minute windows: start each test early in a UTC minute so a boundary cannot fall between requests
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t = new Date();
    t.setUTCSeconds(5, 0);
    vi.setSystemTime(t);
  });
  afterEach(() => vi.useRealTimers());

  it('a per-minute limit answers 429 with Retry-After and rate-limit headers, without overcounting', async () => {
    const app = await makeApp({ profile: 'custom', limits: { requestsPerMinute: 2 } });
    const ok = await v1('app', { key: app.secret });
    expect(ok.headers.get('x-ratelimit-limit')).toBe('2');
    expect(ok.headers.get('x-ratelimit-remaining')).toBe('1');
    expect((await v1('app', { key: app.secret })).status).toBe(200);
    const r = await v1('app', { key: app.secret });
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    const body = await j(r);
    expect(body.error.code).toBe('rate_limited');
    expect(body.rate_limit).toMatchObject({ limit: 2, remaining: 0 });
    // the refused request was rolled back
    const rate = [...db.docs.entries()].find(([p]) => p.startsWith('apiRate/'))![1];
    expect(Object.entries(rate).filter(([k]) => k.startsWith('i.m')).map(([, v]) => v)).toEqual([2]);
    expect(readNum(todayStats(), 'total.rateLimited')).toBe(1);
  });

  it('daily and monthly limits', async () => {
    const day = await makeApp({ profile: 'custom', limits: { requestsPerDay: 1 } });
    expect((await v1('app', { key: day.secret })).status).toBe(200);
    expect((await j(await v1('app', { key: day.secret }))).error).toMatchObject({ code: 'rate_limited' });
    const month = await makeApp({ name: 'Monthly', profile: 'custom', limits: { requestsPerMonth: 1 } });
    expect((await v1('app', { key: month.secret })).status).toBe(200);
    expect((await v1('app', { key: month.secret })).status).toBe(429);
  });

  it('key limits apply on top of the application’s limits, per key', async () => {
    const app = await makeApp({ profile: 'unlimited' });
    const k = await admin<{ key: ApiKeyView; secret: string }>({ op: 'keyCreate', integrationId: app.id, name: 'tight', mode: 'live', limits: { requestsPerMinute: 1 } });
    expect((await v1('app', { key: k.secret })).status).toBe(200);
    expect((await v1('app', { key: k.secret })).status).toBe(429);
    // the application's other key is not affected
    expect((await v1('app', { key: app.secret })).status).toBe(200);
  });

  it('concurrency: a running stream holds a slot until it ends', async () => {
    const app = await makeApp({ permissions: ['chat', 'chat_stream'], profile: 'custom', limits: { maxConcurrent: 1 } });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    script = async function* () {
      yield { type: 'delta', text: 'working ' };
      await gate;
      yield { type: 'finish', reason: 'stop', model: MODEL };
    };
    const first = await v1('chat', { key: app.secret, body: { message: 'long', stream: true } });
    const busy = await v1('app', { key: app.secret });
    expect(busy.status).toBe(429);
    // (not j(): the first reply's background save is still waiting for its stream)
    expect(((await busy.json()) as { error: { code: string } }).error.code).toBe('concurrency_limit');
    release();
    await first.text();
    await settle();
    expect((await v1('app', { key: app.secret })).status).toBe(200);
  });

  it('feature limits: images per day, with the unit given back when generation fails', async () => {
    const app = await makeApp({ permissions: ['images'], profile: 'custom', limits: { imagesPerDay: 1 } });
    imageImpl = async () => {
      throw new ImageError('provider_error', 'upstream said no', true);
    };
    const failed = await v1('images', { key: app.secret, body: { prompt: 'a red bicycle' } });
    expect(failed.status).toBeGreaterThanOrEqual(500);
    imageImpl = async () => ({ meta: { id: 'img1', kind: 'generate', mime: 'image/png', width: 64, height: 64, model: 'flux' }, bytes: new Uint8Array([1, 2, 3]), stored: false });
    const ok = await v1('images', { key: app.secret, body: { prompt: 'a red bicycle' } });
    expect(ok.status).toBe(201);
    expect((await j(ok)).data.image.data_url).toBe('data:image/png;base64,AQID');
    const over = await j(await v1('images', { key: app.secret, body: { prompt: 'another one' } }));
    expect(over.error.code).toBe('feature_limit');
  });

  it('profiles: Unlimited removes quotas but keeps the hard safeguards', async () => {
    const app = await makeApp({ profile: 'unlimited' });
    expect(app.integration.limits.requestsPerDay).toBeNull();
    expect(app.integration.limits.maxInputChars).toBeNull();
    const r = await v1('chat', { key: app.secret, body: { message: 'x'.repeat(100_001) } });
    expect(r.status).toBe(413);
  });
});

/* ------------------------------------------------------------- idempotency */

describe('idempotency', () => {
  it('a retried request with the same key returns the stored result and does not run twice', async () => {
    const app = await makeApp({ permissions: ['chat', 'conversations_read'] });
    const h = { 'idempotency-key': 'create-conv-0001' };
    const first = await j(await v1('conversations', { key: app.secret, body: { title: 'Trip' }, headers: h }));
    const again = await v1('conversations', { key: app.secret, body: { title: 'Trip' }, headers: h });
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    const second = await j(again);
    expect(second.conversation_id).toBe(first.conversation_id);
    expect((await j(await v1('conversations', { key: app.secret }))).data.conversations).toHaveLength(1);
    // the same key with a different body is refused
    const other = await v1('conversations', { key: app.secret, body: { title: 'Other' }, headers: h });
    expect(other.status).toBe(422);
    expect((await j(other)).error.code).toBe('idempotency_mismatch');
    // a malformed key is refused
    expect((await v1('conversations', { key: app.secret, body: { title: 'x' }, headers: { 'idempotency-key': 'short' } })).status).toBe(400);
  });
});

/* -------------------------------------------------------- other capabilities */

describe('capabilities', () => {
  it('web search returns sources; nothing found gives the unit back', async () => {
    const app = await makeApp({ permissions: ['research'], profile: 'custom', limits: { researchPerDay: 1 } });
    webResult = {
      sources: [{ index: 1, kind: 'web', title: 'Atlas', url: 'https://example.com/a', snippet: 's', site: 'example.com' }],
      text: '...',
      info: { status: 'ok', query: 'atlas', provider: 'tavily' },
      steps: [],
      notices: [],
      failure: null,
    };
    const r = await j(await v1('research', { key: app.secret, body: { query: 'atlas', mode: 'search' } }));
    expect(r.data).toMatchObject({ status: 'ok', sources: [{ title: 'Atlas', url: 'https://example.com/a' }] });
    expect((await j(await v1('research', { key: app.secret, body: { query: 'atlas', mode: 'search' } }))).error.code).toBe('feature_limit');

    const empty = await makeApp({ name: 'Empty', permissions: ['research'], profile: 'custom', limits: { researchPerDay: 1 } });
    webResult = { ...(webResult as object), sources: [], info: { status: 'empty', query: 'zzz', provider: 'tavily' } };
    await j(await v1('research', { key: empty.secret, body: { query: 'zzz', mode: 'search' } }));
    webResult = { ...(webResult as object), sources: [{ index: 1, kind: 'web', title: 'T', url: 'https://example.com', snippet: null }], info: { status: 'ok', query: 'q', provider: 'tavily' } };
    expect((await v1('research', { key: empty.secret, body: { query: 'zzz', mode: 'search' } })).status).toBe(200);
  });

  it('deep research needs its own permission', async () => {
    const app = await makeApp({ permissions: ['chat', 'research'] });
    const r = await j(await v1('research', { key: app.secret, body: { query: 'history of Accra', mode: 'deep' } }));
    expect(r.error).toMatchObject({ code: 'permission_denied', details: { permission: 'deep_research' } });
  });

  it('documents: upload text, list, read, refuse binary formats, delete', async () => {
    const app = await makeApp({ permissions: ['documents'] });
    const up = await v1('documents', { key: app.secret, body: { name: 'notes.txt', text: 'Kumasi is in the Ashanti Region. '.repeat(20) } });
    expect(up.status).toBe(201);
    const doc = (await j(up)).data.document;
    expect(doc.id).toMatch(/^doc_[a-f0-9]{16}$/);
    expect((await j(await v1('documents', { key: app.secret }))).data.documents).toHaveLength(1);
    expect((await j(await v1(`documents/${doc.id}`, { key: app.secret }))).data.document.status).toBe('ready');
    // other applications cannot see it
    const other = await makeApp({ name: 'Other', permissions: ['documents'] });
    expect((await v1(`documents/${doc.id}`, { key: other.secret })).status).toBe(404);

    const pdf = await v1('documents', { key: app.secret, body: { name: 'a.pdf', mime: 'application/pdf', content_base64: 'JVBERi0xLjQ=' } });
    expect(pdf.status).toBe(415);
    const big = await makeApp({ name: 'Small', permissions: ['documents'], profile: 'restricted' });
    expect((await v1('documents', { key: big.secret, body: { name: 'big.txt', text: 'x'.repeat(100_001) } })).status).toBe(413);

    expect((await v1(`documents/${doc.id}`, { key: app.secret, method: 'DELETE' })).status).toBe(200);
    expect((await v1(`documents/${doc.id}`, { key: app.secret })).status).toBe(404);
  });

  it('memory: list and delete only the end user’s own memories', async () => {
    const app = await makeApp({ permissions: ['memory'] });
    const euid = endUserUid(app.id, 'alice');
    db.docs.set(`users/${euid}/memories/m1`, { text: 'Likes jollof', category: 'preference', active: true });
    db.docs.set(`users/${endUserUid(app.id, 'bob')}/memories/m2`, { text: 'Bob fact' });
    const list = await j(await v1('memory', { key: app.secret, headers: { 'x-atlas-user': 'alice' } }));
    expect(list.data.memories.map((m: { text: string }) => m.text)).toEqual(['Likes jollof']);
    expect((await v1('memory/m2', { key: app.secret, method: 'DELETE', headers: { 'x-atlas-user': 'alice' } })).status).toBe(404);
    expect((await j(await v1('memory', { key: app.secret, method: 'DELETE', headers: { 'x-atlas-user': 'alice' } }))).data.deleted).toBe(1);
    expect(db.docs.has(`users/${endUserUid(app.id, 'bob')}/memories/m2`)).toBe(true);
  });

  it('voice transcription refuses non-audio and empty uploads before any provider call', async () => {
    const app = await makeApp({ permissions: ['voice_stt'] });
    expect((await v1('voice/transcriptions', { key: app.secret, body: 'hello', headers: { 'content-type': 'text/plain' } })).status).toBe(415);
    expect((await v1('voice/transcriptions', { key: app.secret, body: new Uint8Array(10), headers: { 'content-type': 'audio/mpeg' } })).status).toBe(400);
  });

  it('unknown endpoints and methods are 404', async () => {
    const app = await makeApp();
    expect((await v1('nope', { key: app.secret })).status).toBe(404);
    expect((await v1('chat', { key: app.secret })).status).toBe(404);
    expect((await v1('a/b/c/d/e', { key: app.secret })).status).toBe(404);
  });
});

/* ------------------------------------------------------------ environments */

describe('environments', () => {
  it('an application not allowed in the current environment is refused, never moved elsewhere', async () => {
    const app = await makeApp({ allowedEnvironments: ['temporary'], environment: { live: 'active', test: 'active' } });
    const r = await v1('chat', { key: app.secret, body: { message: 'hi' } });
    expect(r.status).toBe(503);
    expect((await j(r)).error.code).toBe('environment_not_permitted');
  });

  it('a fixed choice only uses the chosen environment; providers without it are switched off', () => {
    const base = currentPin();
    const integration = { allowedEnvironments: ['temporary'], environment: { live: 'temporary', test: 'temporary' } } as unknown as IntegrationConfig;
    const { pin } = integrationPin(integration, 'live', base);
    for (const [p, e] of Object.entries(pin.config.providers)) {
      // a provider without a Temporary environment would fall back to Main: it is disabled instead
      if (e !== 'temporary') expect(pin.config.disabled[p as keyof typeof pin.config.disabled]).toContain(e);
    }
    // the global configuration is not changed
    expect(base.config.disabled).toEqual(currentPin().config.disabled);
  });

  it('the environment can be checked against what is allowed when saving', async () => {
    await expect(admin({ op: 'create', config: { name: 'Bad', appType: 'web', allowedEnvironments: ['main'], environment: { live: 'temporary', test: 'active' } } })).rejects.toMatchObject({ code: 'bad_environment' });
  });

  it('logs record which environment served the request', async () => {
    const app = await makeApp();
    await j(await v1('app', { key: app.secret }));
    const log = [...db.docs.entries()].find(([p]) => p.startsWith('apiLogs/'))![1];
    expect(log).toMatchObject({ integrationId: app.id, keyId: app.keyId, method: 'GET', endpoint: '/v1/app', status: 200, environment: 'main', source: 'api' });
  });
});

/* -------------------------------------------------------------------- CORS */

describe('CORS', () => {
  it('browser requests only from allowed origins', async () => {
    const app = await makeApp({ allowedOrigins: ['https://chat.example.com'] });
    const ok = await v1('app', { key: app.secret, headers: { origin: 'https://chat.example.com' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://chat.example.com');
    const bad = await v1('app', { key: app.secret, headers: { origin: 'https://evil.example' } });
    expect(bad.status).toBe(403);
    expect((await j(bad)).error.code).toBe('origin_not_allowed');
    // no allowed origins: server-to-server only
    const server = await makeApp({ name: 'Server only' });
    expect((await v1('app', { key: server.secret, headers: { origin: 'https://chat.example.com' } })).status).toBe(403);
    expect((await v1('app', { key: server.secret })).status).toBe(200);
  });

  it('accepts the Atlas AI site itself (developer sandbox) but not look-alike hosts', async () => {
    const server = await makeApp({ name: 'Server only' });
    const same = await v1('app', { key: server.secret, headers: { origin: 'https://chatatlasai.vercel.app', host: 'chatatlasai.vercel.app' } });
    expect(same.status).toBe(200);
    expect(same.headers.get('access-control-allow-origin')).toBeNull();
    const lookalike = await v1('app', { key: server.secret, headers: { origin: 'https://chatatlasai.vercel.app.evil.example', host: 'chatatlasai.vercel.app' } });
    expect(lookalike.status).toBe(403);
  });
});

/* ------------------------------------------------- admin: audit, analytics */

describe('administration', () => {
  it('every change is audited with before and after, failures included', async () => {
    const app = await makeApp();
    await admin({ op: 'update', id: app.id, version: app.integration.version, config: { name: 'Messenger 2', appType: 'mobile', allowedEnvironments: ['main'], permissions: ['chat', 'images'] } });
    await expect(admin({ op: 'update', id: app.id, version: app.integration.version, config: { name: 'Stale', appType: 'mobile', allowedEnvironments: ['main'] } })).rejects.toMatchObject({ status: 409 });
    await expect(admin({ op: 'delete', id: app.id, confirmName: 'nope' })).rejects.toMatchObject({ code: 'confirm_mismatch' });
    const { rows } = await admin<{ rows: { action: string; success: boolean; before: any; after: any; adminEmail: string }[] }>({ op: 'audit', integrationId: app.id }); // eslint-disable-line @typescript-eslint/no-explicit-any
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['api_integration_created', 'api_key_created', 'api_integration_updated']));
    const upd = rows.find((r) => r.action === 'api_integration_updated')!;
    expect(upd).toMatchObject({ success: true, adminEmail: 'owner@example.com', before: { name: 'Messenger', permissions: ['chat'] }, after: { name: 'Messenger 2', permissions: ['chat', 'images'] } });
    // the admin log has the same actions under the API group
    expect([...db.docs.keys()].some((p) => p.startsWith('adminLogs/'))).toBe(true);
    // no secret or hash in the audit trail
    expect(JSON.stringify(rows)).not.toContain(db.docs.get(`apiKeys/${app.keyId}`)!.hash as string);
  });

  it('the overview, analytics and activity reflect requests without storing content', async () => {
    const app = await makeApp({ permissions: ['chat'] });
    await j(await v1('chat', { key: app.secret, body: { message: 'my private prompt' } }));
    await j(await v1('images', { key: app.secret, body: { prompt: 'a red bicycle' } }));
    // an unknown key: counted, but no log row (scanners cannot fill the activity log)
    await j(await v1('models', { key: 'atlas_live_0000000000000000_' + 'x'.repeat(43) }));
    const o = await admin<{ totals: Record<string, number>; today: Record<string, number> }>({ op: 'overview' });
    expect(o.totals).toMatchObject({ integrations: 1, active: 1, activeKeys: 1, connectedApps: 1 });
    expect(o.today).toMatchObject({ ok: 1, failed: 2 });
    const a = await admin<{ features: { feature: string; requests: number }[]; apps: { integrationId: string; requests: number }[] }>({ op: 'analytics', days: 7 });
    expect(a.features.find((f) => f.feature === 'chat')!.requests).toBe(1);
    expect(a.apps[0]).toMatchObject({ integrationId: app.id, requests: 2, failed: 1 });
    const act = await admin<{ rows: { method: string; endpoint: string; status: number }[] }>({ op: 'activity', filter: { integrationId: app.id } });
    expect(act.rows.map((r) => [r.method, r.endpoint, r.status])).toContainEqual(['POST', '/v1/chat', 200]);
    const failed = await admin<{ rows: unknown[] }>({ op: 'activity', filter: { status: 'failed' } });
    expect(failed.rows.length).toBe(1);
    // logs and stats never hold prompts or keys
    const stored = JSON.stringify([...db.docs.entries()].filter(([p]) => /^api(Logs|Stats|Rate|Conc|Idem)\//.test(p)));
    expect(stored).not.toContain('my private prompt');
    expect(stored).not.toContain(app.secret);
  });

  it('the test console runs through the real pipeline without the key secret', async () => {
    const app = await makeApp({ permissions: ['chat'] });
    const r = await admin<{ status: number; body: string; requestId: string }>({ op: 'test', integrationId: app.id, keyId: app.keyId, endpoint: 'chat', input: 'ping' });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ success: true, data: { content: 'Hello from Atlas ' } });
    await settle();
    const log = [...db.docs.values()].find((d) => d.requestId === r.requestId);
    expect(log).toMatchObject({ source: 'admin_test' });
    // a suspended integration cannot be tested either
    await admin({ op: 'setStatus', id: app.id, status: 'suspended' });
    await expect(admin({ op: 'test', integrationId: app.id, keyId: app.keyId, endpoint: 'app' })).rejects.toMatchObject({ status: 403 });
  });

  it('old request records are pruned', async () => {
    const app = await makeApp();
    await j(await v1('app', { key: app.secret }));
    const n = await pruneApiRecords(db.asFirestore(), Date.now() + 40 * 86_400_000);
    expect(n.apiLogs).toBeGreaterThanOrEqual(1);
    expect(db.under('apiLogs/').length).toBe(0);
  });

  it('errors from inside the service are never shown in detail', () => {
    const e = errorOf(new Error('Firestore said: projects/atlas/databases token=abc'));
    expect(e.status).toBe(500);
    expect(e.message).not.toContain('token');
  });
});
