/**
 * Live check of current-news retrieval with the real providers and publisher feeds, using an
 * in-memory store (no Firestore). Each prompt costs at most 1 SerpAPI search and 1 Tavily credit
 * (plus 1 more of each when the window has to widen); feeds are free.
 *
 *   npx tsx --env-file=.env.local dev/smoke-news.ts            all 10 prompts
 *   npx tsx --env-file=.env.local dev/smoke-news.ts 4 5        only prompts 4 and 5
 *
 * Never prints API keys.
 */
import { DEFAULT_LIMITS } from '../server/config/limits.js';
import { gatherNews, newsBrief } from '../server/news/discover.js';
import { detectNews } from '../server/news/freshness.js';
import { DEFAULT_FEEDS } from '../server/news/sources.js';
import { SearchService } from '../server/search/router.js';
import { SerpApiSearch } from '../server/search/serpapi.js';
import { MemorySearchStore } from '../server/search/store.js';
import { TavilySearch } from '../server/search/tavily.js';

const PROMPTS = [
  'Give me the latest technology news worldwide.',
  'What are the latest AI developments today?',
  'What is happening in cybersecurity right now?',
  'Give me the latest news about OpenAI.',
  'What are the latest developments in Ghana?',
  "Give me this week's global political news.",
  'What are the latest developments in space exploration?',
  'What is happening in the technology industry today?',
  'Give me the latest news about NVIDIA.',
  'What happened in the world today?',
];

const pick = process.argv.slice(2).map(Number).filter((n) => n >= 1 && n <= PROMPTS.length);
const store = new MemorySearchStore();
const svc = new SearchService(undefined, Date.now, { minGapMs: 0, perMinute: 100, reportedTtlMs: 600_000 });
// this run alone may use more than the app's default daily allowance (it is one person testing)
const limits = { ...DEFAULT_LIMITS, serpapi: { daily: 40, monthly: 200 }, tavily: { daily: 40, monthly: 900 } };

const fmt = (ms: number | null) => (ms == null ? 'unknown' : new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC');

console.log('SerpAPI before:', await new SerpApiSearch().accountUsage());
console.log('Tavily before:', await new TavilySearch().accountUsage());

let oldest = Infinity;
for (const [i, text] of PROMPTS.entries()) {
  if (pick.length && !pick.includes(i + 1)) continue;
  const req = detectNews(text);
  console.log(`\n=== ${i + 1}. ${text}`);
  if (!req) {
    console.log('   NOT detected as news');
    continue;
  }
  console.log(`   window=${req.window.kind} (${req.window.label}) topics=${req.topics.join(',')} entities=${req.entities.join(',') || '-'} region=${req.region.id} keywords="${req.keywords}"`);
  const t0 = Date.now();
  const n = await gatherNews({ req, uid: 'smoke', store, limits, service: svc, feeds: DEFAULT_FEEDS, explicit: true });
  console.log(`   ${Date.now() - t0} ms | stories=${n.stories.length} expanded=${n.expanded} window=${n.windowLabel}`);
  console.log(`   checked=${n.stats.discovered} inWindow=${n.stats.inWindow} tooOld=${n.stats.rejectedOld} undated=${n.stats.undated} redated=${n.stats.redated} dupes=${n.stats.duplicates} irrelevant=${n.stats.irrelevant}`);
  console.log(`   providers: ${n.providers.map((p) => `${p.id}:${p.status}(${p.articles})${p.reason ? ' ' + p.reason : ''}`).join(' ')}`);
  if (n.failure) console.log(`   FAILURE: ${n.failure}`);
  for (const s of n.stories.slice(0, 5)) {
    oldest = Math.min(oldest, s.lead.date.published ?? Infinity);
    console.log(`   - [${s.lead.tier}] ${s.lead.title.slice(0, 80)} | ${s.lead.source} | ${fmt(s.lead.date.published)} (${s.lead.date.basis}/${s.lead.date.status}) | ${s.confirmation}, ${s.independent} src`);
  }
  if (n.background.length) console.log(`   background: ${n.background.length}`);
  if (i === 0) console.log('\n--- brief for the model (prompt 1) ---\n' + newsBrief(n).text.slice(0, 1500) + '\n---');
}

console.log(`\nOldest lead story published: ${oldest === Infinity ? 'n/a' : fmt(oldest)}`);
console.log('SerpAPI after:', await new SerpApiSearch().accountUsage());
console.log('Tavily after:', await new TavilySearch().accountUsage());
