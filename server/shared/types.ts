/**
 * Types shared between the browser client and the serverless backend.
 * Keep this file free of runtime imports so both sides can use it.
 */

export type Modality = 'text' | 'image' | 'file' | 'audio' | 'video';

export interface ModelInfo {
  id: string;
  name: string;
  provider: string; // e.g. "openrouter"
  vendor: string; // e.g. "google", "nvidia"
  description: string;
  contextLength: number;
  inputModalities: Modality[];
  outputModalities: Modality[];
  free: boolean;
  /** USD per 1M tokens, when known */
  pricing?: { prompt: number; completion: number };
  capabilities: {
    /** accepts image input */
    vision: boolean;
    audioInput: boolean;
    /** accepts native file (PDF) input */
    fileInput: boolean;
    /** can produce images (shown only; image generation is not used in this app) */
    imageOutput: boolean;
    audioOutput: boolean;
    tools: boolean;
    reasoning: boolean;
    structuredOutput: boolean;
    streaming: boolean;
    /** listed as a preferred coding model in server config (not guessed) */
    code: boolean;
  };
  /** true when the model is listed by the provider right now */
  available: boolean;
  /** curated models appear first in the picker */
  featured: boolean;
}

export interface ModelCatalog {
  models: ModelInfo[];
  defaultModel: string;
  fallbackModels: string[];
  /** whether the account behind the provider key can use paid models */
  paidAvailable: boolean | null;
  fetchedAt: string;
}

export type SearchProviderId = 'serpapi' | 'tavily';

export interface AppCapabilities {
  searchAvailable: boolean;
  /** label of the primary configured provider */
  searchProvider: string | null;
  searchProviders: { id: SearchProviderId; label: string; configured: boolean }[];
  embeddingsAvailable: boolean;
  providers: string[];
}

export interface SearchLimits {
  serpapi: { daily: number; monthly: number };
  tavily: { daily: number; monthly: number };
  research: { maxSearches: number; maxPageReads: number };
  cacheTtlHours: { news: number; general: number; reference: number };
  providerReserve: number;
}

/** What happened with web search for one answer (persisted on the message). */
export interface SearchInfo {
  status: 'ok' | 'unavailable';
  mode: 'search' | 'extract' | 'research';
  provider: SearchProviderId | null;
  query: string;
  cached: boolean;
  /** ISO time the cached results were fetched */
  cachedAt?: string;
  /** why search was used: the user asked, or the auto heuristic */
  trigger: 'manual' | 'auto' | 'url' | 'research';
  message?: string;
}

export interface ResearchStep {
  kind: 'plan' | 'search' | 'read' | 'skip' | 'done';
  text: string;
  provider?: SearchProviderId | null;
  cached?: boolean;
}

export interface ImageAttachment {
  kind: 'image';
  name: string;
  mime: string;
  /** compressed data URL (jpeg/webp), kept small enough for Firestore */
  dataUrl: string;
  width?: number;
  height?: number;
}

export interface DocumentAttachment {
  kind: 'document';
  documentId: string;
  name: string;
  mime: string;
}

export type Attachment = ImageAttachment | DocumentAttachment;

export interface Source {
  index: number;
  title: string;
  url: string;
  snippet?: string;
  kind: 'web' | 'document';
  /** publisher / site name (web) */
  site?: string;
  /** only when the provider reported it */
  publishedDate?: string;
  provider?: SearchProviderId;
}

/** The reply came from a different model than the selected one (one reply only). */
export interface RouteInfo {
  from: string;
  to: string;
  fromName: string;
  toName: string;
  reason: string;
}

/** Only a paid model can handle the request; the user must approve it. */
export interface ApprovalRequest {
  model: string;
  modelName: string;
  reason: string;
  /** rough USD estimate from catalog pricing; not a bill */
  estCost: number | null;
  /** the provider account has no credits, so the request cannot run yet */
  creditsNeeded: boolean;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  attachments?: Attachment[];
}

export interface ChatRequestBody {
  conversationId: string;
  assistantMessageId: string;
  model: string;
  messages: ChatTurn[];
  options: {
    /** force a web search for this message */
    webSearch: boolean;
    /** let the server decide whether this message needs current information */
    autoSearch?: boolean;
    /** multi-step research with a fixed search budget */
    deepResearch?: boolean;
    memory: boolean;
    /** a paid model the user explicitly approved for this one request */
    approvedPaidModel?: string | null;
    documentIds: string[];
    projectId?: string | null;
  };
}

export interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost?: number;
}

export type StreamEvent =
  | { type: 'start'; model: string }
  | { type: 'notice'; message: string; model?: string }
  | { type: 'sources'; sources: Source[] }
  | { type: 'search'; info: SearchInfo }
  | { type: 'route'; info: RouteInfo }
  | { type: 'approval_required'; approval: ApprovalRequest }
  | { type: 'research'; step: ResearchStep }
  | { type: 'context'; memories: number; documents: number; conversations: number }
  | { type: 'reasoning'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'usage'; usage: UsageInfo }
  | { type: 'error'; code: string; message: string; retryable: boolean; suggestion?: string }
  | { type: 'done'; finishReason: string | null; model: string };

export type MessageStatus = 'complete' | 'streaming' | 'stopped' | 'error';

export const MEMORY_CATEGORIES = [
  'preference',
  'personal',
  'project',
  'technical',
  'instruction',
  'decision',
  'fact',
  'topic',
] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

/** Follow-up prompts for the action row under assistant messages. */
export const QUICK_ACTIONS = {
  explain: 'Explain your previous answer further, in more depth and with an example.',
  summarize: 'Summarize your previous answer concisely.',
  shorter: 'Rewrite your previous answer to be much shorter while keeping the key points.',
  longer: 'Rewrite your previous answer with more detail and depth.',
  continue: 'Continue writing from exactly where your previous answer ended. Do not repeat content.',
  translate: 'Translate your previous answer into {language}. Keep the formatting intact.',
} as const;
export type QuickAction = keyof typeof QUICK_ACTIONS;
