/**
 * Live check of the search router with real providers and an in-memory store
 * (no Firestore). Costs about 2 SerpAPI searches and 3 Tavily credits.
 *
 *   npx tsx --env-file=.env.local dev/smoke-search.ts
 *
 * Never prints API keys.
 */
import { DEFAULT_LIMITS } from '../server/config/limits.js';
import { SearchService } from '../server/search/router.js';
import { SerpApiSearch } from '../server/search/serpapi.js';
import { MemorySearchStore } from '../server/search/store.js';
import { TavilySearch } from '../server/search/tavily.js';

const store = new MemorySearchStore();
const svc = new SearchService(undefined, Date.now, { minGapMs: 0, perMinute: 100, reportedTtlMs: 600_000 });
const base = { uid: 'smoke', store, limits: DEFAULT_LIMITS };

function show(label: string, r: Awaited<ReturnType<SearchService['run']>>) {
  if (!r.ok) return console.log(`${label}: NOT OK - ${r.reason}`);
  console.log(`${label}: ${r.provider} cached=${r.cached} results=${r.results.length}${r.notices.length ? ` notices=${JSON.stringify(r.notices)}` : ''}`);
  for (const x of r.results.slice(0, 3)) console.log(`   - ${x.title.slice(0, 70)} | ${x.site} | ${x.publishedDate ?? 'no date'} | ${x.url.slice(0, 80)}`);
}

console.log('SerpAPI before:', await new SerpApiSearch().accountUsage());
console.log('Tavily before:', await new TavilySearch().accountUsage());

show('1 serpapi news', await svc.run({ ...base, query: 'NASA Artemis latest news', intent: 'news' }));
show('2 same query (should be cache)', await svc.run({ ...base, query: 'nasa artemis latest news?', intent: 'news' }));
show('3 tavily research', await svc.run({ ...base, query: 'comparison of solid state battery research progress', intent: 'research' }));

const ex = await svc.extract({ ...base, urls: ['https://en.wikipedia.org/wiki/Web_search_engine'] });
console.log('4 extract:', ex.ok ? `ok cached=${ex.cached} chars=${ex.results[0]?.content.length}` : ex.reason);

// Forced fallback: a SerpAPI provider with a bad key (costs no SerpAPI credit).
const realKey = process.env.SERPAPI_API_KEY;
process.env.SERPAPI_API_KEY = 'invalid-key-for-smoke-test';
const fb = new SearchService(undefined, Date.now, { minGapMs: 0, perMinute: 100, reportedTtlMs: 600_000 });
show('5 fallback (serpapi bad key)', await fb.run({ ...base, query: 'tallest building in Africa 2026', intent: 'general' }));
process.env.SERPAPI_API_KEY = realKey;

console.log('usage events:', store.events.map((e) => `${e.provider}:${e.type}:${e.credits}`).join(', '));
console.log('SerpAPI after:', await new SerpApiSearch().accountUsage());
console.log('Tavily after:', await new TavilySearch().accountUsage());
