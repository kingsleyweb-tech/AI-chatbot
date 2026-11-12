import { apiKeyFor, chargeProviderRequest, environmentDisabled, envOf } from '../environments/index.js';
export type SearchProviderId = 'serpapi' | 'tavily';
export type SearchKind = 'web' | 'news';
/** Why we are searching; drives provider choice and cache lifetime. */
/** live: fast-changing facts (prices, weather, scores), cached briefly */
export type SearchIntent = 'general' | 'news' | 'live' | 'research' | 'reference';

export interface SearchResult {
  title: string;
  url: string;
  /** site / publisher name as reported by the provider, or the hostname */
  site: string;
  snippet: string;
  /** longer page content when the provider returned it (Tavily, extract) */
  content?: string;
  /** only when the provider reported one; never inferred. ISO 8601 when the provider's wording could be
   *  resolved at retrieval time ("3 hours ago" -> exact time), otherwise the provider's own text */
  publishedDate?: string;
  /** the provider's original date wording, kept for transparency ("3 hours ago") */
  dateText?: string;
}

export interface SearchResponse {
  results: SearchResult[];
  /** direct answer box text, when the provider returned one */
  answer?: string;
  /** provider credits this call consumed */
  credits: number;
}

export interface ExtractResult {
  url: string;
  title?: string;
  content: string;
}

export interface AccountUsage {
  used: number;
  limit: number;
  /** remaining in the provider's current billing period */
  remaining: number;
  plan?: string;
  renews?: string;
}

export type SearchErrorCode = 'not_configured' | 'key' | 'quota' | 'rate' | 'failed' | 'timeout';

export class SearchError extends Error {
  constructor(
    readonly provider: SearchProviderId,
    readonly code: SearchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SearchError';
  }
}

/** The search key of the current API environment ('' when it has none or is switched off). */
export function searchKey(p: SearchProviderId): string {
  try {
    const e = envOf(p);
    return environmentDisabled(p, e) ? '' : apiKeyFor(p, e);
  } catch {
    return '';
  }
}

/** Count one search request in its API environment; a ceiling or switch-off becomes a SearchError. */
export async function chargeSearch(p: SearchProviderId): Promise<void> {
  try {
    await chargeProviderRequest(p);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Search is unavailable.';
    throw new SearchError(p, (err as { code?: string }).code === 'environment_limit' ? 'quota' : 'not_configured', message);
  }
}

export interface SearchOptions {
  kind: SearchKind;
  max: number;
  /** Tavily only: 'advanced' costs 2 credits, used only by Deep Research */
  depth?: 'basic' | 'advanced';
  /** restrict results to roughly this recent period (SerpAPI tbs=qdr, Tavily time_range); dates are re-checked after */
  freshness?: 'hour' | 'day' | 'week' | 'month' | 'year';
  /** sort by date instead of relevance (SerpAPI news) */
  sortByDate?: boolean;
  /** country focus: Google country code (SerpAPI gl) and Tavily country name */
  region?: { gl?: string; country?: string };
  signal?: AbortSignal;
}

export interface SearchProvider {
  readonly id: SearchProviderId;
  readonly label: string;
  isConfigured(): boolean;
  search(query: string, opts: SearchOptions): Promise<SearchResponse>;
  /** Provider-reported plan usage; never costs credits. */
  accountUsage(signal?: AbortSignal): Promise<AccountUsage | null>;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
