/**
 * Speech and translation through Cloudflare Workers AI, for signed-in, approved users only.
 *
 *  POST /api/speech?action=transcribe   body: the recording (audio/webm, audio/mp4, audio/mpeg, audio/wav, audio/ogg …)
 *      -> { text, language, duration }
 *  POST /api/speech?action=turn        body: the last seconds of speech, 16 kHz mono 16-bit PCM
 *      (application/octet-stream) -> { complete, probability } (Voice Mode end-of-turn hint)
 *  POST /api/speech  {action:'speak', text}            -> audio/mpeg (natural voice, capped; 429 when the share is used)
 *  POST /api/speech  {action:'translate', text, target, source?} -> { text, source, target }
 *  GET  /api/speech                                    -> what is available today (no model call)
 *
 * ElevenLabs (optional additional voice provider; off until an administrator enables it):
 *  POST /api/speech  {action:'speak', provider:'elevenlabs', text, voiceId?, model?, speed?} -> audio/mpeg (streamed)
 *  POST /api/speech  {action:'speak', provider:'elevenlabs', preview:true, voiceId}       -> a short sample of a voice
 *  POST /api/speech  {action:'elevenAdmin', ...}   administrators only: settings, status, Voice Design
 * The ElevenLabs key stays on the server; every request is checked against credit caps first.
 *
 * Every call reserves its expected cost against the app-wide free-allowance cap first and records the
 * exact cost afterwards. Nothing here ever switches to paid usage. Recordings and texts are passed to
 * Cloudflare and not stored by Atlas AI.
 */
import { waitUntil } from '@vercel/functions';
import { z } from 'zod';
import { requireAllowedUser } from '../server/access.js';
import { cloudflareConfigured } from '../server/cloudflare/client.js';
import { modelNeuronsToday, reserveNeurons, userTurnChecksToday, userVoiceNeuronsToday, utcDay } from '../server/cloudflare/budget.js';
import { detectTurnEnd, transcribe, translateText } from '../server/cloudflare/speech.js';
import {
  MAX_AUDIO_BYTES,
  STT_ESTIMATE,
  STT_MODEL,
  TRANSLATE_LANGUAGES,
  TRANSLATE_MAX_CHARS,
  TRANSLATE_MODEL,
  TTS_APP_DAILY_NEURONS,
  TTS_MAX_CHARS,
  TTS_MODEL,
  TTS_NEURONS_PER_CHAR,
  TTS_USER_DAILY_NEURONS,
  TRANSLATE_CODES,
  TURN_MAX_SECONDS,
  TURN_MODEL,
  TURN_USER_DAILY_REQUESTS,
  WHISPER_TO_LANGUAGE,
} from '../server/config/speech.js';
import type { Firestore } from '../server/firestore.js';
import { handle, HttpError, json, readJson } from '../server/http.js';
import { ProviderError } from '../server/providers/types.js';
import { detectLanguage, mapLimit, planTranslation } from '../server/speech/translate.js';
import { ttsProvider } from '../server/speech/tts.js';
import { elevenGet, elevenAdmin, elevenAdminBody, elevenSpeak, elevenSpeakFields } from '../server/elevenlabs/routes.js';

const AUDIO_TYPES = /^audio\/(webm|ogg|mp4|m4a|x-m4a|aac|mpeg|mp3|wav|x-wav|wave|flac|x-flac)(;.*)?$/i;

const body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('speak'), text: z.string().max(TTS_MAX_CHARS * 2).default(''), ...elevenSpeakFields }),
  elevenAdminBody,
  z.object({ action: z.literal('translate'), text: z.string().min(1).max(TRANSLATE_MAX_CHARS), target: z.string().max(30), source: z.string().max(30).optional() }),
]);

function notConfigured(): never {
  throw new HttpError(503, 'speech_unavailable', 'Cloudflare Workers AI is not set up on this server.');
}

/** Turn a budget refusal or provider error into a user-facing HTTP error. */
function fail(err: unknown, what: string): never {
  if (err instanceof HttpError) throw err;
  if (err instanceof ProviderError) {
    if (err.code === 'daily_limit') throw new HttpError(429, 'daily_limit', `Today’s free Cloudflare allowance is used up, so ${what} is paused until 00:00 UTC. Atlas AI never switches to paid usage.`);
    throw new HttpError(err.status >= 500 ? 502 : err.status, err.code, err.message);
  }
  throw err;
}

/** End-of-turn checks cost a fraction of a Neuron; reserve a little so the free cap is never passed. */
const TURN_NEURON_ESTIMATE = 1;

async function reserve(db: Firestore, estimate: number, what: string) {
  const r = await reserveNeurons(db, estimate);
  if (!r.ok) {
    if (r.reason === 'app_cap') throw new HttpError(429, 'daily_limit', `Today’s free Cloudflare allowance is used up, so ${what} is paused until 00:00 UTC. Atlas AI never switches to paid usage.`);
    throw new HttpError(503, 'speech_unavailable', `${what[0].toUpperCase()}${what.slice(1)} is temporarily unavailable. Please try again shortly.`);
  }
  return r;
}

export const GET = handle(async (request) => {
  const { db, user, admin } = await requireAllowedUser(request);
  const elevenlabs = await elevenGet(db, user.uid, admin);
  if (!cloudflareConfigured()) return json({ configured: false, languages: TRANSLATE_LANGUAGES, elevenlabs }, { headers: { 'cache-control': 'no-store' } });
  let voiceLeft: number;
  try {
    const [app, mine] = await Promise.all([modelNeuronsToday(db, TTS_MODEL), userVoiceNeuronsToday(db, user.uid, 'tts')]);
    voiceLeft = Math.max(0, Math.min(TTS_APP_DAILY_NEURONS - app, TTS_USER_DAILY_NEURONS - mine));
  } catch {
    voiceLeft = 0;
  }
  return json(
    {
      configured: true,
      day: utcDay(),
      languages: TRANSLATE_LANGUAGES,
      naturalVoice: { available: voiceLeft >= TTS_NEURONS_PER_CHAR * 40, charactersLeft: Math.floor(voiceLeft / TTS_NEURONS_PER_CHAR) },
      elevenlabs,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
});

export const POST = handle(async (request) => {
  const url = new URL(request.url);
  const ctx = await requireAllowedUser(request);
  const { db, user } = ctx;
  const action = url.searchParams.get('action');
  if ((action === 'turn' || action === 'transcribe') && !cloudflareConfigured()) notConfigured();

  /* ---------------- end of turn (Voice Mode) ---------------- */
  if (url.searchParams.get('action') === 'turn') {
    const raw = new Uint8Array(await request.arrayBuffer());
    const maxBytes = TURN_MAX_SECONDS * 16_000 * 2;
    if (raw.byteLength < 16_000 * 2 * 0.3 || raw.byteLength > maxBytes || raw.byteLength % 2) throw new HttpError(400, 'bad_audio', 'Send 0.3 to 8 seconds of 16 kHz 16-bit audio.');
    if ((await userTurnChecksToday(db, user.uid).catch(() => 0)) >= TURN_USER_DAILY_REQUESTS) throw new HttpError(429, 'turn_limit', 'Today’s end-of-turn checks are used up.');
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const pcm = new Float32Array(raw.byteLength / 2);
    for (let i = 0; i < pcm.length; i++) pcm[i] = view.getInt16(i * 2, true) / 32768;
    // inside the free daily Neuron allowance only, like every other Cloudflare call
    const r = await reserve(db, TURN_NEURON_ESTIMATE, 'end-of-turn detection');
    try {
      const v = await detectTurnEnd(pcm, request.signal);
      await r.settle(v.neurons, { uid: user.uid, model: TURN_MODEL, type: 'turn', ok: true }).catch(() => undefined);
      return json({ complete: v.complete, probability: v.probability }, { headers: { 'cache-control': 'no-store' } });
    } catch (err) {
      await r.settle((err as { neurons?: number }).neurons ?? 0, { uid: user.uid, model: TURN_MODEL, type: 'turn', ok: false, error: err instanceof ProviderError ? err.code : 'aborted' }).catch(() => undefined);
      fail(err, 'end-of-turn detection');
    }
  }

  /* ---------------- speech-to-text ---------------- */
  if (url.searchParams.get('action') === 'transcribe') {
    const type = request.headers.get('content-type') ?? '';
    if (!AUDIO_TYPES.test(type)) throw new HttpError(415, 'unsupported_audio', 'This audio format is not supported. Use MP3, M4A, WAV, OGG, WebM or FLAC.');
    const declared = Number(request.headers.get('content-length') ?? 0);
    if (declared > MAX_AUDIO_BYTES) throw new HttpError(413, 'audio_too_large', 'This recording is too long. Keep it under about 2 minutes (4 MB).');
    const audio = new Uint8Array(await request.arrayBuffer());
    if (audio.byteLength > MAX_AUDIO_BYTES) throw new HttpError(413, 'audio_too_large', 'This recording is too long. Keep it under about 2 minutes (4 MB).');
    if (audio.byteLength < 200) throw new HttpError(400, 'audio_empty', 'The recording was empty. Please try again.');
    const r = await reserve(db, STT_ESTIMATE, 'voice input');
    try {
      const t = await transcribe(audio, request.signal);
      await r.settle(t.neurons, { uid: user.uid, model: STT_MODEL, type: 'stt', ok: true });
      return json({ text: t.text, language: t.language ? WHISPER_TO_LANGUAGE[t.language] ?? t.language : null, duration: t.duration });
    } catch (err) {
      await r.settle((err as { neurons?: number }).neurons ?? 0, { uid: user.uid, model: STT_MODEL, type: 'stt', ok: false, error: err instanceof ProviderError ? err.code : 'aborted' });
      fail(err, 'voice input');
    }
  }

  const b = body.safeParse(await readJson(request, 50_000));
  if (!b.success) throw new HttpError(400, 'bad_request', 'Invalid request.');

  /* ---------------- ElevenLabs (separate credits, separate caps) ---------------- */
  if (b.data.action === 'elevenAdmin') return elevenAdmin(ctx, b.data, request.signal);
  if (b.data.action === 'speak' && b.data.provider === 'elevenlabs') return elevenSpeak(ctx, b.data, request.signal, (p) => waitUntil(p));
  if (!cloudflareConfigured()) notConfigured();

  /* ---------------- natural voice (text-to-speech) ---------------- */
  if (b.data.action === 'speak') {
    if (!b.data.text.trim()) throw new HttpError(400, 'bad_request', 'Invalid request.');
    const tts = ttsProvider();
    const text = b.data.text.replace(/\s+/g, ' ').trim().slice(0, Math.min(TTS_MAX_CHARS, tts.maxChars));
    const estimate = Math.ceil(text.length * tts.costPerChar);
    const [app, mine] = await Promise.all([modelNeuronsToday(db, tts.model), userVoiceNeuronsToday(db, user.uid, 'tts')]).catch(() => [Infinity, Infinity]);
    if (app + estimate > TTS_APP_DAILY_NEURONS || mine + estimate > TTS_USER_DAILY_NEURONS) {
      throw new HttpError(429, 'voice_allowance', 'Today’s natural-voice allowance is used up; the device voice is used until 00:00 UTC.');
    }
    const r = await reserve(db, estimate, 'the natural voice');
    try {
      const out = await tts.speak(text, request.signal);
      await r.settle(out.neurons, { uid: user.uid, model: tts.model, type: 'tts', ok: true });
      return new Response(new Uint8Array(out.bytes), { headers: { 'content-type': 'audio/mpeg', 'cache-control': 'private, max-age=86400' } });
    } catch (err) {
      await r.settle((err as { neurons?: number }).neurons ?? 0, { uid: user.uid, model: tts.model, type: 'tts', ok: false, error: err instanceof ProviderError ? err.code : 'aborted' });
      fail(err, 'the natural voice');
    }
  }

  /* ---------------- translation ---------------- */
  const { text, target } = b.data;
  if (!TRANSLATE_CODES.has(target)) throw new HttpError(400, 'unsupported_language', `Translation into “${target}” is not available.`);
  const source = b.data.source && b.data.source !== 'auto' ? b.data.source : detectLanguage(text);
  if (!source) throw new HttpError(422, 'source_unknown', 'Atlas AI could not tell which language this text is in. Choose the source language and try again.');
  if (!TRANSLATE_CODES.has(source)) throw new HttpError(400, 'unsupported_language', `Translation from “${source}” is not available.`);
  if (source === target) return json({ text, source, target });
  const pieces = planTranslation(text);
  const work = pieces.filter((p) => p.text);
  // about 1.4 tokens per word each way at 31,050 Neurons per million tokens, rounded up generously
  const estimate = Math.ceil((text.length / 4) * 2 * 0.03105) + work.length * 0.05 + 2;
  const r = await reserve(db, estimate, 'translation');
  let neurons = 0;
  try {
    const translated = await mapLimit(work, 4, async (p) => {
      const out = await translateText(p.text, source, target, request.signal);
      neurons += out.neurons;
      return out.text.trim();
    });
    let k = 0;
    const result = pieces.map((p) => (p.text ? p.render(translated[k++]) : p.render(''))).join('');
    await r.settle(neurons, { uid: user.uid, model: TRANSLATE_MODEL, type: 'translate', ok: true });
    return json({ text: result, source, target });
  } catch (err) {
    await r.settle(neurons + ((err as { neurons?: number }).neurons ?? 0), { uid: user.uid, model: TRANSLATE_MODEL, type: 'translate', ok: false, error: err instanceof ProviderError ? err.code : 'aborted' });
    fail(err, 'translation');
  }
});
