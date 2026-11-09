import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../server/config/limits.js';
import { canonicalUrl, cleanTitle, gatherNews, newsBrief } from '../server/news/discover.js';
import { checkDate, parseDate, urlDate } from '../server/news/dates.js';
import { detectNews, windowFor } from '../server/news/freshness.js';
import { parseFeed, setFeedFetch } from '../server/news/rss.js';
import { DEFAULT_FEEDS, feedsFor, tierOf, type FeedDef } from '../server/news/sources.js';
import { SearchService, type Providers } from '../server/search/router.js';
import { MemorySearchStore } from '../server/search/store.js';
import type { SearchOptions, SearchResponse } from '../server/search/types.js';

const NOW = Date.UTC(2026, 10, 9, 10, 0); // 9 Nov 2026 10:00 UTC
const H = 3_600_000;
const D = 24 * H;

describe('publication dates', () => {
  it('resolves relative dates at retrieval time and parses common formats', () => {
    expect(parseDate('3 minutes ago', NOW)).toBe(NOW - 3 * 60_000);
    expect(parseDate('an hour ago', NOW)).toBe(NOW - H);
    expect(parseDate('2 days ago', NOW)).toBe(NOW - 2 * D);
    expect(parseDate('Sun, 08 Nov 2026 23:34:18 GMT', NOW)).toBe(Date.UTC(2026, 10, 8, 23, 34, 18));
    expect(parseDate('2026-11-09T01:26:09Z', NOW)).toBe(Date.UTC(2026, 10, 9, 1, 26, 9));
    expect(parseDate('Fri, 06 Nov 26 12:00:00 +0000', NOW)).toBe(Date.UTC(2026, 10, 6, 12)); // CISA's two-digit year
    expect(parseDate('Nov 8, 2026', NOW)).toBe(Date.UTC(2026, 10, 8, 12));
    expect(parseDate('11/09/2026, 08:00 AM, +0000 UTC', NOW)).toBe(Date.UTC(2026, 10, 9, 8));
  });

  it('rejects garbage and far-future dates', () => {
    expect(parseDate('not a date', NOW)).toBeNull();
    expect(parseDate('Thu, 01 Jan 1970 00:00:00 GMT', NOW)).toBeNull();
    expect(parseDate('2027-06-01', NOW)).toBeNull();
    expect(parseDate('', NOW)).toBeNull();
  });

  it('reads dates from article addresses', () => {
    expect(urlDate('https://www.usnews.com/news/top-news/articles/2026-11-08/trump-says', NOW)).toBe(Date.UTC(2026, 10, 8, 12));
    expect(urlDate('https://example.com/2024/05/12/old-story/', NOW)).toBe(Date.UTC(2024, 4, 12, 12));
    expect(urlDate('https://example.com/news/20240512-story', NOW)).toBe(Date.UTC(2024, 4, 12, 12));
    expect(urlDate('https://example.com/story-about-2024', NOW)).toBeNull();
  });

  it('never mistakes an old article that was re-indexed or updated for a new one', () => {
    // a search engine says "2 hours ago", but the article address is from May 2024
    const c = checkDate({ url: 'https://example.com/2024/05/12/old-story', reported: NOW - 2 * H }, NOW);
    expect(c.redated).toBe(true);
    expect(c.published).toBe(Date.UTC(2024, 4, 12, 12));
    expect(c.updated).toBe(NOW - 2 * H);
    // a feed re-publishing an old item
    expect(checkDate({ url: 'https://example.com/2024/05/12/x', feedPublished: NOW - H }, NOW).redated).toBe(true);
  });

  it('confirms dates when signals agree, and reports unknown when there are none', () => {
    expect(checkDate({ url: 'https://example.com/2026/11/09/x', reported: NOW - 3 * H }, NOW)).toMatchObject({ status: 'confirmed', basis: 'provider' });
    expect(checkDate({ url: 'https://example.com/x', feedPublished: NOW - H }, NOW)).toMatchObject({ status: 'confirmed', basis: 'feed' });
    expect(checkDate({ url: 'https://example.com/x', reported: NOW - H }, NOW)).toMatchObject({ status: 'reported' });
    expect(checkDate({ url: 'https://example.com/x' }, NOW)).toMatchObject({ status: 'unknown', published: null });
  });
});

describe('freshness rules', () => {
  it('picks the window from the wording', () => {
    expect(windowFor('breaking news on the election', NOW)).toMatchObject({ kind: 'breaking', since: NOW - 6 * H });
    expect(windowFor('latest technology news', NOW)).toMatchObject({ kind: 'latest', since: NOW - 24 * H, expandSince: NOW - 72 * H });
    expect(windowFor("what's happening in AI today", NOW)).toMatchObject({ kind: 'today', since: Date.UTC(2026, 10, 8, 22) }); // at least 12 h back
    expect(windowFor("this week's global political news", NOW)).toMatchObject({ kind: 'week', since: NOW - 7 * D });
    expect(windowFor('recent developments in quantum computing', NOW)).toMatchObject({ kind: 'recent', since: NOW - 30 * D });
    expect(windowFor('what happened yesterday', NOW)).toMatchObject({ kind: 'yesterday', since: Date.UTC(2026, 10, 8), until: Date.UTC(2026, 10, 9) });
  });

  it('recognises the test prompts as news requests with topic, entity and region', () => {
    const cases: [string, Partial<{ topic: string; entity: string; region: string }>][] = [
      ['Give me the latest technology news worldwide.', { topic: 'tech', region: 'world' }],
      ['What are the latest AI developments today?', { topic: 'ai' }],
      ['What is happening in cybersecurity right now?', { topic: 'security' }],
      ['Give me the latest news about OpenAI.', { entity: 'openai', topic: 'ai' }],
      ['What are the latest developments in Ghana?', { region: 'ghana' }],
      ["Give me this week's global political news.", { topic: 'politics', region: 'world' }],
      ['What are the latest developments in space exploration?', { topic: 'space' }],
      ['What is happening in the technology industry today?', { topic: 'tech' }],
      ['Give me the latest news about NVIDIA.', { entity: 'nvidia' }],
      ['What happened in the world today?', { region: 'world' }],
    ];
    for (const [q, want] of cases) {
      const r = detectNews(q, NOW);
      expect(r, q).not.toBeNull();
      if (want.topic) expect(r!.topics, q).toContain(want.topic);
      if (want.entity) expect(r!.entities, q).toContain(want.entity);
      if (want.region) expect(r!.region.id, q).toBe(want.region);
    }
    expect(detectNews('Give me the latest news about OpenAI.', NOW)!.keywords).toBe('openai');
    expect(detectNews('What are the latest developments in Ghana?', NOW)!.keywords).toBe('');
  });

  it('leaves non-news questions to the normal search path', () => {
    for (const q of ['What is the latest version of React?', 'What is the weather in Accra today?', 'Explain how PostgreSQL indexing works', 'What happened in 1957 in Ghana?', 'Write a poem about the sea'])
      expect(detectNews(q, NOW), q).toBeNull();
  });
});

describe('sources and feeds', () => {
  it('assigns credibility tiers', () => {
    expect(tierOf('https://openai.com/index/x')).toBe('official');
    expect(tierOf('https://www.presidency.gov.gh/x')).toBe('official');
    expect(tierOf('https://www.reuters.com/x')).toBe('wire');
    expect(tierOf('https://techcrunch.com/x')).toBe('specialist');
    expect(tierOf('https://www.myjoyonline.com/x')).toBe('regional');
    expect(tierOf('https://x.com/someone/status/1')).toBe('social');
    expect(tierOf('https://random-blog.example/x')).toBe('unknown');
  });

  it('chooses official newsrooms, regional outlets and topic feeds, never disabled feeds', () => {
    const openai = feedsFor(detectNews('latest news about OpenAI', NOW)!, DEFAULT_FEEDS);
    expect(openai[0].id).toBe('openai');
    const ghana = feedsFor(detectNews('latest developments in Ghana', NOW)!, DEFAULT_FEEDS).map((f) => f.id);
    expect(ghana).toEqual(expect.arrayContaining(['myjoyonline', 'graphic', 'threenews']));
    expect(ghana).not.toContain('ghanaweb'); // disabled: returned no entries
    const security = feedsFor(detectNews('latest cybersecurity news', NOW)!, DEFAULT_FEEDS).map((f) => f.id);
    expect(security).toEqual(expect.arrayContaining(['bleeping', 'cisa']));
  });

  it('parses RSS 2.0, Atom and RDF with CDATA and entities', () => {
    const rss = `<rss><channel><item><title><![CDATA[Big &amp; new]]></title><link>https://a.example/1</link><pubDate>Mon, 09 Nov 2026 08:00:00 GMT</pubDate><description>&lt;p&gt;Hello&lt;/p&gt;</description></item></channel></rss>`;
    expect(parseFeed(rss, NOW)).toEqual([{ title: 'Big & new', url: 'https://a.example/1', summary: 'Hello', published: Date.UTC(2026, 10, 9, 8), updated: null }]);
    const atom = `<feed><entry><title>Atom item</title><link rel="alternate" href="https://b.example/2"/><published>2026-11-09T07:00:00Z</published><updated>2026-11-09T09:00:00Z</updated><summary>S</summary></entry></feed>`;
    expect(parseFeed(atom, NOW)[0]).toMatchObject({ url: 'https://b.example/2', published: Date.UTC(2026, 10, 9, 7), updated: Date.UTC(2026, 10, 9, 9) });
    const rdf = `<rdf:RDF><item rdf:about="x"><title>RDF</title><link>https://c.example/3</link><dc:date>2026-11-09T06:00:00Z</dc:date></item></rdf:RDF>`;
    expect(parseFeed(rdf, NOW)[0]).toMatchObject({ url: 'https://c.example/3', published: Date.UTC(2026, 10, 9, 6) });
  });

  it('normalises URLs and headlines', () => {
    expect(canonicalUrl('https://www.example.com/a/b/?utm_source=x&id=2#top')).toBe('example.com/a/b?id=2');
    expect(canonicalUrl('https://m.example.com/a/amp')).toBe('example.com/a');
    expect(cleanTitle('Nvidia opens inquiry - Reuters')).toBe('Nvidia opens inquiry');
  });
});

/* ------------------------------ the pipeline, with controlled provider answers ------------------------------ */

function provider(id: 'serpapi' | 'tavily', results: (opts: SearchOptions) => SearchResponse['results'], calls: SearchOptions[] = []) {
  return {
    id,
    label: id,
    isConfigured: () => true,
    async search(_q: string, opts: SearchOptions): Promise<SearchResponse> {
      calls.push(opts);
      return { results: results(opts), credits: 1 };
    },
    accountUsage: async () => null,
    extract: async () => ({ results: [], credits: 0 }),
  };
}

const iso = (ms: number) => new Date(ms).toISOString();

describe('news pipeline', () => {
  const feed: FeedDef = { id: 'testfeed', name: 'Test Tech Feed', url: 'https://feeds.example/tech.xml', domain: 'theverge.com', tier: 'specialist', topics: ['tech', 'ai'], regions: ['world'] };
  const feedXml = `<rss><channel>
    <item><title>Chipmaker unveils its new AI accelerator chip</title><link>https://www.theverge.com/2026/11/9/chip</link><pubDate>${new Date(NOW - 2 * H).toUTCString()}</pubDate></item>
    <item><title>Old smartphone review</title><link>https://www.theverge.com/2024/3/1/phone</link><pubDate>${new Date(Date.UTC(2024, 2, 1)).toUTCString()}</pubDate></item>
  </channel></rss>`;

  async function run(text: string, serp: SearchResponse['results'], tav: SearchResponse['results'], opts: { feedOk?: boolean; failSerp?: boolean } = {}) {
    const serpCalls: SearchOptions[] = [];
    const tavCalls: SearchOptions[] = [];
    const providers = {
      serpapi: opts.failSerp
        ? { ...provider('serpapi', () => []), search: async () => Promise.reject(new (await import('../server/search/types.js')).SearchError('serpapi', 'failed', 'SerpAPI search failed.')) }
        : provider('serpapi', () => serp, serpCalls),
      tavily: provider('tavily', () => tav, tavCalls),
    } as unknown as Providers;
    setFeedFetch(async () => (opts.feedOk === false ? new Response('nope', { status: 503 }) : new Response(feedXml, { status: 200 })));
    const service = new SearchService(providers, () => NOW, { minGapMs: 0, perMinute: 100, reportedTtlMs: 0 });
    const req = detectNews(text, NOW)!;
    const n = await gatherNews({ req, uid: 'u1', store: new MemorySearchStore(), limits: DEFAULT_LIMITS, service, feeds: [feed], explicit: true, now: NOW });
    setFeedFetch(null);
    return { n, serpCalls, tavCalls };
  }

  it('asks both providers for recent, date-sorted news and drops articles outside the window', async () => {
    const { n, serpCalls, tavCalls } = await run(
      'latest technology news',
      [
        { title: 'Chipmaker unveils new AI accelerator - Reuters', url: 'https://www.reuters.com/tech/chip-2026-11-09/', site: 'Reuters', snippet: 'A new chip.', publishedDate: iso(NOW - 3 * H), dateText: '3 hours ago' },
        { title: 'Ten best laptops of 2024', url: 'https://example.com/2024/01/05/laptops', site: 'Example', snippet: 'old list', publishedDate: iso(NOW - H) },
      ],
      [{ title: 'Space startup raises funding', url: 'https://techcrunch.com/2026/11/09/space-startup/', site: 'techcrunch.com', snippet: 'Funding.', publishedDate: new Date(NOW - 5 * H).toUTCString() }],
    );
    expect(serpCalls[0]).toMatchObject({ kind: 'news', freshness: 'week', sortByDate: true });
    expect(tavCalls[0]).toMatchObject({ kind: 'news', freshness: 'week' });
    const titles = n.stories.map((s) => s.lead.title);
    expect(titles).toContain('Chipmaker unveils new AI accelerator');
    expect(titles).toContain('Space startup raises funding');
    expect(titles.join(' ')).not.toMatch(/2024|smartphone review/);
    // the Reuters and Verge reports of the chip are one story with two independent sources
    const chip = n.stories.find((s) => s.lead.title.startsWith('Chipmaker'))!;
    expect(chip.independent).toBe(2);
    expect(chip.confirmation).toBe('multiple');
    expect(n.stats.redated).toBe(1); // the 2024 laptop list shown as "1 hour ago"
    expect(n.stats.rejectedOld).toBeGreaterThanOrEqual(2);
    expect(n.stats.duplicates).toBe(1);
    const brief = newsBrief(n);
    expect(brief.text).toContain('Freshness window: the last 24 hours');
    expect(brief.text).not.toContain('laptops of 2024');
    expect(brief.sources.every((s) => s.publishedDate)).toBe(true);
  });

  it('widens the window once, openly, when too few articles are recent', async () => {
    const { n } = await run('latest news about quantum computing', [{ title: 'Quantum computing milestone reached', url: 'https://www.bbc.com/news/quantum', site: 'BBC', snippet: 'quantum computing', publishedDate: iso(NOW - 50 * H) }], [], { feedOk: false });
    expect(n.expanded).toBe(true);
    expect(n.windowLabel).toBe('the last 72 hours');
    expect(n.stories).toHaveLength(1);
    expect(n.notices.join(' ')).toMatch(/widened/);
  });

  it('keeps going on the other sources when one provider fails, and reports it', async () => {
    const { n } = await run('latest technology news', [], [{ title: 'Space startup raises funding', url: 'https://techcrunch.com/2026/11/09/space-startup/', site: 'techcrunch.com', snippet: 'Funding.', publishedDate: iso(NOW - 5 * H) }], { failSerp: true });
    expect(n.providers.find((p) => p.id === 'serpapi')!.status).toBe('failed');
    expect(n.stories.length).toBeGreaterThan(0);
    expect(newsBrief(n).text).toMatch(/Unavailable this time: serpapi/);
  });

  it('reports a failure (no invented news) when nothing can be retrieved', async () => {
    const { n } = await run('latest technology news', [], [], { feedOk: false });
    expect(n.stories).toHaveLength(0);
    expect(n.failure).toBeTruthy();
  });

  it('never lists undated articles as current', async () => {
    const { n } = await run('latest news about widgets', [{ title: 'Widgets are everywhere', url: 'https://example.com/widgets', site: 'Example', snippet: 'widgets' }], [], { feedOk: false });
    expect(n.stories).toHaveLength(0);
    expect(n.stats.undated).toBe(1);
  });

  it('keeps broad world-feed items only when they are about the requested region or topic', async () => {
    const worldXml = `<rss><channel>
      <item><title>Drone attack suspends production at Iraq gasfield</title><link>https://www.bbc.com/news/world-1</link><pubDate>${new Date(NOW - H).toUTCString()}</pubDate></item>
      <item><title>Accra hosts West African trade summit</title><link>https://www.bbc.com/news/world-2</link><pubDate>${new Date(NOW - H).toUTCString()}</pubDate></item>
      <item><title>Nvidia launches investigation into its chief executive</title><link>https://www.bbc.com/news/world-4</link><pubDate>${new Date(NOW - H).toUTCString()}</pubDate></item>
      <item><title>Copyright law changes worry musicians</title><description>A space for creators, says the global body.</description><link>https://www.bbc.com/news/world-5</link><pubDate>${new Date(NOW - H).toUTCString()}</pubDate></item>
      <item><title>NASA rocket launch delayed by weather</title><link>https://www.bbc.com/news/world-3</link><pubDate>${new Date(NOW - H).toUTCString()}</pubDate></item>
    </channel></rss>`;
    const ghanaXml = `<rss><channel><item><title>Mahama commissions new hospital</title><link>https://www.myjoyonline.com/hospital</link><pubDate>${new Date(NOW - H).toUTCString()}</pubDate></item><item><title>Seven dead after trains collide in Egypt</title><link>https://www.myjoyonline.com/egypt</link><pubDate>${new Date(NOW - H).toUTCString()}</pubDate></item><item><title>South Africa's ANC records worst results</title><link>https://www.myjoyonline.com/anc</link><pubDate>${new Date(NOW - H).toUTCString()}</pubDate></item></channel></rss>`;
    const africa: FeedDef = { id: 'africa', name: 'Africa', url: 'https://feeds.example/africa.xml', domain: 'bbc.com', tier: 'wire', topics: ['general'], regions: ['africa', 'ghana'] };
    const world: FeedDef = { id: 'world', name: 'World', url: 'https://feeds.example/world.xml', domain: 'bbc.com', tier: 'wire', topics: ['general'], regions: ['world'] };
    const joy: FeedDef = { id: 'joy', name: 'MyJoyOnline', url: 'https://feeds.example/joy.xml', domain: 'myjoyonline.com', tier: 'regional', topics: ['general'], regions: ['ghana'] };
    setFeedFetch(async (u) => new Response(String(u).includes('joy') ? ghanaXml : worldXml, { status: 200 }));
    const service = new SearchService({ serpapi: { isConfigured: () => false }, tavily: { isConfigured: () => false } } as unknown as Providers, () => NOW, { minGapMs: 0, perMinute: 100, reportedTtlMs: 0 });
    const go = (text: string) => gatherNews({ req: detectNews(text, NOW)!, uid: 'u', store: new MemorySearchStore(), limits: DEFAULT_LIMITS, service, feeds: [world, africa, joy], explicit: true, now: NOW });
    const ghana = (await go('What are the latest developments in Ghana?')).stories.map((s) => s.lead.title);
    expect(ghana.sort()).toEqual(['Accra hosts West African trade summit', 'Mahama commissions new hospital']);
    const space = (await go('What are the latest developments in space exploration?')).stories.map((s) => s.lead.title);
    expect(space).toEqual(['NASA rocket launch delayed by weather']);
    setFeedFetch(null);
  });

  it('extracts search keywords without possessives', () => {
    expect(detectNews("Give me this week's global political news.", NOW)!.keywords).toBe('political');
  });
});
