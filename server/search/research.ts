/**
 * Deep Research: plan sub-queries, search each within a hard budget, read
 * the most relevant pages, and hand everything to the model with numbered
 * sources. Only runs when the user turns it on for a message.
 */
import type { ResearchStep, SearchLimits } from '../shared/types.js';
import { parseJsonObject, utilityComplete } from '../utility.js';
import { classifyIntent } from './heuristics.js';
import type { SearchService } from './router.js';
import type { SearchStore } from './store.js';
import type { SearchIntent, SearchProviderId, SearchResult } from './types.js';

export interface PlannedQuery {
  q: string;
  intent: SearchIntent;
}

const INTENTS: SearchIntent[] = ['general', 'news', 'research', 'reference'];

/** Ask a free utility model for sub-queries; fall back to the question itself. */
export async function planQueries(
  question: string,
  max: number,
  complete: typeof utilityComplete = utilityComplete,
): Promise<PlannedQuery[]> {
  const out = await complete(
    [
      {
        role: 'system',
        content:
          `You plan web research. Break the user's question into at most ${max} distinct, specific web search queries ` +
          `that together cover it (different angles, no near-duplicates, each under 12 words). ` +
          `For each give an intent: "news" (recent events), "research" (analysis, studies, comparisons), ` +
          `"reference" (documentation, definitions) or "general". ` +
          `Return only JSON: {"queries":[{"q":"...","intent":"general"}]}`,
      },
      { role: 'user', content: question.slice(0, 3000) },
    ],
    { json: true, maxTokens: 500 },
  ).catch(() => null);
  const parsed = parseJsonObject<{ queries?: { q?: unknown; intent?: unknown }[] }>(out);
  const seen = new Set<string>();
  const queries: PlannedQuery[] = [];
  for (const item of parsed?.queries ?? []) {
    const q = typeof item.q === 'string' ? item.q.trim().slice(0, 200) : '';
    if (!q || seen.has(q.toLowerCase())) continue;
    seen.add(q.toLowerCase());
    const intent = INTENTS.includes(item.intent as SearchIntent) ? (item.intent as SearchIntent) : classifyIntent(q).intent;
    queries.push({ q, intent });
    if (queries.length >= max) break;
  }
  return queries.length ? queries : [{ q: question.slice(0, 300), ...{ intent: classifyIntent(question).intent } }];
}

export interface ResearchResult {
  results: (SearchResult & { provider: SearchProviderId; fromQuery: string })[];
  steps: ResearchStep[];
  searches: number;
  pagesRead: number;
  notices: string[];
}

/** Pick pages to read: the top result of each query first, then the rest. */
export function pickPages(results: { url: string; fromQuery: string }[], max: number): string[] {
  const byQuery = new Map<string, string[]>();
  for (const r of results) byQuery.set(r.fromQuery, [...(byQuery.get(r.fromQuery) ?? []), r.url]);
  const picked: string[] = [];
  for (let round = 0; picked.length < max; round++) {
    let added = false;
    for (const urls of byQuery.values()) {
      if (urls[round] && !picked.includes(urls[round]) && picked.length < max) {
        picked.push(urls[round]);
        added = true;
      }
    }
    if (!added) break;
  }
  return picked;
}

export async function runResearch(args: {
  service: SearchService;
  store: SearchStore;
  limits: SearchLimits;
  uid: string;
  question: string;
  signal?: AbortSignal;
  onStep: (s: ResearchStep) => void;
  plan?: PlannedQuery[];
}): Promise<ResearchResult> {
  const { service, store, limits, uid, signal } = args;
  const steps: ResearchStep[] = [];
  const step = (s: ResearchStep) => {
    steps.push(s);
    args.onStep(s);
  };
  const plan = args.plan ?? (await planQueries(args.question, limits.research.maxSearches));
  step({ kind: 'plan', text: `Planned ${plan.length} search${plan.length === 1 ? '' : 'es'} (limit ${limits.research.maxSearches})` });

  const results: ResearchResult['results'] = [];
  const seen = new Set<string>();
  const notices: string[] = [];
  let searches = 0;
  for (const p of plan.slice(0, limits.research.maxSearches)) {
    if (signal?.aborted) break;
    const r = await service.run({ uid, store, limits, query: p.q, intent: p.intent, max: 5, throttle: false, signal });
    if (!r.ok) {
      step({ kind: 'skip', text: `${p.q}: ${r.reason.replace(/ Answering without search\.$/, '')}` });
      if (/unavailable/.test(r.reason)) break; // budgets exhausted: stop planning more spend
      continue;
    }
    if (!r.cached) searches++;
    notices.push(...r.notices);
    let added = 0;
    for (const res of r.results) {
      if (seen.has(res.url)) continue;
      seen.add(res.url);
      results.push({ ...res, provider: r.provider, fromQuery: p.q });
      added++;
    }
    step({ kind: 'search', text: `${p.q} (${added} new source${added === 1 ? '' : 's'})`, provider: r.provider, cached: r.cached });
  }

  let pagesRead = 0;
  if (limits.research.maxPageReads > 0 && results.length && !signal?.aborted) {
    const urls = pickPages(results, limits.research.maxPageReads);
    const ex = await service.extract({ uid, store, limits, urls, throttle: false, signal });
    if (ex.ok) {
      for (const page of ex.results) {
        const target = results.find((r) => r.url === page.url);
        if (target) {
          target.content = page.content.slice(0, 6000);
          pagesRead++;
        }
      }
      step({ kind: 'read', text: `Read ${pagesRead} of ${urls.length} selected pages`, provider: 'tavily', cached: ex.cached });
    } else {
      step({ kind: 'skip', text: ex.reason });
    }
  }
  step({ kind: 'done', text: `${results.length} sources from ${searches} new search${searches === 1 ? '' : 'es'}` });
  return { results, steps, searches, pagesRead, notices };
}
