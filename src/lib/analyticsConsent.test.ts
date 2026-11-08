import { beforeEach, describe, expect, it, vi } from 'vitest';

const fb = vi.hoisted(() => ({ init: vi.fn(), stop: vi.fn() }));
vi.mock('./firebase', () => ({ analyticsAvailable: true, initAnalytics: fb.init, stopAnalytics: fb.stop }));

class MemoryStorage {
  map = new Map<string, string>();
  getItem = (k: string) => this.map.get(k) ?? null;
  setItem = (k: string, v: string) => void this.map.set(k, v);
  removeItem = (k: string) => void this.map.delete(k);
}

/** Records every cookie write; reading returns the starting cookies. */
function fakeDocument(initial: string) {
  const writes: string[] = [];
  return {
    writes,
    doc: {
      get cookie() {
        return initial;
      },
      set cookie(v: string) {
        writes.push(v);
      },
    } as unknown as Document,
  };
}

let storage: MemoryStorage;
beforeEach(() => {
  vi.resetModules();
  fb.init.mockClear();
  fb.stop.mockClear();
  storage = new MemoryStorage();
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', fakeDocument('').doc);
  vi.stubGlobal('location', { hostname: 'chatatlasai.vercel.app' });
});

describe('analytics consent', () => {
  it('is undecided at first and never starts analytics without consent', async () => {
    const m = await import('./analyticsConsent');
    expect(m.getAnalyticsChoice()).toBeNull();
    m.startAnalyticsIfAllowed();
    expect(fb.init).not.toHaveBeenCalled();
  });

  it('allowing stores the choice and starts analytics; later visits start it again', async () => {
    const m = await import('./analyticsConsent');
    const seen = vi.fn();
    m.onAnalyticsChoice(seen);
    m.setAnalyticsChoice('granted');
    expect(storage.getItem(m.CONSENT_KEY)).toBe('granted');
    expect(fb.init).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalled();
    m.startAnalyticsIfAllowed();
    expect(fb.init).toHaveBeenCalledTimes(2);
  });

  it('declining stores the choice, stops analytics and does not start it', async () => {
    const m = await import('./analyticsConsent');
    m.setAnalyticsChoice('denied');
    expect(m.getAnalyticsChoice()).toBe('denied');
    expect(fb.stop).toHaveBeenCalled();
    m.startAnalyticsIfAllowed();
    expect(fb.init).not.toHaveBeenCalled();
  });

  it('ignores unexpected stored values and blocked storage', async () => {
    const m = await import('./analyticsConsent');
    storage.setItem(m.CONSENT_KEY, 'yes');
    expect(m.getAnalyticsChoice()).toBeNull();
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); } });
    expect(m.getAnalyticsChoice()).toBeNull();
  });

  it('removes only Google Analytics cookies, on the host and its parent domains', async () => {
    const m = await import('./analyticsConsent');
    const { doc, writes } = fakeDocument('_ga=GA1.1.1; theme=dark; _ga_ABC123=GS1.1; _gid=GA1.2');
    m.clearAnalyticsCookies(doc, 'chatatlasai.vercel.app');
    expect(writes.every((w) => /^_ga(_ABC123)?=|^_gid=/.test(w) && w.includes('expires=Thu, 01 Jan 1970'))).toBe(true);
    expect(writes.some((w) => w.startsWith('theme='))).toBe(false);
    expect(writes).toContain('_ga=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=.chatatlasai.vercel.app');
    expect(writes).toContain('_ga=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=.vercel.app');
  });
});
