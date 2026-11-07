import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDb } from './fakeDb.js';

// Deterministic "embeddings": hashed bag of words. Similar texts get similar vectors.
const embedCalls: string[][] = [];
vi.mock('../server/embeddings.js', async (orig) => {
  const real = await orig<typeof import('../server/embeddings.js')>();
  const { terms } = await import('../server/knowledge/text.js');
  const vec = (t: string) => {
    const v = new Array(96).fill(0);
    for (const w of terms(t)) {
      let h = 0;
      for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      v[h % 96] += 1;
    }
    return v;
  };
  return {
    ...real,
    embed: async (texts: string[]) => {
      embedCalls.push(texts);
      return { model: 'test-embed', vectors: texts.map(vec) };
    },
  };
});

const { indexSource, deleteSource, kbBase } = await import('../server/knowledge/store.js');
const { retrieveKnowledge } = await import('../server/knowledge/retrieve.js');
const { addUrl, refresh, removeSource, removeCollection, mergeChunks, search } = await import('../server/knowledge/service.js');
const text = await import('../server/knowledge/text.js');
const { assertPublicUrl, fetchPage, isPrivateAddress } = await import('../server/knowledge/fetch.js');

const UID = 'alice';
const BASE = kbBase('personal', UID);
const q = (t: string) => ({ text: t });

function setup() {
  const db = new FakeDb();
  db.docs.set(`${BASE}/kbCollections/companies`, { name: 'Companies and Organizations' });
  db.docs.set(`${BASE}/kbCollections/tech`, { name: 'Technology and Programming' });
  return db;
}
function addSource(db: FakeDb, id: string, data: Record<string, unknown>) {
  db.docs.set(`${BASE}/kbSources/${id}`, { collectionId: 'companies', type: 'note', status: 'processing', ...data });
}

const SOKO = [
  { ref: '§ About', text: 'Soko Aerial is a drone services company based in Accra, Ghana. It provides aerial mapping, crop spraying and infrastructure inspection.' },
  { ref: '§ Fleet', text: 'The Soko Aerial fleet uses fixed-wing survey drones and multirotor spraying drones operated by licensed pilots.' },
];

beforeEach(() => {
  embedCalls.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('knowledge text utilities', () => {
  it('normalizes terms with light stemming and no stop words', () => {
    expect(text.terms('What services does the company offer?')).toEqual(['service', 'company', 'offer']);
    expect(text.terms('Drones and C++ in Node.js')).toEqual(['drone', 'c++', 'node.js']);
  });

  it('packs vectors into int8 without losing ranking quality', () => {
    const a = [0.1, -0.4, 0.8, 0.05, -0.2];
    const b = [0.12, -0.35, 0.7, 0.1, -0.25];
    const exact = a.reduce((s, x, i) => s + x * b[i], 0) / Math.hypot(...a) / Math.hypot(...b);
    const packed = text.cosinePacked(text.unpackVector(text.packVector(a)), Float32Array.from(b));
    expect(Math.abs(packed - exact)).toBeLessThan(0.01);
    expect(text.packVector(new Array(768).fill(0.1)).length).toBeLessThanOrEqual(1024);
  });

  it('turns HTML into heading sections without scripts, navigation or footers', () => {
    const html = `<html><head><title>Soko Aerial | Drone services</title><script>var x=1</script></head><body>
      <nav>Home About Contact</nav><h1>Our services</h1><p>Aerial mapping &amp; surveying.</p>
      <h2>Agriculture</h2><ul><li>Crop spraying</li><li>Crop health</li></ul><footer>© 2026 Soko</footer></body></html>`;
    const r = text.htmlToSections(html);
    expect(r.title).toBe('Soko Aerial | Drone services');
    expect(r.sections.map((s) => s.ref)).toEqual(['§ Our services', '§ Agriculture']);
    expect(r.sections[0].text).toBe('Aerial mapping & surveying.');
    expect(r.sections[1].text).toContain('- Crop spraying');
    const all = r.sections.map((s) => s.text).join(' ');
    expect(all).not.toMatch(/var x|Home About|© 2026/);
  });

  it('drops boilerplate lines repeated on every page', () => {
    const page = (n: number) => `ACME Confidential Report\nPage body ${n} with content.\n`;
    expect(text.cleanText([1, 2, 3, 4, 5].map(page).join(''))).not.toContain('ACME Confidential Report');
  });

  it('gives the same id to the same page regardless of tracking parameters', () => {
    expect(text.urlSourceId('https://Soko.example/about/?utm_source=x#team')).toBe(text.urlSourceId('https://soko.example/about'));
    expect(text.urlSourceId('https://soko.example/about')).not.toBe(text.urlSourceId('https://soko.example/services'));
  });

  it('rebuilds text from overlapping chunks without duplicating the overlap', () => {
    const merged = mergeChunks([
      { ref: 'p. 1', text: 'The quick brown fox jumps over the lazy dog and keeps running far away.' },
      { ref: 'p. 1', text: 'over the lazy dog and keeps running far away. Then it rests.' },
    ]);
    expect(merged).toEqual([{ ref: 'p. 1', text: 'The quick brown fox jumps over the lazy dog and keeps running far away. Then it rests.' }]);
  });
});

describe('page fetching is limited to public web pages', () => {
  it('recognizes private and local addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.10', '172.20.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1', '0.0.0.0'])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('rejects unsafe links before any request', async () => {
    const resolve = (async (host: string) => (host === 'evil.example' ? [{ address: '10.0.0.5' }] : [{ address: '93.184.216.34' }])) as never;
    await expect(assertPublicUrl('file:///etc/passwd', resolve)).rejects.toThrow(/http and https/);
    await expect(assertPublicUrl('http://localhost/admin', resolve)).rejects.toThrow(/Private/);
    await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data', resolve)).rejects.toThrow(/Private/);
    await expect(assertPublicUrl('http://evil.example/', resolve)).rejects.toThrow(/Private/);
    await expect(assertPublicUrl('http://93.184.216.34:8080/', resolve)).rejects.toThrow(/ports/);
    await expect(assertPublicUrl('https://user:pw@93.184.216.34/', resolve)).rejects.toThrow(/credentials/);
    await expect(assertPublicUrl('https://good.example/page', resolve)).resolves.toBeInstanceOf(URL);
  });

  it('re-checks every redirect and refuses non-HTML content', async () => {
    const redirect = (async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } })) as typeof fetch;
    await expect(fetchPage('http://93.184.216.34/', { fetchImpl: redirect })).rejects.toThrow(/Private/);
    const pdf = (async () => new Response('%PDF', { headers: { 'content-type': 'application/pdf' } })) as typeof fetch;
    await expect(fetchPage('http://93.184.216.34/file.pdf', { fetchImpl: pdf })).rejects.toThrow(/Upload files directly/);
    const big = (async () => new Response('x'.repeat(10), { headers: { 'content-type': 'text/html', 'content-length': String(50e6) } })) as typeof fetch;
    await expect(fetchPage('http://93.184.216.34/', { fetchImpl: big })).rejects.toThrow(/too large/);
  });
});

describe('knowledge base: indexing and retrieval', () => {
  it('7. retrieves from a manually created collection, with source labels', async () => {
    const db = setup();
    addSource(db, 'n1', { title: 'Soko Aerial notes' });
    const r = await indexSource({ db: db.asFirestore(), base: BASE, sourceId: 'n1', sections: SOKO });
    expect(r).toMatchObject({ chunkCount: 2, embedded: true, unchanged: false });
    expect(db.docs.get(`${BASE}/kbSources/n1`)).toMatchObject({ status: 'ready', chunkCount: 2, embeddingModel: 'test-embed' });
    expect(db.under(`${BASE}/kbSources/n1/index/`)).toEqual([`${BASE}/kbSources/n1/index/s0`]);

    const k = await retrieveKnowledge({ db: db.asFirestore(), uid: UID, query: q('What services does Soko Aerial offer?'), budgetTokens: 4000, sourceOffset: 0 });
    expect(k?.hit).toBe(true);
    expect(k?.sources[0]).toMatchObject({ kind: 'knowledge', site: 'Companies and Organizations' });
    expect(k?.sources[0].title).toMatch(/^Soko Aerial notes · §/);
    expect(k?.text).toMatch(/\[K1\] Companies and Organizations › Soko Aerial notes/);
    expect(k?.text).toContain('crop spraying');
  });

  it('does not inject unrelated knowledge', async () => {
    const db = setup();
    addSource(db, 'n1', { title: 'Soko Aerial notes' });
    await indexSource({ db: db.asFirestore(), base: BASE, sourceId: 'n1', sections: SOKO });
    const k = await retrieveKnowledge({ db: db.asFirestore(), uid: UID, query: q('What is the capital of France?'), budgetTokens: 4000, sourceOffset: 0 });
    expect(k?.sources).toEqual([]);
    expect(k?.hit).toBe(false);
  });

  it('6. reads a whole presentation when the question names it', async () => {
    const db = setup();
    addSource(db, 'deck', { title: 'Investor Deck.pptx', type: 'file' });
    const slides = Array.from({ length: 12 }, (_, i) => ({ ref: `Slide ${i + 1}`, text: `Slide ${i + 1} topic ${['market', 'team', 'pricing', 'roadmap'][i % 4]}. `.repeat(60) }));
    await indexSource({ db: db.asFirestore(), base: BASE, sourceId: 'deck', sections: slides });
    const k = await retrieveKnowledge({ db: db.asFirestore(), uid: UID, query: q('Summarize the investor deck'), budgetTokens: 40_000, sourceOffset: 0 });
    const refs = new Set(k?.sources.map((s) => s.title.split(' · ')[1]));
    expect(refs.size).toBe(12);
  });

  it('9. re-indexing an updated document replaces the old content', async () => {
    const db = setup();
    addSource(db, 'f1', { title: 'Pricing.docx', type: 'file' });
    const long = (fact: string) => [{ ref: 'Document', text: `${fact} `.repeat(400) }];
    await indexSource({ db: db.asFirestore(), base: BASE, sourceId: 'f1', sections: long('The basic plan costs 100 cedis per hectare.') });
    const before = (db.docs.get(`${BASE}/kbSources/f1`) as { chunkCount: number }).chunkCount;
    expect(before).toBeGreaterThan(3);
    await indexSource({ db: db.asFirestore(), base: BASE, sourceId: 'f1', sections: [{ ref: 'Document', text: 'The premium plan costs 250 cedis per hectare.' }] });
    expect(db.under(`${BASE}/kbSources/f1/chunks/`)).toHaveLength(1); // stale chunks removed
    const k = await retrieveKnowledge({ db: db.asFirestore(), uid: UID, query: q('How much does the premium plan cost?'), budgetTokens: 4000, sourceOffset: 0 });
    expect(k?.text).toContain('250 cedis');
    expect(k?.text).not.toContain('100 cedis');
  });

  it('skips re-indexing when the content has not changed', async () => {
    const db = setup();
    addSource(db, 'n1', { title: 'Soko Aerial notes' });
    await indexSource({ db: db.asFirestore(), base: BASE, sourceId: 'n1', sections: SOKO });
    embedCalls.length = 0;
    const r = await indexSource({ db: db.asFirestore(), base: BASE, sourceId: 'n1', sections: SOKO });
    expect(r.unchanged).toBe(true);
    expect(embedCalls).toHaveLength(0);
  });

  it('10. a deleted source or collection is never retrieved again', async () => {
    const db = setup();
    addSource(db, 'n1', { title: 'Soko Aerial notes' });
    await indexSource({ db: db.asFirestore(), base: BASE, sourceId: 'n1', sections: SOKO });
    const ctx = { db: db.asFirestore(), uid: UID, admin: false };
    await removeSource(ctx, { scope: 'personal', sourceId: 'n1' });
    expect(db.under(`${BASE}/kbSources/n1`)).toEqual([]);
    expect(await retrieveKnowledge({ db: db.asFirestore(), uid: UID, query: q('Soko Aerial services'), budgetTokens: 4000, sourceOffset: 0 })).toBeNull();

    addSource(db, 'n2', { title: 'Soko Aerial notes' });
    await indexSource({ db: db.asFirestore(), base: BASE, sourceId: 'n2', sections: SOKO });
    expect(await removeCollection(ctx, { scope: 'personal', collectionId: 'companies' })).toEqual({ deletedSources: 1 });
    expect(db.under(`${BASE}/kbSources/`)).toEqual([]);
  });

  it('never sends confidential sources to an AI provider unless authorized', async () => {
    const db = setup();
    addSource(db, 'c1', { title: 'Board minutes', confidential: true, aiAllowed: false });
    await indexSource({ db: db.asFirestore(), base: BASE, sourceId: 'c1', sections: [{ ref: 'p. 1', text: 'Soko Aerial board approved the Kumasi expansion.' }] });
    expect(embedCalls).toHaveLength(0); // no embeddings
    expect(db.docs.get(`${BASE}/kbSources/c1`)).toMatchObject({ status: 'ready', embeddingModel: null });
    const k = await retrieveKnowledge({ db: db.asFirestore(), uid: UID, query: q('Soko Aerial Kumasi expansion'), budgetTokens: 4000, sourceOffset: 0 });
    expect(k).toBeNull(); // filtered out before ranking

    // the user authorizes AI access, then re-indexes
    db.docs.set(`${BASE}/kbSources/c1`, { ...db.docs.get(`${BASE}/kbSources/c1`)!, aiAllowed: true });
    await refresh({ db: db.asFirestore(), uid: UID, admin: false }, { scope: 'personal', sourceId: 'c1' });
    expect(embedCalls.length).toBeGreaterThan(0);
    const k2 = await retrieveKnowledge({ db: db.asFirestore(), uid: UID, query: q('Soko Aerial Kumasi expansion'), budgetTokens: 4000, sourceOffset: 0 });
    expect(k2?.text).toContain('Kumasi');
  });

  it('11. a short follow-up finds knowledge once combined with the previous question', async () => {
    const db = setup();
    addSource(db, 'n1', { title: 'Soko Aerial notes' });
    await indexSource({ db: db.asFirestore(), base: BASE, sourceId: 'n1', sections: SOKO });
    const bare = await retrieveKnowledge({ db: db.asFirestore(), uid: UID, query: q('What drones do they use?'), budgetTokens: 4000, sourceOffset: 0 });
    const combined = await retrieveKnowledge({
      db: db.asFirestore(),
      uid: UID,
      query: q('Tell me about Soko Aerial\nWhat drones do they use?'),
      budgetTokens: 4000,
      sourceOffset: 0,
    });
    expect(combined?.text).toContain('fixed-wing survey drones');
    expect((combined?.sources.length ?? 0) >= (bare?.sources.length ?? 0)).toBe(true);
  });

  it('includes shared collections, and only admins may change them', async () => {
    const db = setup();
    db.docs.set('kb/shared/kbCollections/general', { name: 'General Knowledge' });
    db.docs.set('kb/shared/kbSources/s1', { collectionId: 'general', title: 'Company handbook', type: 'note', status: 'processing' });
    await indexSource({ db: db.asFirestore(), base: 'kb/shared', sourceId: 's1', sections: [{ ref: 'Text', text: 'Leave requests go to the Soko Aerial operations manager.' }] });
    const k = await retrieveKnowledge({ db: db.asFirestore(), uid: UID, query: q('Who handles leave requests at Soko Aerial?'), budgetTokens: 4000, sourceOffset: 0 });
    expect(k?.sources[0].site).toBe('General Knowledge (shared)');
    await expect(removeSource({ db: db.asFirestore(), uid: UID, admin: false }, { scope: 'shared', sourceId: 's1' })).rejects.toThrow(/administrators/);
  });

  it('keeps working when the shared collections cannot be read', async () => {
    const db = setup();
    db.denyPrefix = ['kb/shared'];
    addSource(db, 'n1', { title: 'Soko Aerial notes' });
    await indexSource({ db: db.asFirestore(), base: BASE, sourceId: 'n1', sections: SOKO });
    const k = await retrieveKnowledge({ db: db.asFirestore(), uid: UID, query: q('Soko Aerial services'), budgetTokens: 4000, sourceOffset: 0 });
    expect(k?.sources.length).toBeGreaterThan(0);
  });

  it('reads one index document per source, not every chunk', async () => {
    const db = setup();
    addSource(db, 'big', { title: 'Big report', type: 'file' });
    await indexSource({ db: db.asFirestore(), base: BASE, sourceId: 'big', sections: [{ ref: 'Document', text: 'Soko Aerial operations data. '.repeat(3000) }] });
    db.reads = 0;
    await retrieveKnowledge({ db: db.asFirestore(), uid: UID, query: q('unrelated question about volcanoes'), budgetTokens: 4000, sourceOffset: 0 });
    expect(db.reads).toBeLessThan(10);
  });
});

describe('knowledge base: web pages', () => {
  const page = (body: string) =>
    new Response(`<html><head><title>Soko Aerial</title></head><body><main>${body}</main></body></html>`, { headers: { 'content-type': 'text/html' } });
  const URL1 = 'http://93.184.216.34/about';

  it('8. indexes a website and retrieves it with the original link', async () => {
    const db = setup();
    vi.stubGlobal('fetch', vi.fn(async () => page(`<h1>About</h1><p>${'Soko Aerial provides drone mapping for mining companies in Ghana. '.repeat(10)}</p>`)));
    const ctx = { db: db.asFirestore(), uid: UID, admin: false };
    const r = await addUrl(ctx, { scope: 'personal', collectionId: 'companies', url: URL1 });
    expect(r).toMatchObject({ existed: false, via: 'direct', unchanged: false });
    const k = await retrieveKnowledge({ db: db.asFirestore(), uid: UID, query: q('Does Soko Aerial work with mining companies?'), budgetTokens: 4000, sourceOffset: 0 });
    expect(k?.sources[0]).toMatchObject({ url: URL1, kind: 'knowledge' });
    const found = await search(ctx, { query: 'drone mapping mining' });
    expect(found.results.length).toBeGreaterThan(0);
  });

  it('does not store the same page twice; refreshing picks up changes', async () => {
    const db = setup();
    const ctx = { db: db.asFirestore(), uid: UID, admin: false };
    let body = `<p>${'Soko Aerial offers crop spraying services across Ghana today. '.repeat(10)}</p>`;
    vi.stubGlobal('fetch', vi.fn(async () => page(body)));
    const a = await addUrl(ctx, { scope: 'personal', collectionId: 'companies', url: URL1 });
    const b = await addUrl(ctx, { scope: 'personal', collectionId: 'companies', url: URL1 + '?utm_source=x' });
    expect(b.sourceId).toBe(a.sourceId);
    expect(b).toMatchObject({ existed: true, unchanged: true });
    expect(db.under(`${BASE}/kbSources/`).filter((p) => p.split('/').length === 4)).toHaveLength(1);
    await expect(addUrl(ctx, { scope: 'personal', collectionId: 'tech', url: URL1 })).rejects.toThrow(/already in "Companies/);

    body = `<p>${'Soko Aerial now also offers drone delivery of medical supplies. '.repeat(10)}</p>`;
    const r = await refresh(ctx, { scope: 'personal', sourceId: a.sourceId });
    expect(r).toMatchObject({ unchanged: false });
    const k = await retrieveKnowledge({ db: db.asFirestore(), uid: UID, query: q('Does Soko Aerial deliver medical supplies?'), budgetTokens: 4000, sourceOffset: 0 });
    expect(k?.text).toContain('medical supplies');
  });

  it('records a failure the user can see when the page cannot be read', async () => {
    const db = setup();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })));
    const ctx = { db: db.asFirestore(), uid: UID, admin: false };
    await expect(addUrl(ctx, { scope: 'personal', collectionId: 'companies', url: URL1 })).rejects.toThrow(/HTTP 503/);
    const [path] = db.under(`${BASE}/kbSources/`);
    expect(db.docs.get(path)).toMatchObject({ status: 'failed', error: expect.stringMatching(/HTTP 503/) });
  });
});

void deleteSource;
