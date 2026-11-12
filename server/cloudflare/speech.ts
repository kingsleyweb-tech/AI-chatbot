/**
 * Speech-to-text, text-to-speech and translation through Cloudflare Workers AI (server-only).
 * Request and response formats were verified against the live API (2026-11):
 *  - Whisper large v3 turbo: JSON {audio: base64} -> {result: {text, transcription_info: {language, duration}}}
 *  - Aura-1: JSON {text, encoding: 'mp3'} -> audio/mpeg bytes
 *  - m2m100: JSON {text, source_lang, target_lang} -> {result: {translated_text}}
 *  - Smart Turn v2: JSON {audio: base64 float32 PCM 16 kHz, dtype: 'float32'} -> {result: {is_complete, probability}}
 * Every response carries its exact cost in the `cf-ai-neurons` header.
 */
import { STT_MODEL, TRANSLATE_MODEL, TTS_MODEL, TURN_MODEL } from '../config/speech.js';
import { ProviderError } from '../providers/types.js';
import { aiBase, authHeader, currentCloudflareAccount, mapCloudflareError, neuronsOf } from './client.js';

/** Scripted stand-in for tests and local end-to-end runs (no request reaches Cloudflare). */
export interface SpeechFake {
  transcribe(audio: Uint8Array): Promise<{ text: string; language: string | null; duration: number; neurons: number }>;
  speak(text: string): Promise<{ bytes: Uint8Array; neurons: number }>;
  translate(text: string, source: string, target: string): Promise<{ text: string; neurons: number }>;
  turn?(pcm: Float32Array): Promise<TurnVerdict>;
}
let fake: SpeechFake | null = null;
export function setSpeechFake(f: SpeechFake | null) {
  fake = f;
}

async function run(model: string, body: unknown, signal: AbortSignal | undefined, timeoutMs: number): Promise<Response> {
  const account = currentCloudflareAccount(); // chosen by the caller's Neuron reservation
  const signals = [AbortSignal.timeout(timeoutMs), signal].filter(Boolean) as AbortSignal[];
  let res: Response;
  try {
    res = await fetch(`${aiBase(account)}/run/${model}`, {
      method: 'POST',
      headers: { ...authHeader(account), 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    if (err instanceof ProviderError) throw err;
    throw new ProviderError('timeout', 'Cloudflare Workers AI took too long to respond.', 504);
  }
  if (!res.ok) {
    const e = mapCloudflareError(res.status, await res.text(), account, res.headers.get('retry-after'));
    (e as ProviderError & { neurons?: number }).neurons = neuronsOf(res);
    throw e;
  }
  return res;
}

export interface Transcript {
  text: string;
  /** Whisper's language code ("en", "fr"), when it reported one */
  language: string | null;
  /** seconds of audio */
  duration: number;
  neurons: number;
}

export async function transcribe(audio: Uint8Array, signal?: AbortSignal): Promise<Transcript> {
  if (fake) return fake.transcribe(audio);
  const res = await run(STT_MODEL, { audio: Buffer.from(audio).toString('base64') }, signal, 60_000);
  const neurons = neuronsOf(res);
  const data = (await res.json()) as { result?: { text?: string; transcription_info?: { language?: string; duration?: number } } };
  const r = data.result ?? {};
  return {
    text: (r.text ?? '').trim(),
    language: r.transcription_info?.language ?? null,
    duration: Number(r.transcription_info?.duration ?? 0) || 0,
    neurons,
  };
}

/** MP3 audio of `text` in the natural voice. */
export async function speak(text: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; neurons: number }> {
  if (fake) return fake.speak(text);
  const res = await run(TTS_MODEL, { text, encoding: 'mp3' }, signal, 45_000);
  const neurons = neuronsOf(res);
  const bytes = new Uint8Array(await res.arrayBuffer());
  // MP3 frame sync (0xFFE…) or an ID3 tag; anything else is not audio
  const isMp3 = bytes.length > 3 && ((bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) || (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33));
  if (!isMp3) throw new ProviderError('provider_error', 'The voice model returned no audio.', 502);
  return { bytes, neurons };
}

export async function translateText(text: string, source: string, target: string, signal?: AbortSignal): Promise<{ text: string; neurons: number }> {
  if (fake) return fake.translate(text, source, target);
  const res = await run(TRANSLATE_MODEL, { text, source_lang: source, target_lang: target }, signal, 45_000);
  const neurons = neuronsOf(res);
  const data = (await res.json()) as { result?: { translated_text?: string; usage?: { neurons?: number } } };
  const out = data.result?.translated_text;
  if (typeof out !== 'string') throw new ProviderError('provider_error', 'The translation model returned no text.', 502);
  return { text: out, neurons: neurons || Number(data.result?.usage?.neurons ?? 0) || 0 };
}

export interface TurnVerdict {
  /** the speaker sounds finished */
  complete: boolean;
  probability: number;
  neurons: number;
}

/** Whether the speech in `pcm` (16 kHz mono float32, the last few seconds) sounds like a finished turn. */
export async function detectTurnEnd(pcm: Float32Array, signal?: AbortSignal): Promise<TurnVerdict> {
  if (fake?.turn) return fake.turn(pcm);
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const res = await run(TURN_MODEL, { audio: Buffer.from(bytes).toString('base64'), dtype: 'float32' }, signal, 10_000);
  const neurons = neuronsOf(res);
  const data = (await res.json()) as { result?: { is_complete?: boolean; probability?: number } };
  const p = Number(data.result?.probability);
  if (typeof data.result?.is_complete !== 'boolean' || !Number.isFinite(p)) throw new ProviderError('provider_error', 'The turn model returned no answer.', 502);
  return { complete: data.result.is_complete, probability: p, neurons };
}
