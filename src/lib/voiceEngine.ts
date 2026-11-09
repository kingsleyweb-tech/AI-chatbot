/**
 * The microphone side of Voice Mode: one microphone stream for the whole conversation.
 *
 *  microphone (echo cancellation + noise suppression + gain control by the browser)
 *    -> Web Audio, resampled to 16 kHz, 20 ms frames
 *    -> VoiceActivityDetector (src/lib/vad.ts): turn start, pauses, end, barge-in
 *    -> each finished turn as a WAV recording (with the half second before it started, so the first
 *       word is never clipped), for speech-to-text
 *
 * At a pause the end-of-turn model is asked (through `checkTurn`) whether the speaker sounds
 * finished. The microphone is re-opened when it is unplugged or the device changes, and the audio
 * pipeline is resumed when the browser suspends it (phone call, app switch on iPhone).
 * Nothing is sent anywhere by this file; the caller decides what to do with a turn.
 */
import { Downsampler, encodeWav, FRAME_MS, FRAME_SAMPLES, frameFeatures, SAMPLE_RATE, toInt16, VoiceActivityDetector, type VadEvent, type VadMode } from './vad';

export interface Turn {
  wav: Blob;
  /** heard while Atlas AI was thinking or talking */
  barge: boolean;
  voicedMs: number;
  medianDb: number;
}

export interface VoiceEngineHandlers {
  /** 0..1 microphone level, about 15 times a second */
  onLevel?(level: number): void;
  /** the user started talking (barge: over Atlas AI) */
  onStart?(barge: boolean): void;
  /** sustained speech over Atlas AI */
  onBargeStrong?(): void;
  onTurn(turn: Turn): void;
  /** something started but was too short to be speech */
  onDiscard?(barge: boolean): void;
  /** microphone lost (unplugged) and being re-opened, or back */
  onMic?(state: 'lost' | 'ok'): void;
  /** ask the end-of-turn model; resolve null when it could not answer */
  checkTurn?(pcm: Int16Array): Promise<boolean | null>;
}

const PRE_ROLL_FRAMES = 25; // 0.5 s
const MAX_TURN_FRAMES = 60_000 / FRAME_MS;
const TURN_CHECK_FRAMES = 8_000 / FRAME_MS;

let sharedCtx: AudioContext | null = null;

function audioContextCtor(): typeof AudioContext | undefined {
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
}

/**
 * Create and resume the audio pipeline inside the tap that opens Voice Mode (iPhone Safari only
 * allows this during a tap). Safe to call more than once.
 */
export function primeVoiceAudio() {
  try {
    const Ctor = audioContextCtor();
    if (!Ctor) return;
    if (!sharedCtx || sharedCtx.state === 'closed') sharedCtx = new Ctor();
    void sharedCtx.resume().catch(() => undefined);
  } catch {
    /* no Web Audio */
  }
}

export const voiceModeSupported = () =>
  typeof window !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia) && Boolean(audioContextCtor());

export class VoiceEngine {
  readonly vad = new VoiceActivityDetector();
  private h: VoiceEngineHandlers;
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private proc: ScriptProcessorNode | null = null;
  private sink: GainNode | null = null;
  private down: Downsampler | null = null;
  private pending = new Float32Array(0);
  private prev: Float32Array | undefined;
  private preRoll: Float32Array[] = [];
  private turn: Float32Array[] | null = null;
  private muted = false;
  private stopped = false;
  private reopening = false;
  private levelTick = 0;
  private turnCheck = 0;
  private onDeviceChange = () => void this.checkDevice();
  private onVisible = () => {
    if (document.visibilityState === 'visible') void this.ctx?.resume().catch(() => undefined);
  };

  constructor(handlers: VoiceEngineHandlers) {
    this.h = handlers;
  }

  async start(): Promise<void> {
    this.stopped = false;
    const Ctor = audioContextCtor();
    if (!Ctor) throw Object.assign(new Error('Web Audio is not supported.'), { name: 'NotSupportedError' });
    if (!sharedCtx || sharedCtx.state === 'closed') sharedCtx = new Ctor();
    this.ctx = sharedCtx;
    await this.open();
    navigator.mediaDevices.addEventListener?.('devicechange', this.onDeviceChange);
    document.addEventListener('visibilitychange', this.onVisible);
  }

  private async open() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    if (this.stopped) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.stream = stream;
    const track = stream.getAudioTracks()[0];
    if (track) {
      track.enabled = !this.muted;
      track.onended = () => void this.reopen();
    }
    const ctx = this.ctx!;
    if (ctx.state !== 'running') await ctx.resume().catch(() => undefined);
    this.source = ctx.createMediaStreamSource(stream);
    // ScriptProcessor: available everywhere (also iPhone Safari) and allowed by the site's
    // security policy, unlike an AudioWorklet loaded from a blob
    this.proc = ctx.createScriptProcessor(2048, 1, 1);
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.down = new Downsampler(ctx.sampleRate);
    this.proc.onaudioprocess = (e) => this.process(e.inputBuffer.getChannelData(0));
    this.source.connect(this.proc);
    this.proc.connect(this.sink);
    this.sink.connect(ctx.destination);
  }

  private close() {
    this.proc?.disconnect();
    this.source?.disconnect();
    this.sink?.disconnect();
    if (this.proc) this.proc.onaudioprocess = null;
    this.stream?.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    this.proc = null;
    this.source = null;
    this.sink = null;
    this.stream = null;
  }

  /** Re-open the microphone after it was unplugged, a headset was connected, or it stopped. */
  private async reopen() {
    if (this.stopped || this.reopening) return;
    this.reopening = true;
    this.h.onMic?.('lost');
    this.close();
    this.turn = null;
    for (let attempt = 0; attempt < 5 && !this.stopped; attempt++) {
      try {
        await this.open();
        this.h.onMic?.('ok');
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    this.reopening = false;
  }

  private async checkDevice() {
    const track = this.stream?.getAudioTracks()[0];
    // follow the system's microphone when a headset is plugged in or removed (not mid-sentence)
    if (!track || track.readyState === 'ended' || !this.vad.speaking) await this.reopen();
  }

  setMode(mode: VadMode, holdMs = 0) {
    this.vad.setMode(mode, holdMs);
    if (mode === 'off') this.turn = null;
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    const track = this.stream?.getAudioTracks()[0];
    if (track) track.enabled = !muted;
    if (muted) {
      this.vad.setMode('off');
      this.turn = null;
    }
  }

  setPatient(patient: boolean) {
    this.vad.setPatient(patient);
  }

  /** The user's words made sense: remember how loud they speak. */
  confirmUser(medianDb: number) {
    this.vad.confirmUser(medianDb);
  }

  /** End the current turn now (the user tapped). */
  finishNow() {
    const ev = this.vad.forceEnd();
    if (ev) this.handle(ev);
  }

  stop() {
    this.stopped = true;
    navigator.mediaDevices.removeEventListener?.('devicechange', this.onDeviceChange);
    document.removeEventListener('visibilitychange', this.onVisible);
    this.close();
    this.turn = null;
    // the shared context stays (resuming it needs a tap on iPhone); it uses no microphone now
    void this.ctx?.suspend().catch(() => undefined);
  }

  private process(input: Float32Array) {
    if (this.stopped || !this.down) return;
    const resampled = this.down.push(input);
    const all = new Float32Array(this.pending.length + resampled.length);
    all.set(this.pending, 0);
    all.set(resampled, this.pending.length);
    let off = 0;
    for (; off + FRAME_SAMPLES <= all.length; off += FRAME_SAMPLES) this.frame(all.slice(off, off + FRAME_SAMPLES));
    this.pending = all.slice(off);
  }

  private frame(frame: Float32Array) {
    const f = frameFeatures(frame, this.prev);
    this.prev = frame;
    if (++this.levelTick % 3 === 0) this.h.onLevel?.(this.muted ? 0 : Math.max(0, Math.min(1, (f.db + 60) / 45)));
    if (this.muted) return;

    if (this.turn) {
      this.turn.push(frame);
      if (this.turn.length > MAX_TURN_FRAMES) this.turn.shift();
    } else {
      this.preRoll.push(frame);
      if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift();
    }
    for (const ev of this.vad.push(f)) this.handle(ev);
  }

  private handle(ev: VadEvent) {
    switch (ev.type) {
      case 'start':
        this.turn = [...this.preRoll];
        this.preRoll = [];
        this.h.onStart?.(ev.barge);
        break;
      case 'barge-strong':
        this.h.onBargeStrong?.();
        break;
      case 'pause': {
        if (!this.h.checkTurn || !this.turn) break;
        const id = ++this.turnCheck;
        const recent = join(this.turn.slice(-TURN_CHECK_FRAMES));
        void this.h.checkTurn(toInt16(recent)).then((complete) => {
          if (id !== this.turnCheck) return;
          this.vad.setVerdict(complete === null ? 'failed' : complete ? 'complete' : 'incomplete');
        });
        break;
      }
      case 'end': {
        const frames = this.turn ?? [];
        this.turn = null;
        this.turnCheck++;
        if (frames.length) this.h.onTurn({ wav: encodeWav(join(frames)), barge: ev.barge, voicedMs: ev.voicedMs, medianDb: ev.medianDb });
        break;
      }
      case 'discard':
        this.turn = null;
        this.turnCheck++;
        this.h.onDiscard?.(ev.barge);
        break;
    }
  }
}

function join(frames: Float32Array[]): Float32Array {
  const out = new Float32Array(frames.reduce((n, f) => n + f.length, 0));
  let o = 0;
  for (const f of frames) {
    out.set(f, o);
    o += f.length;
  }
  return out;
}

export { SAMPLE_RATE };
