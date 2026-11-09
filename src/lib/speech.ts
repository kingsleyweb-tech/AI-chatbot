import { useCallback, useEffect, useRef, useState } from 'react';
import { naturalVoiceAudio, type NaturalVoice } from './voice';

/* ---------------- Speech-to-text (Web Speech API) ---------------- */

interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}

function getRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as (new () => SpeechRecognitionLike) | null;
}

export const sttSupported = () => typeof window !== 'undefined' && getRecognitionCtor() !== null;

/**
 * Dictation hook. `onText` receives (finalText, interimText) while listening.
 * Support varies: Chrome/Edge and Safari (iOS 14.5+) work; Firefox does not.
 */
export function useDictation(onText: (finalText: string, interim: string) => void) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const cb = useRef(onText);
  cb.current = onText;

  const stop = useCallback(() => {
    recRef.current?.stop();
  }, []);

  const start = useCallback(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setError('Voice input is not supported in this browser.');
      return;
    }
    setError(null);
    const rec = new Ctor();
    rec.lang = navigator.language || 'en-US';
    rec.continuous = true;
    rec.interimResults = true;
    let finalText = '';
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      cb.current(finalText, interim);
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') setError('Microphone permission was denied.');
      else if (e.error !== 'aborted' && e.error !== 'no-speech') setError(`Voice input error: ${e.error}`);
    };
    rec.onend = () => {
      setListening(false);
      recRef.current = null;
    };
    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      setError('Could not start voice input.');
    }
  }, []);

  useEffect(() => () => recRef.current?.abort(), []);
  return { listening, start, stop, error, supported: sttSupported() };
}

/* ---------------- Text-to-speech (speechSynthesis) ---------------- */

export const ttsSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window;

// Chrome loads its voice list late; ask early so the first reply can use an installed voice
if (ttsSupported()) {
  try {
    window.speechSynthesis.getVoices();
    window.speechSynthesis.addEventListener?.('voiceschanged', () => window.speechSynthesis.getVoices());
  } catch {
    /* no voices yet */
  }
}

/** Strip Markdown so the voice doesn't read symbols aloud. */
export function speakableText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' (code omitted) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\$\$[\s\S]*?\$\$/g, ' (equation) ')
    .replace(/[#*_>|~-]{1,}/g, ' ')
    .replace(/\[(\d+|D\d+)\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ---------------- one player for both voices ---------------- */

export type PlaybackStatus = 'loading' | 'playing' | 'paused';
export interface Playback {
  id: string | null;
  status: PlaybackStatus | null;
  /** 'natural' while the Cloudflare voice is playing, 'device' for the browser's own voice */
  voice: 'natural' | 'device' | null;
}

let state: Playback = { id: null, status: null, voice: null };
const listeners = new Set<(p: Playback) => void>();
function setState(p: Partial<Playback>) {
  state = { ...state, ...p };
  listeners.forEach((l) => l(state));
}

let token = 0;
let audioEl: HTMLAudioElement | null = null;
function audio(): HTMLAudioElement {
  if (!audioEl) {
    audioEl = new Audio();
    audioEl.preload = 'auto';
  }
  return audioEl;
}

/**
 * Mobile browsers only let audio play after a tap; call this from the tap that starts
 * Voice Mode so later replies can be spoken without another tap.
 */
export function unlockAudio() {
  try {
    const a = audio();
    a.muted = true;
    a.src = 'data:audio/mpeg;base64,//uQxAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAACAAACcQCA';
    void a.play().then(
      () => {
        a.pause();
        a.muted = false;
      },
      () => {
        a.muted = false;
      },
    );
    if (ttsSupported()) window.speechSynthesis.speak(new SpeechSynthesisUtterance(''));
  } catch {
    /* nothing to unlock */
  }
}

/** Sentence groups of at most `max` characters (long replies are spoken piece by piece). */
export function speechChunks(text: string, max: number): string[] {
  const parts = text.match(/[^.!?。！？]+[.!?。！？]+["')\]]*\s*|\S[^.!?。！？]*$/g) ?? [text];
  const groups: string[] = [];
  let buf = '';
  for (const raw of parts) {
    const p = raw.trim();
    if (!p) continue;
    if (p.length > max) {
      if (buf) groups.push(buf);
      buf = '';
      for (let i = 0; i < p.length; i += max) groups.push(p.slice(i, i + max));
      continue;
    }
    if ((buf ? buf.length + 1 : 0) + p.length > max) {
      groups.push(buf);
      buf = p;
    } else buf = buf ? `${buf} ${p}` : p;
  }
  if (buf) groups.push(buf);
  return groups;
}

/**
 * Chrome drops utterances it has garbage-collected (no `end` event, no sound), so the one being
 * spoken is kept here.
 */
let currentUtterance: SpeechSynthesisUtterance | null = null;

/** The chosen voice, else a voice installed on the device (Chrome's online voices often stall or cut out). */
function pickVoice(synth: SpeechSynthesis, voiceName: string | null | undefined, avoidOnline: boolean): SpeechSynthesisVoice | undefined {
  const voices = synth.getVoices();
  const chosen = voiceName ? voices.find((v) => v.name === voiceName) : undefined;
  if (chosen && !(avoidOnline && !chosen.localService)) return chosen;
  const lang = (navigator.language || 'en-US').toLowerCase();
  const base = lang.split('-')[0];
  const local = voices.filter((v) => v.localService);
  return (
    local.find((v) => v.lang.toLowerCase() === lang) ??
    local.find((v) => v.lang.toLowerCase().startsWith(base)) ??
    (avoidOnline ? undefined : chosen)
  );
}

function speakOnce(text: string, voice: SpeechSynthesisVoice | undefined, my: number): Promise<'ok' | 'silent'> {
  return new Promise((resolve) => {
    if (my !== token) return resolve('ok');
    const synth = window.speechSynthesis;
    const u = new SpeechSynthesisUtterance(text);
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    }
    let started = false;
    let settled = false;
    const finish = (r: 'ok' | 'silent') => {
      if (settled) return;
      settled = true;
      window.clearTimeout(startTimer);
      window.clearTimeout(endTimer);
      if (currentUtterance === u) currentUtterance = null;
      resolve(r);
    };
    u.onstart = () => {
      started = true;
    };
    u.onend = () => finish(started ? 'ok' : 'silent');
    u.onerror = (e) => finish(started || e.error === 'interrupted' || e.error === 'canceled' ? 'ok' : 'silent');
    // never stays stuck: no start within 4 s = silent; and a generous limit for the whole piece
    const startTimer = window.setTimeout(() => {
      if (!started) {
        synth.cancel();
        finish('silent');
      }
    }, 4000);
    const endTimer = window.setTimeout(() => finish('ok'), 8000 + text.length * 120);
    currentUtterance = u;
    // Chrome can be left paused, which silently holds the queue
    if (synth.paused) synth.resume();
    synth.speak(u);
  });
}

async function speakDevice(text: string, voiceName: string | null | undefined, my: number): Promise<void> {
  if (!ttsSupported() || my !== token) return;
  const synth = window.speechSynthesis;
  const first = await speakOnce(text, pickVoice(synth, voiceName, false), my);
  // the voice did not start (Chrome dropped it or an online voice stalled): once more with a voice on the device
  if (first === 'silent' && my === token) await speakOnce(text, pickVoice(synth, voiceName, true), my);
}

function playUrl(url: string, my: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (my !== token) return resolve();
    const a = audio();
    const done = () => {
      a.onended = a.onerror = null;
      resolve();
    };
    a.onended = done;
    a.onerror = () => {
      a.onended = a.onerror = null;
      reject(new Error('playback failed'));
    };
    a.volume = ducked ? 0.25 : 1;
    a.src = url;
    a.play().catch(reject);
  });
}

export interface SpeakOptions {
  voiceName?: string | null;
  /** use the natural voice; the device voice takes over if it is unavailable */
  natural?: boolean;
  /** which natural voice (Cloudflare by default, or the person's ElevenLabs voice) */
  voice?: NaturalVoice;
  /** told once when the natural voice could not be used */
  onFallback?: (message: string) => void;
}

/** Read `markdown` aloud. Resolves when it finished or was stopped. */
export async function speak(id: string, markdown: string, opts: SpeakOptions | string | null = {}): Promise<void> {
  const o: SpeakOptions = typeof opts === 'string' || opts === null ? { voiceName: opts } : opts;
  stopSpeaking();
  const my = ++token;
  const text = speakableText(markdown);
  if (!text) return;
  let natural = Boolean(o.natural);
  setState({ id, status: natural ? 'loading' : 'playing', voice: natural ? 'natural' : 'device' });
  try {
    if (natural) {
      const groups = speechChunks(text, 400);
      let warned = false;
      const audio = (i: number) =>
        naturalVoiceAudio(groups[i], o.voice, {
          previousText: groups[i - 1],
          nextText: groups[i + 1],
          onNotice: (m) => {
            if (!warned) o.onFallback?.(m);
            warned = true;
          },
        });
      let next: Promise<string> | null = audio(0);
      for (let i = 0; i < groups.length && my === token; i++) {
        let url: string;
        try {
          url = await next!;
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'The natural voice is unavailable.';
          o.onFallback?.(`${msg} Using the device voice instead.`);
          natural = false;
          setState({ status: 'playing', voice: 'device' });
          for (const g of speechChunks(groups.slice(i).join(' '), 180)) await speakDevice(g, o.voiceName, my);
          break;
        }
        // fetch the next piece while this one plays
        next = i + 1 < groups.length ? audio(i + 1) : null;
        next?.catch(() => undefined);
        if (my !== token) break;
        setState({ status: 'playing' });
        try {
          await playUrl(url, my);
        } catch {
          // the browser refused to play (for example no tap yet on a phone): use the device voice
          setState({ voice: 'device' });
          for (const g of speechChunks(groups.slice(i).join(' '), 180)) await speakDevice(g, o.voiceName, my);
          break;
        }
      }
    } else {
      for (const g of speechChunks(text, 180)) {
        if (my !== token) break;
        await speakDevice(g, o.voiceName, my);
      }
    }
  } catch {
    /* playback failed or was interrupted */
  } finally {
    if (my === token) setState({ id: null, status: null, voice: null });
  }
}

/**
 * Speak a reply while it is still being written: `add()` each finished piece of text as it
 * arrives (the first one starts playing at once), then `finish()`, which resolves when everything
 * was spoken or the speech was stopped (stopSpeaking, or another speak call).
 */
export function speechSession(
  id: string,
  opts: Omit<SpeakOptions, 'natural' | 'voice'> & {
    /** read for every sentence, so changing the setting during a conversation applies at once */
    natural?: boolean | (() => boolean);
    voice?: NaturalVoice | (() => NaturalVoice);
  } = {},
): { add(markdown: string): void; finish(): Promise<void> } {
  stopSpeaking();
  const my = ++token;
  const wantNatural = () => Boolean(typeof opts.natural === 'function' ? opts.natural() : opts.natural);
  const currentVoice = () => (typeof opts.voice === 'function' ? opts.voice() : opts.voice);
  /** false after the natural voice failed in this reply (the device voice is used for the rest) */
  let naturalOk = true;
  let natural = wantNatural();
  let warned = false;
  let lastPiece: string | undefined;
  let chain: Promise<void> = Promise.resolve();
  setState({ id, status: natural ? 'loading' : 'playing', voice: natural ? 'natural' : 'device' });

  const device = async (text: string) => {
    setState({ status: 'playing', voice: 'device' });
    for (const g of speechChunks(text, 180)) {
      if (my !== token) return;
      await speakDevice(g, opts.voiceName, my);
    }
  };
  const fallback = (err: unknown) => {
    naturalOk = false;
    natural = false;
    if (!warned) {
      warned = true;
      opts.onFallback?.(`${err instanceof Error ? err.message : 'The natural voice is unavailable.'} Using the device voice instead.`);
    }
  };

  return {
    add(markdown: string) {
      const text = speakableText(markdown);
      if (!text || my !== token) return;
      natural = naturalOk && wantNatural();
      for (const piece of speechChunks(text, natural ? 400 : 1000)) {
        // the natural voice is fetched now (in parallel) and played in order
        const audioUrl = natural
          ? naturalVoiceAudio(piece, currentVoice(), {
              previousText: lastPiece,
              onNotice: (m) => {
                if (!warned) opts.onFallback?.(m);
                warned = true;
              },
            })
          : null;
        lastPiece = piece;
        audioUrl?.catch(() => undefined);
        chain = chain.then(async () => {
          if (my !== token) return;
          if (audioUrl && natural) {
            try {
              const url = await audioUrl;
              if (my !== token) return;
              setState({ status: 'playing', voice: 'natural' });
              await playUrl(url, my);
              return;
            } catch (err) {
              fallback(err);
            }
          }
          await device(piece);
        });
      }
    },
    finish() {
      return chain.then(() => {
        if (my === token) setState({ id: null, status: null, voice: null });
      });
    },
  };
}

/**
 * Lower the natural voice while the user may be interrupting (Voice Mode), and restore it.
 * The device voice cannot be made quieter mid-sentence, so it keeps playing until the interruption
 * is confirmed. (iPhone Safari ignores volume changes; there the voice also stops only on confirmation.)
 */
let ducked = false;
export function duckSpeaking(on: boolean) {
  ducked = on;
  if (audioEl) audioEl.volume = on ? 0.25 : 1;
}

export function pauseSpeaking() {
  if (!state.id) return;
  if (state.voice === 'natural') audioEl?.pause();
  else if (ttsSupported()) window.speechSynthesis.pause();
  setState({ status: 'paused' });
}

export function resumeSpeaking() {
  if (state.status !== 'paused') return;
  if (state.voice === 'natural') void audioEl?.play().catch(() => undefined);
  else if (ttsSupported()) window.speechSynthesis.resume();
  setState({ status: 'playing' });
}

export function stopSpeaking() {
  token++;
  ducked = false;
  if (audioEl) {
    audioEl.pause();
    audioEl.onended = audioEl.onerror = null;
  }
  // cancelling an idle synthesizer right before speaking makes Chrome drop the next sentence
  if (ttsSupported() && (window.speechSynthesis.speaking || window.speechSynthesis.pending)) window.speechSynthesis.cancel();
  currentUtterance = null;
  if (state.id) setState({ id: null, status: null, voice: null });
}

export function usePlayback(): Playback {
  const [p, setP] = useState<Playback>(state);
  useEffect(() => {
    listeners.add(setP);
    return () => {
      listeners.delete(setP);
    };
  }, []);
  return p;
}

/** Id of the message being read aloud, if any. */
export function useSpeaking(): string | null {
  return usePlayback().id;
}
