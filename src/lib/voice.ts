/**
 * Voice features backed by /api/speech (Cloudflare Workers AI, called only from the server):
 *  - recording from the microphone (MediaRecorder) with a live level and silence detection
 *  - speech-to-text (Whisper) of a recording or an uploaded audio file
 *  - the optional natural voice: Cloudflare (Aura-1) or ElevenLabs, each capped; ElevenLabs falls
 *    back to Cloudflare, and Cloudflare to the device voice
 *  - translation that keeps formatting
 * No credentials are ever in the browser: every call carries only the user's Firebase ID token.
 */
import { api, ApiError } from './api';
import { auth } from './firebase';

export interface ElevenVoiceInfo {
  id: string;
  name: string;
  description: string;
  source: 'default' | 'designed';
}

export interface ElevenConfig {
  configured: boolean;
  enabled?: boolean;
  available?: boolean;
  creditsLeft?: number;
  charactersLeft?: number;
  defaultModel?: string;
  defaultVoice?: string;
  models?: { id: string; label: string; description: string; creditsPerChar: number }[];
  voices?: ElevenVoiceInfo[];
  speed?: { min: number; max: number };
}

export interface SpeechConfig {
  configured: boolean;
  languages: { code: string; name: string }[];
  naturalVoice?: { available: boolean; charactersLeft: number };
  elevenlabs?: ElevenConfig;
}

/** Which natural voice to use. Cloudflare is the default; ElevenLabs only when the person chose it. */
export type NaturalVoice = { provider: 'cloudflare' } | { provider: 'elevenlabs'; voiceId: string | null; model: string | null; speed: number };

/** The natural voice from the person's settings. */
export function naturalVoiceFrom(s: { voiceProvider?: string; elevenVoiceId?: string | null; elevenModel?: string | null; elevenSpeed?: number }): NaturalVoice {
  return s.voiceProvider === 'elevenlabs'
    ? { provider: 'elevenlabs', voiceId: s.elevenVoiceId ?? null, model: s.elevenModel ?? null, speed: s.elevenSpeed ?? 1 }
    : { provider: 'cloudflare' };
}

let configCache: { at: number; value: SpeechConfig } | null = null;

/** What the server offers today (cached for a minute; no model call). */
export async function speechConfig(force = false): Promise<SpeechConfig> {
  if (!force && configCache && Date.now() - configCache.at < 60_000) return configCache.value;
  try {
    const value = await api<SpeechConfig>('speech');
    configCache = { at: Date.now(), value };
    return value;
  } catch {
    return { configured: false, languages: [] };
  }
}

export const MAX_RECORDING_SECONDS = 120;
export const MAX_AUDIO_BYTES = 4_000_000;
export const AUDIO_ACCEPT = 'audio/*,.mp3,.m4a,.wav,.ogg,.webm,.flac,.aac';

async function bearer(): Promise<string> {
  const user = auth.currentUser;
  if (!user) throw new ApiError(401, 'unauthenticated', 'Please sign in.');
  return user.getIdToken();
}

async function errorFrom(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    return new ApiError(res.status, body.error?.code ?? `http_${res.status}`, body.error?.message ?? 'Request failed.');
  } catch {
    return new ApiError(res.status, `http_${res.status}`, res.status === 413 ? 'This recording is too long.' : 'Request failed.');
  }
}

/** Speech-to-text of a recording or an audio file. */
export async function transcribeAudio(audio: Blob, signal?: AbortSignal): Promise<{ text: string; language: string | null; duration: number }> {
  if (!navigator.onLine) throw new ApiError(0, 'offline', 'You are offline.');
  if (audio.size > MAX_AUDIO_BYTES) throw new ApiError(413, 'audio_too_large', 'This audio is too long. Keep it under about 2 minutes (4 MB).');
  const type = audio.type || 'audio/webm';
  const res = await fetch('/api/speech?action=transcribe', {
    method: 'POST',
    headers: { authorization: `Bearer ${await bearer()}`, 'content-type': type },
    body: audio,
    signal,
  });
  if (!res.ok) throw await errorFrom(res);
  return res.json();
}

const retryable = (err: unknown) => {
  const e = err as { status?: number; name?: string };
  return e?.name === 'TypeError' || e?.status === 0 || e?.status === 502 || e?.status === 503 || e?.status === 504;
};

/** Speech-to-text with one retry after a dropped connection or a temporary server problem. */
export async function transcribeWithRetry(audio: Blob, signal?: AbortSignal): Promise<{ text: string; language: string | null; duration: number }> {
  try {
    return await transcribeAudio(audio, signal);
  } catch (err) {
    if (!retryable(err) || signal?.aborted || !navigator.onLine) throw err;
    await new Promise((r) => setTimeout(r, 1200));
    return transcribeAudio(audio, signal);
  }
}

/**
 * Voice Mode end-of-turn hint: does the speech in `pcm` (16 kHz, 16-bit, last few seconds) sound
 * finished? null when the check could not be made in time (the caller then relies on the pause).
 */
export async function checkTurnEnd(pcm: Int16Array, timeoutMs = 1500): Promise<boolean | null> {
  if (!navigator.onLine || pcm.length < 16_000 * 0.3) return null;
  try {
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const res = await fetch('/api/speech?action=turn', {
      method: 'POST',
      headers: { authorization: `Bearer ${await bearer()}`, 'content-type': 'application/octet-stream' },
      body: bytes.slice(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const v = (await res.json()) as { complete?: boolean; probability?: number };
    return typeof v.complete === 'boolean' ? v.complete : null;
  } catch {
    return null;
  }
}

/* ------------------------------ microphone recording ------------------------------ */

/** Formats the browser can record that Whisper accepts (Safari records MP4/AAC). */
function pickMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg']) {
    if (MediaRecorder.isTypeSupported?.(m)) return m;
  }
  return undefined;
}

export const recordingSupported = () =>
  typeof window !== 'undefined' && typeof MediaRecorder !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);

export function micErrorMessage(err: unknown): string {
  const name = (err as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone access is blocked. Allow the microphone for this site in your browser settings, then try again.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found on this device.';
  if (name === 'NotReadableError') return 'The microphone is being used by another app. Close it and try again.';
  return 'The microphone could not be started.';
}

export interface RecorderOptions {
  /** stop by itself after this much silence once speech was heard (Voice Mode) */
  autoStopSilenceMs?: number;
  /** give up when nothing is said for this long */
  noSpeechTimeoutMs?: number;
  /** 0..1 microphone level, about 20 times a second */
  onLevel?: (level: number) => void;
  /** called once when speech is first heard */
  onSpeech?: () => void;
}

/**
 * One recording. `stop()` resolves with the audio (or null when nothing was said);
 * `cancel()` discards it. The microphone is released either way.
 */
export class Recorder {
  private media: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private timer: number | null = null;
  private maxTimer: number | null = null;
  private chunks: Blob[] = [];
  private heard = false;
  private done: Promise<Blob | null> | null = null;
  private resolve: ((b: Blob | null) => void) | null = null;
  private cancelled = false;
  startedAt = 0;

  constructor(private opts: RecorderOptions = {}) {}

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const mime = pickMime();
    this.media = new MediaRecorder(this.stream, mime ? { mimeType: mime, audioBitsPerSecond: 32_000 } : undefined);
    this.chunks = [];
    this.done = new Promise((r) => (this.resolve = r));
    this.media.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.media.onstop = () => {
      const type = (this.media?.mimeType || mime || 'audio/webm').split(';')[0];
      const blob = this.cancelled || !this.chunks.length ? null : new Blob(this.chunks, { type });
      this.release();
      this.resolve?.(this.heard || !this.opts.autoStopSilenceMs ? blob : null);
    };
    this.media.start(250);
    this.startedAt = Date.now();
    this.maxTimer = window.setTimeout(() => this.stop(), MAX_RECORDING_SECONDS * 1000);
    this.watchLevel();
  }

  private watchLevel() {
    if (!this.stream || (!this.opts.onLevel && !this.opts.autoStopSilenceMs)) return;
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctx();
      const src = this.ctx.createMediaStreamSource(this.stream);
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      let lastLoud = Date.now();
      let noise = 0.01;
      const started = Date.now();
      this.timer = window.setInterval(() => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const v of data) sum += ((v - 128) / 128) ** 2;
        const rms = Math.sqrt(sum / data.length);
        this.opts.onLevel?.(Math.min(1, rms * 6));
        // adaptive threshold: speech is clearly above the room's noise floor
        if (!this.heard) noise = noise * 0.95 + rms * 0.05;
        const loud = rms > Math.max(0.02, noise * 2.5);
        const now = Date.now();
        if (loud) {
          lastLoud = now;
          if (!this.heard && now - started > 150) {
            this.heard = true;
            this.opts.onSpeech?.();
          }
        }
        if (this.opts.autoStopSilenceMs && this.heard && now - lastLoud > this.opts.autoStopSilenceMs) this.stop();
        if (this.opts.noSpeechTimeoutMs && !this.heard && now - started > this.opts.noSpeechTimeoutMs) this.stop();
      }, 50);
    } catch {
      /* level metering is optional */
    }
  }

  /** Resolves when the recording ends, however it ends (stop, silence, time limit, cancel). */
  get finished(): Promise<Blob | null> {
    return this.done ?? Promise.resolve(null);
  }

  get recording() {
    return this.media?.state === 'recording';
  }

  stop(): Promise<Blob | null> {
    if (this.media && this.media.state !== 'inactive') this.media.stop();
    return this.done ?? Promise.resolve(null);
  }

  cancel() {
    this.cancelled = true;
    if (this.media && this.media.state !== 'inactive') this.media.stop();
    else this.release();
  }

  private release() {
    if (this.timer) window.clearInterval(this.timer);
    if (this.maxTimer) window.clearTimeout(this.maxTimer);
    this.timer = this.maxTimer = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }
}

/* ------------------------------ natural voice ------------------------------ */

const audioCache = new Map<string, string>();
const CACHE_LIMIT = 40;

function remember(key: string, url: string) {
  audioCache.set(key, url);
  if (audioCache.size > CACHE_LIMIT) {
    const [oldest, oldUrl] = audioCache.entries().next().value as [string, string];
    audioCache.delete(oldest);
    URL.revokeObjectURL(oldUrl);
  }
}

async function speakRequest(payload: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const res = await fetch('/api/speech', {
    method: 'POST',
    headers: { authorization: `Bearer ${await bearer()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'speak', ...payload }),
    signal,
  });
  if (!res.ok) throw await errorFrom(res);
  return URL.createObjectURL(await res.blob());
}

/**
 * After an ElevenLabs refusal that will not change within minutes (allowance used, turned off, key
 * or plan), the Cloudflare voice is used for a while without asking ElevenLabs again.
 */
let elevenPausedUntil = 0;
const ELEVEN_PAUSE_MS = 10 * 60_000;

export interface NaturalVoiceContext {
  /** the text spoken just before and after this piece (ElevenLabs joins parts more naturally) */
  previousText?: string;
  nextText?: string;
  /** told when ElevenLabs could not be used and the Cloudflare voice took over */
  onNotice?: (message: string) => void;
}

/** MP3 of one short piece in the natural voice, as an object URL (cached for this session). */
export async function naturalVoiceAudio(text: string, voice: NaturalVoice = { provider: 'cloudflare' }, ctx: NaturalVoiceContext = {}, signal?: AbortSignal): Promise<string> {
  if (voice.provider === 'elevenlabs' && Date.now() >= elevenPausedUntil) {
    const key = `el|${voice.voiceId}|${voice.model}|${voice.speed}|${text}`;
    const hit = audioCache.get(key);
    if (hit) return hit;
    try {
      const url = await speakRequest(
        {
          provider: 'elevenlabs',
          text,
          ...(voice.voiceId ? { voiceId: voice.voiceId } : {}),
          ...(voice.model ? { model: voice.model } : {}),
          speed: voice.speed,
          ...(ctx.previousText ? { previousText: ctx.previousText.slice(-500) } : {}),
          ...(ctx.nextText ? { nextText: ctx.nextText.slice(0, 500) } : {}),
        },
        signal,
      );
      remember(key, url);
      return url;
    } catch (err) {
      if (signal?.aborted) throw err;
      const status = err instanceof ApiError ? err.status : 0;
      if ([400, 402, 403, 404, 429, 503].includes(status)) elevenPausedUntil = Date.now() + ELEVEN_PAUSE_MS;
      ctx.onNotice?.(`${err instanceof Error ? err.message : 'The ElevenLabs voice is unavailable.'} Using the Cloudflare voice instead.`);
    }
  }
  const hit = audioCache.get(text);
  if (hit) return hit;
  const url = await speakRequest({ text }, signal);
  remember(text, url);
  return url;
}

/** A short sample of an ElevenLabs voice (uses a few credits; cached for this session). */
export async function elevenPreview(voiceId: string, model?: string | null, speed = 1): Promise<string> {
  const key = `preview|${voiceId}|${model}|${speed}`;
  const hit = audioCache.get(key);
  if (hit) return hit;
  const url = await speakRequest({ provider: 'elevenlabs', preview: true, voiceId, ...(model ? { model } : {}), speed });
  remember(key, url);
  return url;
}

/** After the administrator changes ElevenLabs settings, try ElevenLabs again at once. */
export function resetElevenPause() {
  elevenPausedUntil = 0;
  configCache = null;
}

/* ------------------------------ ElevenLabs administration ------------------------------ */

export interface ElevenSettings {
  enabled: boolean;
  appDailyCredits: number;
  appMonthlyCredits: number;
  userDailyCredits: number;
  defaultModel: string;
}

export interface ElevenStatus {
  configured: boolean;
  settings: ElevenSettings;
  usage: { day: { credits: number; characters: number; requests: number; failed: number }; month: { credits: number }; mine: { credits: number } } | null;
  recent: { at: number; uid: string; type: string; model: string; voiceId: string | null; characters: number; credits: number; ok: boolean; error: string | null; ms: number | null }[];
  voices: ElevenVoiceInfo[];
  consentStatement: string;
  designModel: string;
  capabilities: { id: string; label: string; status: string; note?: string }[];
  /** the ElevenLabs plan, when the key may read it (user_read) */
  plan: { tier: string; used: number; limit: number; resetsAt: number | null; status: string | null } | null;
  /** when the free capability checks last ran */
  checkedAt: number | null;
}

export interface DesignPreview {
  generatedVoiceId: string;
  audioBase64: string;
  mediaType: string;
  durationSecs: number;
}

export function elevenAdmin(op: 'status' | 'refresh'): Promise<ElevenStatus>;
export function elevenAdmin(op: 'settings', body: { settings: Partial<ElevenSettings> }): Promise<{ settings: ElevenSettings }>;
export function elevenAdmin(op: 'design', body: { description: string; text: string }): Promise<{ previews: DesignPreview[]; text: string; credits: number | null; creditsEstimated: boolean }>;
export function elevenAdmin(op: 'save', body: { generatedVoiceId: string; name: string; description: string; consent: true }): Promise<{ voice: ElevenVoiceInfo }>;
export function elevenAdmin(op: 'remove', body: { voiceId: string }): Promise<{ deletedAtElevenLabs: boolean }>;
export function elevenAdmin(op: string, body: object = {}): Promise<unknown> {
  return api('speech', { json: { action: 'elevenAdmin', op, ...body } });
}

/* ------------------------------ translation ------------------------------ */

export async function translate(text: string, target: string, source?: string): Promise<{ text: string; source: string; target: string }> {
  return api('speech', { json: { action: 'translate', text, target, ...(source ? { source } : {}) } });
}
