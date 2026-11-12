import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { APP_HEARTBEAT_MS, IDLE_LIMIT_MS, IDLE_WARN_MS, idleState, signOutDestination } from '../src/lib/idle.js';

const MIN = 60_000;
const web = { installedApp: false, appAliveAt: 0 };

describe('website inactivity', () => {
  const t0 = 1_800_000_000_000;
  it('warns at 55 minutes and expires at 60', () => {
    expect(IDLE_WARN_MS).toBe(55 * MIN);
    expect(IDLE_LIMIT_MS).toBe(60 * MIN);
    expect(idleState(t0 + 54 * MIN, t0, web)).toBe('active');
    expect(idleState(t0 + 55 * MIN, t0, web)).toBe('warn');
    expect(idleState(t0 + 59 * MIN + 59_000, t0, web)).toBe('warn');
    expect(idleState(t0 + 60 * MIN, t0, web)).toBe('expired');
  });
  it('coming back after sleep or a closed browser past the deadline expires at once', () => {
    expect(idleState(t0 + 5 * 60 * MIN, t0, web)).toBe('expired');
  });
  it('the installed app is never signed out for inactivity', () => {
    expect(idleState(t0 + 24 * 60 * MIN, t0, { installedApp: true, appAliveAt: 0 })).toBe('exempt');
  });
  it('website tabs do not sign out while an installed-app window on the device is open', () => {
    const now = t0 + 2 * 60 * MIN;
    expect(idleState(now, t0, { installedApp: false, appAliveAt: now - 30_000 })).toBe('exempt');
    // the app window closed: its heartbeat goes stale and the website timeout applies again
    expect(idleState(now, t0, { installedApp: false, appAliveAt: now - APP_HEARTBEAT_MS })).toBe('expired');
  });
  it('unavailable storage (no timestamp) never causes a sign-out loop', () => {
    expect(idleState(t0, 0, web)).toBe('active');
  });
});

describe('where a sign-out lands', () => {
  it('the website goes to the public home page with the reason', () => {
    expect(signOutDestination('user', false)).toBe('/?signedOut=user');
    expect(signOutDestination('inactivity', false)).toBe('/?signedOut=inactivity');
    expect(signOutDestination('revoked', false)).toBe('/?signedOut=revoked');
    expect(signOutDestination('device', false)).toBe('/?signedOut=device');
  });
  it('the installed app opens the sign-in form (it has no public pages)', () => {
    expect(signOutDestination('user', true)).toBe('/login');
    expect(signOutDestination('inactivity', true)).toBe('/login?reason=inactivity');
    expect(signOutDestination('device', true)).toBe('/login?reason=device');
  });
});

describe('security headers', () => {
  const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as { headers: { source: string; headers: { key: string; value: string }[] }[] };
  const all = vercel.headers.flatMap((h) => h.headers.map((x) => ({ ...x, source: h.source })));
  const csp = all.find((h) => h.key === 'Content-Security-Policy')!;

  it('has a CSP that allows the inline theme script by hash only', () => {
    const html = readFileSync('index.html', 'utf8');
    const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(inline).toHaveLength(1);
    const hash = `'sha256-${createHash('sha256').update(inline[0]).digest('base64')}'`;
    expect(csp.value).toContain(hash);
    expect(csp.value).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp.value).not.toMatch(/script-src[^;]*'unsafe-eval'/);
  });
  it('blocks plugins, base hijacking and framing by other sites', () => {
    for (const d of ["object-src 'none'", "base-uri 'self'", "frame-ancestors 'self'", "form-action 'self'"]) expect(csp.value).toContain(d);
  });
  it('leaves the proxied Firebase sign-in handler (/__/auth) on its own policy', () => {
    expect(csp.source).toBe('/((?!__/).*)');
  });
  it('sends HSTS, nosniff, referrer and permissions policies', () => {
    const keys = all.map((h) => h.key);
    for (const k of ['Strict-Transport-Security', 'X-Content-Type-Options', 'Referrer-Policy', 'Permissions-Policy', 'X-Frame-Options']) expect(keys).toContain(k);
  });
});
