import type { ModelInfo, UsageInfo } from '../shared/types.js';

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

export interface CompletionParams {
  model: string;
  messages: ProviderMessage[];
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
  /** ask for a JSON object response when the model supports it */
  json?: boolean;
  /** give up (and let the caller fall back) if no response starts within this time */
  firstByteTimeoutMs?: number;
}

export type ProviderChunk =
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'usage'; usage: UsageInfo }
  | { type: 'finish'; reason: string | null; model: string };

export type ProviderErrorCode =
  | 'invalid_key'
  | 'insufficient_credits'
  | 'model_unavailable'
  | 'rate_limited'
  | 'daily_limit'
  | 'timeout'
  | 'context_too_long'
  | 'unsupported_input'
  | 'moderation'
  | 'bad_request'
  | 'provider_error'
  | 'not_configured'
  /** the model is not an approved free model (Free Models Only policy) */
  | 'paid_blocked'
  /** every approved free model is at its limit right now */
  | 'free_limit';

export class ProviderError extends Error {
  constructor(
    public code: ProviderErrorCode,
    message: string,
    public status = 502,
  ) {
    super(message);
  }
  /** worth retrying the same request on a different model */
  get fallbackable(): boolean {
    return [
      'insufficient_credits',
      'model_unavailable',
      'rate_limited',
      'timeout',
      'unsupported_input',
      'provider_error',
      'paid_blocked',
    ].includes(this.code);
  }
  /** worth retrying later as-is */
  get retryable(): boolean {
    return ['rate_limited', 'timeout', 'provider_error'].includes(this.code);
  }
}

/**
 * Implemented once per AI provider (OpenRouter today; Gemini, OpenAI,
 * Anthropic can be added later without touching the chat engine).
 */
export interface ChatProvider {
  readonly id: string;
  isConfigured(): boolean;
  listModels(): Promise<ModelInfo[]>;
  stream(params: CompletionParams): AsyncGenerator<ProviderChunk>;
  complete(params: CompletionParams): Promise<string>;
  embed?(model: string, inputs: string[], signal?: AbortSignal): Promise<number[][]>;
}
