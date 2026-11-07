/**
 * Decide whether a chat turn uses the web and, if so, gather the results
 * into prompt text + numbered sources. The engine calls only this.
 */
import { loadLimits } from '../config/limits.js';
import type { Firestore } from '../firestore.js';
import type { ChatTurn, ResearchStep, SearchInfo, Source } from '../shared/types.js';
import { utilityComplete } from '../utility.js';
import { embed } from '../embeddings.js';
import { decideSearch, type SearchDecision, type SearchMode } from './decide.js';
import { extractUrls, looksLikeFollowUp, toSearchQuery } from './heuristics.js';
import { runResearch } from './research.js';
import { searchService } from './router.js';
import { FirestoreSearchStore } from './store.js';
import type { SearchProviderId, SearchResult } from './types.js';

export interface WebContext {
  sources: Source[];
  /** prompt block, empty when nothing was found */
  text: string;
  info: SearchInfo;
  steps: ResearchStep[];
  notices: string[];
  /** set when search was wanted but could not run */
  failure: string | null;
}

export interface WebOptions {
  webSearch: boolean;
  autoSearch?: boolean;
  deepResearch?: boolean;
  searchMode?: SearchMode;
}

/** Map the options + message to the decision engine's input. autoSearch=false means manual mode. */
export function decideFor(text: string, opts: WebOptions, hasDocuments = false): SearchDecision {
  const mode: SearchMode = opts.searchMode ?? (opts.autoSearch === false ? 'manual' : 'auto');
  return decideSearch(text, { webSearch: opts.webSearch, deepResearch: opts.deepResearch, mode, hasDocuments });
}

type Trigger = SearchInfo['trigger'];

export function searchTrigger(text: string, opts: WebOptions, hasDocuments = false): Trigger | null {
  return toTrigger(decideFor(text, opts, hasDocuments));
}

function toTrigger(d: SearchDecision): Trigger | null {
  if (d.action === 'none') return null;
  if (d.action === 'research') return 'research';
  if (d.action === 'extract') return 'url';
  return d.explicit ? 'manual' : 'auto';
}

/** Rewrite a short follow-up into a standalone query using recent turns (free model). */
async function standaloneQuery(turns: ChatTurn[], text: string): Promise<string> {
  const base = toSearchQuery(text);
  if (turns.length < 2 || !looksLikeFollowUp(text)) return base;
  const history = turns
    .slice(-5, -1)
    .map((t) => `${t.role}: ${t.content.slice(0, 600)}`)
    .join('\n');
  const out = await utilityComplete(
    [
      {
        role: 'system',
        content:
          'Rewrite the final user message as one standalone web search query (under 14 words) using the conversation for context. Return only the query text.',
      },
      { role: 'user', content: `${history}\nuser: ${text}` },
    ],
    { maxTokens: 60 },
  ).catch(() => null);
  const q = out?.split('\n')[0]?.replace(/^["'`]|["'`]$/g, '').trim();
  return q && q.length < 200 ? q : base;
}

function block(i: number, r: SearchResult & { provider?: SearchProviderId }): string {
  const body = r.content && r.content.length > r.snippet.length ? r.content : r.snippet;
  return [
    `[${i}] ${r.title}`,
    `Site: ${r.site}`,
    `URL: ${r.url}`,
    r.publishedDate ? `Published (as reported by the source): ${r.publishedDate}` : '',
    body.slice(0, 6000),
  ]
    .filter(Boolean)
    .join('\n');
}

export async function gatherWebContext(args: {
  db: Firestore;
  uid: string;
  turns: ChatTurn[];
  text: string;
  options: WebOptions;
  hasDocuments?: boolean;
  signal?: AbortSignal;
  onStep?: (s: ResearchStep) => void;
  /** called with every decision, including "no search" (for analytics) */
  onDecision?: (d: SearchDecision) => void;
}): Promise<WebContext | null> {
  const decision = decideFor(args.text, args.options, args.hasDocuments);
  args.onDecision?.(decision);
  const trigger = toTrigger(decision);
  if (!trigger) return null;
  const service = searchService();
  const urls = extractUrls(args.text);
  const query = trigger === 'url' ? urls.join(' ') : await standaloneQuery(args.turns, args.text);
  const mode: SearchInfo['mode'] = trigger === 'research' ? 'research' : urls.length && trigger !== 'auto' ? 'extract' : 'search';
  const base: SearchInfo = { status: 'unavailable', mode, provider: null, query, cached: false, trigger, reason: decision.reason };

  if (!service.configured().length) {
    // auto mode stays silent; explicit requests get told
    if (trigger === 'auto' || trigger === 'url') return null;
    const reason = 'web search is not configured on the server';
    return { sources: [], text: '', info: { ...base, message: reason }, steps: [], notices: [], failure: reason };
  }

  const limits = await loadLimits(args.db);
  const store = new FirestoreSearchStore(args.db, args.uid);
  const sources: Source[] = [];
  const blocks: string[] = [];
  const add = (r: SearchResult, provider: SearchProviderId) => {
    const index = sources.length + 1;
    sources.push({
      index,
      kind: 'web',
      title: r.title,
      url: r.url,
      snippet: r.snippet.slice(0, 280),
      site: r.site,
      provider,
      ...(r.publishedDate ? { publishedDate: r.publishedDate } : {}),
    });
    blocks.push(block(index, r));
  };

  // 1) Deep Research
  if (trigger === 'research') {
    const res = await runResearch({
      service,
      store,
      limits,
      uid: args.uid,
      question: toSearchQuery(args.text) || args.text,
      signal: args.signal,
      onStep: args.onStep ?? (() => undefined),
    });
    res.results.forEach((r) => add(r, r.provider));
    const providers = [...new Set(res.results.map((r) => r.provider))];
    const info: SearchInfo = {
      ...base,
      status: res.results.length ? 'ok' : 'unavailable',
      provider: providers.length === 1 ? providers[0] : providers.length ? providers[0] : null,
      cached: false,
      message: `${res.searches} new search${res.searches === 1 ? '' : 'es'}, ${res.pagesRead} page${res.pagesRead === 1 ? '' : 's'} read`,
    };
    return {
      sources,
      text: blocks.join('\n\n'),
      info,
      steps: res.steps,
      notices: res.notices,
      failure: res.results.length ? null : (res.steps.find((s) => s.kind === 'skip')?.text ?? 'no results found'),
    };
  }

  // 2) Explicit URL(s): read the page(s)
  if (mode === 'extract') {
    const ex = await service.extract({ uid: args.uid, store, limits, urls, signal: args.signal });
    if (ex.ok) {
      ex.results.forEach((p) =>
        add({ title: p.title || p.url, url: p.url, site: new URL(p.url).hostname.replace(/^www\./, ''), snippet: p.content.slice(0, 280), content: p.content }, 'tavily'),
      );
      return {
        sources,
        text: blocks.join('\n\n'),
        info: { ...base, status: 'ok', provider: 'tavily', cached: ex.cached },
        steps: [],
        notices: ex.notices,
        failure: null,
      };
    }
    return { sources, text: '', info: { ...base, message: ex.reason }, steps: [], notices: ex.notices, failure: ex.reason };
  }

  // 3) Regular search
  const { intent, kind } = decision;
  // Embedding is free (Gemini) and lets a same-meaning question reuse a fresh cached search.
  const vec = await embed([query]).catch(() => null);
  const r = await service.run({
    uid: args.uid,
    store,
    limits,
    query,
    intent,
    kind,
    signal: args.signal,
    priority: decision.explicit ? 'explicit' : 'auto',
    queryVector: vec?.vectors[0] ? { vector: vec.vectors[0], model: vec.model } : null,
  });
  if (!r.ok) {
    return { sources, text: '', info: { ...base, message: r.reason }, steps: [], notices: r.notices, failure: r.reason };
  }
  r.results.forEach((res) => add(res, r.provider));
  let text = blocks.join('\n\n');
  if (r.answer) text = `Search engine answer box (${r.provider === 'serpapi' ? 'Google via SerpAPI' : 'Tavily'}): ${r.answer}\n\n${text}`;
  return {
    sources,
    text,
    info: {
      ...base,
      status: r.results.length ? 'ok' : 'unavailable',
      provider: r.provider,
      cached: r.cached,
      cachedAt: r.cachedAt,
      ...(r.similar ? { similar: true } : {}),
    },
    steps: [],
    notices: r.notices,
    failure: r.results.length ? null : 'no results found',
  };
}
