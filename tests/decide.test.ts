import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../server/config/limits.js';
import { decideSearch } from '../server/search/decide.js';
import { SearchService, type Providers } from '../server/search/router.js';
import { MemorySearchStore, findSimilar, normalizeQuery, cacheKey, type CacheEntry } from '../server/search/store.js';
import type { SearchResult } from '../server/search/types.js';
import { searchTrigger } from '../server/search/web.js';

const none = (text: string, input = {}) => expect(decideSearch(text, input).action, text).toBe('none');
const searches = (text: string, input = {}) => expect(decideSearch(text, input).action, text).toBe('search');

describe('search decision engine: the required table', () => {
  it('never searches for greetings, even with the Search toggle on', () => {
    for (const t of ['Hello, how are you?', "Hope you're good", 'hi', 'Thanks!', 'good morning', 'ok cool', 'How are you doing today?']) {
      none(t);
      none(t, { webSearch: true });
      none(t, { mode: 'eager' });
      expect(searchTrigger(t, { webSearch: true })).toBeNull();
    }
    expect(decideSearch("Hope you're good", { webSearch: true }).reason).toBe('smalltalk');
  });

  it('answers general knowledge, education and programming from the model', () => {
    for (const t of [
      'What is Java?',
      'Explain operating systems',
      'How do I reverse a list in Python?',
      'How do I get the current directory in Python?',
      'What is photosynthesis?',
      'Give me ideas for a birthday party',
    ])
      none(t);
    expect(decideSearch('What is Java?').reason).toBe('model_knowledge');
  });

  it('never searches for maths and writing tasks', () => {
    expect(decideSearch('What is 5 × 10?', { webSearch: true }).reason).toBe('math');
    expect(decideSearch('12*(3+4)').reason).toBe('math');
    expect(decideSearch('Help me write an email', { webSearch: true }).reason).toBe('writing');
    none('Translate this to French: good night');
  });

  it('uses the document, not the web, for attached files', () => {
    const d = decideSearch('Summarize this uploaded PDF', { hasDocuments: true, webSearch: true });
    expect(d).toMatchObject({ action: 'none', reason: 'document' });
  });

  it('uses memory for questions about earlier conversations', () => {
    expect(decideSearch('What did I tell you yesterday?')).toMatchObject({ action: 'none', reason: 'memory' });
    expect(decideSearch('Do you remember my project name?', { webSearch: true }).reason).toBe('memory');
  });

  it('searches for current information', () => {
    for (const t of [
      'What is the latest news in Ghana?',
      "Who is Ghana's current president?",
      'Who is the president of Ghana?',
      'What is the latest version of React?',
      'Research recent cybersecurity threats',
      'What is the weather in Accra?',
      'Bitcoin price today?',
      'What is the exchange rate of cedi to dollar?',
    ])
      searches(t);
    expect(decideSearch('What is the latest news in Ghana?')).toMatchObject({ reason: 'current_info', intent: 'news', explicit: false });
    expect(decideSearch('What is the weather in Accra?').intent).toBe('live');
  });

  it('runs Deep Research only when asked for or toggled', () => {
    expect(decideSearch('Conduct a comprehensive study of AI in healthcare')).toMatchObject({ action: 'research', reason: 'research_request' });
    expect(decideSearch('Tell me about AI in healthcare').action).toBe('none');
    expect(decideSearch('Tell me about AI in healthcare', { deepResearch: true }).reason).toBe('research_toggle');
    // manual mode: research phrasing alone does not spend credits
    expect(decideSearch('Conduct a comprehensive study of AI in healthcare', { mode: 'manual' }).action).toBe('none');
  });

  it('honours explicit search requests', () => {
    expect(decideSearch('Search the web for information about Soko Aerial')).toMatchObject({ action: 'search', reason: 'explicit_request', explicit: true });
    expect(decideSearch('look up Soko Aerial', { mode: 'manual' }).action).toBe('search');
    expect(decideSearch('summarize https://example.com/post').action).toBe('extract');
  });

  it('respects the user preference', () => {
    // manual: model knowledge unless asked
    expect(decideSearch('What is the latest news in Ghana?', { mode: 'manual' })).toMatchObject({ action: 'none', reason: 'mode_manual' });
    expect(decideSearch('What is the latest news in Ghana?', { mode: 'manual', webSearch: true }).action).toBe('search');
    // eager: entity questions may search, ordinary ones still do not
    expect(decideSearch('What does Soko Aerial do?', { mode: 'eager' }).reason).toBe('eager');
    none('What is Java', { mode: 'eager' });
    none('Explain operating systems', { mode: 'eager' });
    // legacy autoSearch=false maps to manual
    expect(searchTrigger('latest news today?', { webSearch: false, autoSearch: false })).toBeNull();
  });
});

// ---- credit protection ----

const result = (n: number): SearchResult => ({ title: `R${n}`, url: `https://example.com/${n}`, site: 'example.com', snippet: 's' });
function fake() {
  const calls = { serpapi: 0, tavily: 0 };
  const providers: Providers = {
    serpapi: {
      id: 'serpapi',
      label: 'SerpAPI',
      isConfigured: () => true,
      search: async () => (calls.serpapi++, { results: [result(1)], credits: 1 }),
      accountUsage: async () => ({ used: 0, limit: 250, remaining: 250 }),
    },
    tavily: {
      id: 'tavily',
      label: 'Tavily',
      isConfigured: () => true,
      search: async () => (calls.tavily++, { results: [result(2)], credits: 1 }),
      extract: async () => ({ results: [], credits: 0 }),
      accountUsage: async () => ({ used: 0, limit: 1000, remaining: 1000 }),
    },
  };
  return { providers, calls };
}
const fastOpts = { minGapMs: 0, perMinute: 1000, reportedTtlMs: 60_000 };
const base = { uid: 'u1', limits: DEFAULT_LIMITS };
const vec = (v: number[]) => ({ vector: v, model: 'gemini:gemini-embedding-001' });

describe('company and organization questions', () => {
  it('looks up an unfamiliar company on the web instead of guessing', () => {
    for (const t of ['Do you know Soko Aerial?', 'do you know soko aerial', 'Have you heard of Zipline?', 'What services does Soko Aerial Ltd offer?']) {
      const d = decideSearch(t, {});
      expect(d.action, t).toBe('search');
      expect(d.reason, t).toBe('entity_lookup');
    }
  });

  it('answers from the knowledge base when it already covers the company', () => {
    for (const t of ['Do you know Soko Aerial?', 'What services does Soko Aerial Ltd offer?']) {
      const d = decideSearch(t, { knowledgeHit: true });
      expect(d.action, t).toBe('none');
      expect(d.reason, t).toBe('knowledge_base');
    }
  });

  it('does not treat ordinary questions as company lookups', () => {
    for (const t of ['Do you know how to cook rice?', 'What is Machine Learning?', 'What is Java?', 'Do you know what a closure is?']) none(t);
  });
});

describe('search credit protection', () => {
  it('maps paraphrases and word order to one cache key', () => {
    expect(normalizeQuery('latest artificial intelligence news')).toBe(normalizeQuery('newest AI news'));
    expect(cacheKey('search:news', normalizeQuery('latest ai news'))).toBe(cacheKey('search:news', normalizeQuery('ai news latest')));
    expect(cacheKey('search:news', normalizeQuery('ghana news'))).not.toBe(cacheKey('search:news', normalizeQuery('nigeria news')));
  });

  it('reuses a fresh search for a same-meaning question, never for a different subject', () => {
    const now = Date.parse('2026-11-07T10:00:00Z');
    const entry = (query: string, v: number[]): CacheEntry => ({
      key: query,
      query,
      provider: 'serpapi',
      results: [result(1)],
      createdAt: new Date(now - 60_000).toISOString(),
      expiresAt: new Date(now + 3_600_000).toISOString(),
      scope: 'search:web',
      vector: v,
      vectorModel: 'gemini:gemini-embedding-001',
    } as CacheEntry);
    const entries = [entry(normalizeQuery('who is president of ghana'), [1, 0, 0])];
    // paraphrase with the same distinctive words and a close embedding
    expect(findSimilar(entries, 'search:web', normalizeQuery('ghana president who is'), vec([0.95, 0.3, 0]), now)).not.toBeNull();
    // different country: never reused even with a close embedding
    expect(findSimilar(entries, 'search:web', normalizeQuery('who is president of nigeria'), vec([0.99, 0.1, 0]), now)).toBeNull();
    // low similarity
    expect(findSimilar(entries, 'search:web', normalizeQuery('ghana president'), vec([0.5, 0.86, 0]), now)).toBeNull();
    // other scope or expired
    expect(findSimilar(entries, 'search:news', normalizeQuery('ghana president'), vec([1, 0, 0]), now)).toBeNull();
    expect(findSimilar(entries, 'search:web', normalizeQuery('ghana president'), vec([1, 0, 0]), now + 7_200_000)).toBeNull();
  });

  it('serves a similar question from cache through the router (no credit)', async () => {
    const { providers, calls } = fake();
    const svc = new SearchService(providers, Date.now, fastOpts);
    const store = new MemorySearchStore();
    await svc.run({ ...base, store, query: 'who is the president of ghana', intent: 'general', queryVector: vec([1, 0]) });
    const r = await svc.run({ ...base, store, query: 'current president of ghana', intent: 'general', queryVector: vec([0.97, 0.2]) });
    expect(calls.serpapi).toBe(1);
    expect(r.ok && r.cached && r.similar).toBe(true);
  });

  it('keeps the last daily credits for searches the user asks for', async () => {
    const { providers, calls } = fake();
    const svc = new SearchService(providers, Date.now, fastOpts);
    const store = new MemorySearchStore();
    const limits = { ...DEFAULT_LIMITS, serpapi: { daily: 3, monthly: 100 }, tavily: { daily: 0, monthly: 0 }, autoReserve: 2 };
    const a = await svc.run({ uid: 'u1', limits, store, query: 'q one', intent: 'general', priority: 'auto' });
    const b = await svc.run({ uid: 'u1', limits, store, query: 'q two', intent: 'general', priority: 'auto' });
    const c = await svc.run({ uid: 'u1', limits, store, query: 'q three', intent: 'general', priority: 'explicit' });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    expect(c.ok).toBe(true);
    expect(calls).toMatchObject({ serpapi: 2, tavily: 0 });
  });

  it('stops searching when every provider is exhausted, without switching to anything else', async () => {
    const { providers, calls } = fake();
    const svc = new SearchService(providers, Date.now, fastOpts);
    const store = new MemorySearchStore();
    const limits = { ...DEFAULT_LIMITS, serpapi: { daily: 0, monthly: 0 }, tavily: { daily: 0, monthly: 0 } };
    const r = await svc.run({ uid: 'u1', limits, store, query: 'latest news', intent: 'news', priority: 'explicit' });
    expect(r.ok).toBe(false);
    expect(calls).toMatchObject({ serpapi: 0, tavily: 0 });
  });

  it('runs one provider call for simultaneous identical searches', async () => {
    const { providers, calls } = fake();
    const svc = new SearchService(providers, Date.now, fastOpts);
    const store = new MemorySearchStore();
    await Promise.all([1, 2, 3].map(() => svc.run({ ...base, store, query: 'same question', intent: 'general' })));
    expect(calls.serpapi).toBe(1);
  });
});

describe('search decision engine: headline-style requests', () => {
  it('searches for "latest ..." requests written without a question word', () => {
    for (const q of [
      'Latest Premier League results',
      'latest premier league results',
      "Today's top stories",
      'Current Bank of Ghana policy rate',
      'Give me the latest AFCON updates',
      'Tell me the latest on the Ghana election',
      'Match results from last night',
      'Premier League results',
    ])
      expect(decideSearch(q).action, q).toBe('search');
  });

  it('still answers timeless or creative requests from the model', () => {
    for (const q of ['Give me a recipe for jollof rice', 'List the planets in the solar system', 'Tell me a joke', 'Show me how to reverse a string in Python'])
      expect(decideSearch(q).action, q).toBe('none');
  });
});
