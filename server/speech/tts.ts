/**
 * Text-to-speech providers for the natural voice charged against Cloudflare Neurons: Cloudflare Workers AI (Deepgram Aura-1).
 * ElevenLabs is the other natural-voice provider. It is billed in ElevenLabs credits with its own caps
 * and streams its audio, so it lives in server/elevenlabs (routed from /api/speech when the request
 * says provider: 'elevenlabs'); the browser player (MP3 per sentence group) is the same for both.
 */
import { TTS_MAX_CHARS, TTS_MODEL, TTS_NEURONS_PER_CHAR } from '../config/speech.js';
import { speak as cloudflareSpeak } from '../cloudflare/speech.js';

export interface TtsProvider {
  id: string;
  /** model name used for usage records and the daily share */
  model: string;
  /** most characters per request */
  maxChars: number;
  /** expected cost per character, in the unit the daily share is counted in (Cloudflare Neurons) */
  costPerChar: number;
  /** MP3 audio of `text` and its exact cost */
  speak(text: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; neurons: number }>;
}

const providers: Record<string, TtsProvider> = {
  cloudflare: {
    id: 'cloudflare',
    model: TTS_MODEL,
    maxChars: TTS_MAX_CHARS,
    costPerChar: TTS_NEURONS_PER_CHAR,
    speak: cloudflareSpeak,
  },
};

/** The natural-voice provider in use (Cloudflare; no paid provider is ever chosen automatically). */
export function ttsProvider(): TtsProvider {
  return providers.cloudflare;
}
