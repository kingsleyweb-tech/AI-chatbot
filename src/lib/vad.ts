/**
 * Voice activity detection for Voice Mode (runs in the browser, no network, no cost).
 *
 * Input: 20 ms frames of 16 kHz mono audio from the microphone (echo cancellation, noise
 * suppression and gain control are already applied by the browser).
 *
 * A frame counts as speech when it is clearly louder than the background AND voiced (it has a
 * pitch between 70 and 500 Hz, which steady noise like fans, traffic or rain does not). On top:
 *  - the noise floor adapts: it follows quiet moments quickly and rises only slowly, so a TV or
 *    music that is always on becomes "background";
 *  - after the first accepted turn, the user's own speaking level is known; speech much quieter
 *    than that (someone across the room, a TV) does not start a turn;
 *  - while Atlas AI speaks, the level of its own voice reaching the microphone (echo) is tracked,
 *    and only clearly louder, sustained, voiced speech counts as an interruption ("barge-in");
 *  - the end of a turn is not just a fixed pause: after a short silence the caller may ask a
 *    turn-detection model whether the speaker sounds finished; "not finished" waits longer, so
 *    natural pauses, breathing and slow speakers are not cut off.
 * Every decision is a pure function of the frames pushed, so it is unit-tested with made-up audio.
 */

export const SAMPLE_RATE = 16_000;
export const FRAME_SAMPLES = 320;
export const FRAME_MS = 20;

export interface FrameFeatures {
  /** level in dBFS */
  db: number;
  /** 0..1 strength of a pitch between 70 and 500 Hz */
  voicing: number;
}

const MIN_LAG = Math.floor(SAMPLE_RATE / 500);
const MAX_LAG = Math.floor(SAMPLE_RATE / 70);

/** Level and voicing of one frame; `prev` (the previous frame) gives the pitch search enough samples. */
export function frameFeatures(frame: Float32Array, prev?: Float32Array): FrameFeatures {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  const rms = Math.sqrt(sum / frame.length);
  const db = 20 * Math.log10(rms + 1e-9);
  if (db < -70) return { db, voicing: 0 };
  // normalised autocorrelation over the last two frames
  const x = prev ? concat(prev, frame) : frame;
  const n = x.length;
  let best = 0;
  for (let lag = MIN_LAG; lag <= Math.min(MAX_LAG, n >> 1); lag += 1) {
    let xy = 0;
    let xx = 0;
    let yy = 0;
    for (let i = 0; i + lag < n; i += 2) {
      const a = x[i];
      const b = x[i + lag];
      xy += a * b;
      xx += a * a;
      yy += b * b;
    }
    const r = xy / Math.sqrt(xx * yy + 1e-12);
    if (r > best) best = r;
  }
  return { db, voicing: Math.max(0, Math.min(1, best)) };
}

function concat(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** listen: waiting for the user; busy: Atlas AI is thinking (speech interrupts it); speaking: Atlas AI is talking (barge-in rules); off: ignore the microphone */
export type VadMode = 'listen' | 'busy' | 'speaking' | 'off';

export type VadEvent =
  | { type: 'start'; barge: boolean }
  /** a pause long enough to ask whether the turn is finished */
  | { type: 'pause' }
  /** sustained speech over Atlas AI: certainly the user, stop talking now */
  | { type: 'barge-strong' }
  | { type: 'end'; barge: boolean; voicedMs: number; medianDb: number }
  /** too short to be speech (a cough, a knock) */
  | { type: 'discard'; barge: boolean };

export interface VadTiming {
  /** silence after which a turn-detection check is requested */
  checkAfterMs: number;
  /** the shortest pause that may end a turn the model says is finished */
  minEndMs: number;
  /** pause that ends a turn when no model answer is available */
  softEndMs: number;
  /** pause that always ends a turn (also when the model said "not finished") */
  hardEndMs: number;
}

export const TIMING: Record<'normal' | 'patient', VadTiming> = {
  normal: { checkAfterMs: 500, minEndMs: 650, softEndMs: 1_300, hardEndMs: 2_600 },
  patient: { checkAfterMs: 700, minEndMs: 1_000, softEndMs: 2_200, hardEndMs: 4_000 },
};

/** Longest turn; it ends there even without a pause. */
export const MAX_TURN_MS = 60_000;
/** Less voiced speech than this is not a turn. */
export const MIN_VOICED_MS = 260;
/** Less than this over Atlas AI's voice is a cough or a laugh, not an interruption. */
export const MIN_BARGE_VOICED_MS = 500;
/** Sustained speech over Atlas AI that stops it at once (before the words are checked). */
export const BARGE_STRONG_MS = 900;

export class VoiceActivityDetector {
  mode: VadMode = 'listen';
  timing: VadTiming = TIMING.normal;
  /** background level (dBFS) */
  noiseDb = -50;
  /** level of Atlas AI's own voice at the microphone while it speaks */
  echoDb = -90;
  /** the user's typical speaking level, once known */
  userDb: number | null = null;

  private calibrated = 0;
  private recent: boolean[] = [];
  private inTurn = false;
  private barge = false;
  private strongSent = false;
  private voicedMs = 0;
  private turnMs = 0;
  private silenceMs = 0;
  private asked = false;
  private verdict: 'complete' | 'incomplete' | 'failed' | null = null;
  private turnDbs: number[] = [];
  /** ignore the microphone briefly after Atlas AI stops talking (the room's echo dies away) */
  private holdMs = 0;
  private warmMs = 0;

  setMode(mode: VadMode, holdMs = 0) {
    if (mode === this.mode) return;
    const wasSpeaking = this.mode === 'speaking';
    this.mode = mode;
    this.recent = [];
    if (mode === 'off') this.reset();
    // Atlas AI starts talking: measure its echo for a moment before listening for interruptions
    if (mode === 'speaking') this.warmMs = 400;
    // it stopped: ignore the room's echo briefly (a turn the user already started carries on)
    if (wasSpeaking && !this.inTurn) this.holdMs = holdMs;
  }

  setPatient(patient: boolean) {
    this.timing = TIMING[patient ? 'patient' : 'normal'];
  }

  /** The turn-detection model's answer for the current pause. */
  setVerdict(v: 'complete' | 'incomplete' | 'failed') {
    if (this.inTurn && this.asked) this.verdict = v;
  }

  /** A turn was accepted as the user's (its words made sense): learn the user's level. */
  confirmUser(medianDb: number) {
    if (!Number.isFinite(medianDb)) return;
    this.userDb = this.userDb === null ? medianDb : this.userDb * 0.7 + medianDb * 0.3;
  }

  /** End the current turn now (the user tapped "done"). */
  forceEnd(): VadEvent | null {
    if (!this.inTurn) return null;
    return this.finish();
  }

  get speaking(): boolean {
    return this.inTurn;
  }

  private reset() {
    this.inTurn = false;
    this.barge = false;
    this.strongSent = false;
    this.voicedMs = 0;
    this.turnMs = 0;
    this.silenceMs = 0;
    this.asked = false;
    this.verdict = null;
    this.turnDbs = [];
    this.recent = [];
  }

  private finish(): VadEvent {
    const ev: VadEvent =
      this.voicedMs < (this.barge && this.mode === 'speaking' ? MIN_BARGE_VOICED_MS : MIN_VOICED_MS)
        ? { type: 'discard', barge: this.barge }
        : { type: 'end', barge: this.barge, voicedMs: this.voicedMs, medianDb: median(this.turnDbs) };
    this.reset();
    return ev;
  }

  /** Thresholds for starting a turn in the current mode. */
  private isOnsetFrame(f: FrameFeatures): boolean {
    if (f.db < -58) return false;
    if (this.mode === 'speaking') {
      const over = Math.max(this.noiseDb + 16, this.echoDb + 9, this.userDb !== null ? this.userDb - 9 : -Infinity);
      return f.db > over && f.voicing > 0.5;
    }
    const over = Math.max(this.noiseDb + 10, this.userDb !== null ? this.userDb - 20 : -Infinity);
    // always voiced: a fan or traffic that starts suddenly is loud but has no pitch
    return f.db > over && f.voicing > 0.42;
  }

  /** A frame that keeps a turn going (looser than starting one, so soft word endings count). */
  private isSpeechFrame(f: FrameFeatures): boolean {
    if (f.db < -62) return false;
    const base = this.barge ? Math.max(this.noiseDb + 10, this.echoDb + 4) : this.noiseDb + 7;
    // unvoiced sounds ("s", "f") are short enough to fall inside the pause allowance
    return f.db > base && f.voicing > 0.32;
  }

  push(f: FrameFeatures): VadEvent[] {
    const events: VadEvent[] = [];
    if (this.mode === 'off') return events;
    if (this.holdMs > 0) {
      this.holdMs -= FRAME_MS;
      this.trackNoise(f, false);
      return events;
    }

    if (!this.inTurn) {
      if (this.mode === 'speaking' && this.warmMs > 0) {
        this.warmMs -= FRAME_MS;
        this.trackEcho(f);
        return events;
      }
      const onset = this.isOnsetFrame(f);
      this.recent.push(onset);
      const window = this.mode === 'speaking' ? 20 : 10;
      const needed = this.mode === 'speaking' ? 14 : 6;
      if (this.recent.length > window) this.recent.shift();
      if (this.mode === 'speaking' && !onset) this.trackEcho(f);
      this.trackNoise(f, onset);
      if (this.recent.filter(Boolean).length >= needed) {
        this.inTurn = true;
        this.barge = this.mode === 'speaking' || this.mode === 'busy';
        // the frames that triggered the start were speech
        this.voicedMs = needed * FRAME_MS;
        this.turnMs = window * FRAME_MS;
        this.turnDbs = [f.db];
        this.recent = [];
        events.push({ type: 'start', barge: this.barge });
      }
      return events;
    }

    // inside a turn
    this.turnMs += FRAME_MS;
    if (this.isSpeechFrame(f)) {
      this.voicedMs += FRAME_MS;
      this.silenceMs = 0;
      this.asked = false;
      this.verdict = null;
      this.turnDbs.push(f.db);
      if (this.barge && this.mode === 'speaking' && !this.strongSent && this.voicedMs >= BARGE_STRONG_MS) {
        this.strongSent = true;
        events.push({ type: 'barge-strong' });
      }
    } else {
      this.silenceMs += FRAME_MS;
      this.trackNoise(f, false);
    }

    const t = this.timing;
    if (this.turnMs >= MAX_TURN_MS) {
      events.push(this.finish());
      return events;
    }
    if (this.silenceMs === 0) return events;
    // a short blip that went quiet again is not a turn
    if (this.voicedMs < (this.barge ? MIN_BARGE_VOICED_MS : MIN_VOICED_MS) && this.silenceMs >= 400) {
      events.push(this.finish());
      return events;
    }
    if (!this.asked && this.silenceMs >= t.checkAfterMs && this.voicedMs >= 400) {
      this.asked = true;
      events.push({ type: 'pause' });
    }
    const done =
      this.silenceMs >= t.hardEndMs ||
      (this.verdict === 'complete' && this.silenceMs >= t.minEndMs) ||
      (this.silenceMs >= t.softEndMs && (!this.asked || this.verdict === 'failed'));
    if (done) events.push(this.finish());
    return events;
  }

  private trackNoise(f: FrameFeatures, speechy: boolean) {
    if (f.db < this.noiseDb) this.noiseDb += (f.db - this.noiseDb) * 0.25;
    else if (!speechy) this.noiseDb += Math.min(0.05, (f.db - this.noiseDb) * 0.02);
    this.noiseDb = Math.max(-90, Math.min(-20, this.noiseDb));
    // the first second sets the floor quickly
    if (this.calibrated < 50) {
      this.calibrated++;
      this.noiseDb = Math.min(this.noiseDb, f.db + 3);
    }
  }

  /** Echo envelope: rises quickly with Atlas AI's voice, decays slowly between words. */
  private trackEcho(f: FrameFeatures) {
    if (f.db > this.echoDb) this.echoDb += (f.db - this.echoDb) * 0.3;
    else this.echoDb -= 0.08;
    this.echoDb = Math.max(this.noiseDb, this.echoDb);
  }
}

function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}

/* ------------------------------ checking what was heard ------------------------------ */

// What Whisper commonly "hears" in noise or silence, and sounds that are not a message.
const HALLUCINATIONS = new Set([
  'thank you', 'thanks', 'thank you very much', 'thanks for watching', 'thank you for watching', 'thank you so much for watching',
  'please subscribe', 'subscribe', 'like and subscribe', 'you', 'bye', 'bye bye', 'goodbye', 'okay', 'ok', 'so', 'yeah',
  'the end', 'subtitles by the amara org community', 'music', 'applause', 'laughter', 'silence', 'foreign',
]);
const FILLERS = new Set(['uh', 'um', 'umm', 'uhm', 'hmm', 'hm', 'mm', 'mmm', 'mhm', 'ah', 'oh', 'eh', 'er', 'erm', 'huh', 'ha', 'haha']);
/** Short words that are clearly meant to stop Atlas AI. */
const STOP_WORDS = new Set(['stop', 'wait', 'hold', 'pause', 'atlas', 'no', 'hey', 'sorry', 'actually', 'enough', 'quiet', 'excuse', 'cancel', 'shh']);

export type Heard = 'ok' | 'empty' | 'noise' | 'echo';

const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];

/**
 * Whether a transcript is something the user said to Atlas AI.
 *  - `barge`: it was heard while Atlas AI was talking (a stricter test: it must be a real phrase,
 *    or a clear "stop"/"wait");
 *  - `echoOf`: what Atlas AI was saying; a transcript made of those same words is its own voice;
 *  - `voicedMs`: how much speech was heard (Whisper's stock phrases count only after real speech).
 */
export function judgeTranscript(text: string, opts: { barge?: boolean; echoOf?: string; voicedMs?: number } = {}): Heard {
  const w = words(text);
  if (!w.length) return 'empty';
  const phrase = w.join(' ');
  if (/[[(]\s*(music|applause|laughter|silence|noise|blank_audio|inaudible)/i.test(text)) return 'noise';
  if (w.every((x) => FILLERS.has(x))) return 'noise';
  if (opts.echoOf) {
    const said = words(opts.echoOf);
    const saidSet = new Set(said);
    const overlap = w.filter((x) => saidSet.has(x)).length / w.length;
    if ((w.length >= 3 && overlap >= 0.7) || (w.length < 3 && said.join(' ').includes(phrase))) return 'echo';
  }
  // Whisper invents these in near-silence; a clear stretch of speech saying them is a real reply
  if (HALLUCINATIONS.has(phrase) && (opts.barge || (opts.voicedMs ?? 0) < 700)) return 'noise';
  if (opts.barge) {
    const content = w.filter((x) => !FILLERS.has(x));
    if (content.length < 2 && !content.some((x) => STOP_WORDS.has(x))) return 'noise';
  }
  return 'ok';
}

/* ------------------------------ audio helpers ------------------------------ */

/** Mono float samples to 16-bit PCM. */
export function toInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** A WAV file (16 kHz, mono, 16-bit) that Whisper accepts on every browser, including Safari. */
export function encodeWav(samples: Float32Array, sampleRate = SAMPLE_RATE): Blob {
  const pcm = toInt16(samples);
  const buf = new ArrayBuffer(44 + pcm.byteLength);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + pcm.byteLength, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, pcm.byteLength, true);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: 'audio/wav' });
}

/** Streaming resampler to 16 kHz (averages the input samples that fall into each output sample). */
export class Downsampler {
  private ratio: number;
  private pos = 0;
  private acc = 0;
  private count = 0;
  constructor(inputRate: number) {
    this.ratio = inputRate / SAMPLE_RATE;
  }
  push(input: Float32Array): Float32Array {
    if (this.ratio === 1) return input.slice();
    const out: number[] = [];
    for (let i = 0; i < input.length; i++) {
      this.acc += input[i];
      this.count++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        out.push(this.acc / this.count);
        this.acc = 0;
        this.count = 0;
      }
    }
    return Float32Array.from(out);
  }
}
