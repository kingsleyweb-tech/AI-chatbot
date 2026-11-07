import { useCallback, useEffect, useRef, useState } from 'react';

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

let currentId: string | null = null;
const listeners = new Set<(id: string | null) => void>();
function setCurrent(id: string | null) {
  currentId = id;
  listeners.forEach((l) => l(id));
}

export function speak(id: string, markdown: string, voiceName?: string | null) {
  if (!ttsSupported()) return;
  const synth = window.speechSynthesis;
  synth.cancel();
  const text = speakableText(markdown);
  // Chrome stops long utterances; speak sentence groups sequentially.
  const parts = text.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) ?? [text];
  const groups: string[] = [];
  let buf = '';
  for (const p of parts) {
    if ((buf + p).length > 220) {
      if (buf) groups.push(buf);
      buf = p;
    } else buf += p;
  }
  if (buf) groups.push(buf);
  const voice = voiceName ? synth.getVoices().find((v) => v.name === voiceName) : undefined;
  setCurrent(id);
  groups.forEach((g, i) => {
    const u = new SpeechSynthesisUtterance(g);
    if (voice) u.voice = voice;
    if (i === groups.length - 1) u.onend = () => currentId === id && setCurrent(null);
    u.onerror = () => currentId === id && setCurrent(null);
    synth.speak(u);
  });
}

export function stopSpeaking() {
  if (ttsSupported()) window.speechSynthesis.cancel();
  setCurrent(null);
}

export function useSpeaking(): string | null {
  const [id, setId] = useState<string | null>(currentId);
  useEffect(() => {
    listeners.add(setId);
    return () => {
      listeners.delete(setId);
    };
  }, []);
  return id;
}
