export type SearchProviderId = 'serpapi' | 'tavily';
export type SearchKind = 'web' | 'news';
/** Why we are searching; drives provider choice and cache lifetime. */
export type SearchIntent = 'general' | 'news' | 'research' | 'reference';

export interface SearchResult {
  title: string;
  url: string;
  /** site / publisher name as reported by the provider, or the hostname */
  site: string;
  snippet: string;
  /** longer page content when the provider returned it (Tavily, extract) */
  content?: string;
  /** only when the provider reported one; never inferred */
  publishedDate?: string;
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

export interface SearchOptions {
  kind: SearchKind;
  max: number;
  /** Tavily only: 'advanced' costs 2 credits, used only by Deep Research */
  depth?: 'basic' | 'advanced';
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
