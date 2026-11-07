/**
 * Central model configuration. Everything model-related that is not
 * discovered at runtime from the provider lives here.
 */
import { env } from '../env.js';

export interface FeaturedModel {
  id: string;
  /** optional nicer label; otherwise the provider's name is used */
  label?: string;
  blurb?: string;
}

/** Shown first in the model picker, in this order. */
export const FEATURED_MODELS: FeaturedModel[] = [
  {
    id: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    blurb: 'Large free reasoning model with a 1M-token context. Text only.',
  },
  {
    id: 'nvidia/nemotron-3.5-super-vl:free',
    blurb: 'Free vision-language model. Understands images.',
  },
  {
    id: 'google/gemma-4-26b-a4b-it:free',
    blurb: 'Fast, free open model from Google. Understands images.',
  },
  { id: 'google/gemini-3.8-flash', blurb: 'Fast, highly capable multimodal model. Paid.' },
  { id: 'nvidia/nemotron-3.5-super-vl', blurb: 'Vision-language model, paid tier.' },
  { id: 'google/gemma-4-26b-a4b-it', blurb: 'Google open model, paid tier with higher limits.' },
];

/**
 * Preferred models per task, best first. Used by the model router only when
 * the selected model cannot handle a request. Free models only; paid models
 * always need the user's approval.
 */
export const TASK_PREFERENCES: Record<'vision' | 'code' | 'longContext' | 'general', string[]> = {
  // Providers are interleaved so a fallback chain never depends on one provider's quota.
  vision: [
    'nvidia/nemotron-3.5-super-vl:free',
    'gemini:gemini-3.5-flash',
    'google/gemma-4-31b-it:free',
    'gemini:gemini-3.8-flash',
    'google/gemma-4-26b-a4b-it:free',
  ],
  code: ['cohere/north-mini-code:free', 'gemini:gemini-3.5-flash', 'gemini:gemini-3.8-flash'],
  longContext: ['gemini:gemini-3.5-flash', 'gemini:gemini-3.8-flash', 'nvidia/nemotron-3.5-super-vl:free', 'nvidia/nemotron-3-ultra-550b-a55b:free'],
  general: [
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'gemini:gemini-3.5-flash',
    'google/gemma-4-31b-it:free',
    'gemini:gemini-3.8-flash',
    'google/gemma-4-26b-a4b-it:free',
  ],
};

export function modelConfig() {
  const e = env();
  return {
    defaultModel: e.defaultModel ?? 'nvidia/nemotron-3-ultra-550b-a55b:free',
    fallbackModels: e.fallbackModels ?? [
      'gemini:gemini-3.5-flash',
      'nvidia/nemotron-3.5-super-vl:free',
      'google/gemma-4-26b-a4b-it:free',
      'google/gemma-4-31b-it:free',
    ],
    /** small/fast models for titles, memory extraction and summaries */
    // Gemini Flash-Lite first: background jobs then don't use the 50/day OpenRouter free quota.
    utilityModels: e.utilityModels ?? [
      'gemini:gemini-3.5-flash-lite',
      'google/gemma-4-26b-a4b-it:free',
      'nvidia/nemotron-3.5-super-vl:free',
      'nvidia/nemotron-3-ultra-550b-a55b:free',
    ],
    embeddingModels: e.embeddingModels ?? [
      'gemini:gemini-embedding-001',
      'nvidia/nemotron-3.5-embed-1b:free',
      'nvidia/nemotron-3-embed-1b:free',
      'openai/text-embedding-3-small',
    ],
    maxOutputTokens: 8192,
  };
}
