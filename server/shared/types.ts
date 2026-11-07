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
  free: boolean;
  /** USD per 1M tokens, when known */
  pricing?: { prompt: number; completion: number };
  capabilities: {
    vision: boolean;
    tools: boolean;
    reasoning: boolean;
    structuredOutput: boolean;
    streaming: boolean;
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

export interface AppCapabilities {
  searchAvailable: boolean;
  searchProvider: string | null;
  embeddingsAvailable: boolean;
  providers: string[];
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
    webSearch: boolean;
    memory: boolean;
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
