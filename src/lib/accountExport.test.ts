import { describe, expect, it, vi } from 'vitest';

/** In-memory stand-in for the Firestore web SDK calls the export makes. */
const store: Record<string, Record<string, unknown>> = {};
const denied = new Set<string>();

vi.mock('./firebase', () => ({ db: {} }));
vi.mock('./api', () => ({ api: vi.fn(async () => ({ ok: true })) }));
vi.mock('firebase/firestore', () => ({
  collection: (_db: unknown, ...segs: string[]) => segs.join('/'),
  doc: (_db: unknown, ...segs: string[]) => segs.join('/'),
  getDoc: async (path: string) => ({ exists: () => path in store, data: () => store[path] }),
  getDocs: async (path: string) => {
    if (denied.has(path)) throw new Error('permission-denied');
    const prefix = `${path}/`;
    const docs = Object.entries(store)
      .filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
      .map(([k, v]) => ({ id: k.slice(prefix.length), data: () => v }));
    return { docs };
  },
}));

const { buildAccountExport, plain } = await import('./accountExport');

const ts = (iso: string) => ({ toDate: () => new Date(iso) });

describe('account data export', () => {
  it('converts Firestore values to plain JSON and drops embeddings', () => {
    expect(plain({ a: ts('2026-01-02T03:04:05.000Z'), embedding: [1, 2], nested: [{ vector: 'x', b: 1 }], n: null })).toEqual({
      a: '2026-01-02T03:04:05.000Z',
      nested: [{ b: 1 }],
      n: null,
    });
  });

  it('collects the owner data, orders messages and reports what it could not read', async () => {
    store['users/u'] = { displayName: 'Ama', createdAt: ts('2026-01-01T00:00:00.000Z') };
    store['users/u/conversations/c1'] = { title: 'Alpha' };
    store['users/u/conversations/c1/messages/m2'] = { role: 'assistant', content: 'second', createdAt: '002' };
    store['users/u/conversations/c1/messages/m1'] = { role: 'user', content: 'first', createdAt: '001' };
    store['users/u/memories/x'] = { text: 'Prefers tea', embedding: [0.1] };
    store['users/u/projectMemory/p_alpha'] = { name: 'Project Alpha' };
    store['users/u/securityEvents/e1'] = { type: 'login', at: ts('2026-02-01T00:00:00.000Z') };
    store['users/u/securityEvents/e2'] = { type: 'password_changed', at: ts('2026-03-01T00:00:00.000Z') };
    store['users/other/memories/y'] = { text: 'not mine' };
    denied.add('users/u/documents');

    const out = await buildAccountExport('u');
    expect(out.format).toBe('atlas-account-export');
    expect(out.profile).toEqual({ displayName: 'Ama', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(out.conversations).toHaveLength(1);
    expect(out.conversations[0].messages.map((m: { content?: unknown }) => m.content)).toEqual(['first', 'second']);
    expect(out.memories).toEqual([{ id: 'x', text: 'Prefers tea' }]);
    expect(out.projectMemory[0]).toMatchObject({ id: 'p_alpha', name: 'Project Alpha' });
    expect(out.securityEvents.map((e: { type?: unknown }) => e.type)).toEqual(['password_changed', 'login']);
    expect(out.skipped).toEqual(['documents']);
    expect(JSON.stringify(out)).not.toContain('not mine');
  });
});
