/**
 * Voice Mode: a continuous spoken conversation with Atlas AI.
 *
 *   one open microphone (echo cancellation + noise suppression) -> voice activity detection
 *   (src/lib/vad.ts: speech vs background, pauses, end of turn with the Smart Turn hint)
 *   -> Whisper speech-to-text (Cloudflare) -> the normal chat pipeline (Gemini first; saved in the
 *   conversation like any message, so follow-up questions have the whole context)
 *   -> the reply is spoken sentence by sentence while it is still being written
 *   -> listening again, without a tap.
 *
 * Interrupting: while Atlas AI talks the microphone stays open. Speech that is louder than Atlas AI's
 * own echo, voiced and sustained lowers its voice at once; when the words are recognised as a real
 * phrase (not noise, not Whisper's usual "thank you" hallucination, not Atlas AI's own words) the
 * reply stops and the new message is sent. Background sounds and distant voices do not stop it.
 * A tap on the orb or "Interrupt" always stops it.
 */
import { AudioLines, Loader2, Mic, MicOff, WifiOff, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, Switch } from '@/components/ui';
import { duckSpeaking, speechSession, stopSpeaking, unlockAudio } from '@/lib/speech';
import { cn } from '@/lib/utils';
import { judgeTranscript, type VadMode } from '@/lib/vad';
import { checkTurnEnd, micErrorMessage, naturalVoiceFrom, speechConfig, transcribeWithRetry } from '@/lib/voice';
import { primeVoiceAudio, VoiceEngine, type Turn } from '@/lib/voiceEngine';
import { useSettings } from '@/state/settings';
import type { LiveReply } from './engine';

type Phase = 'starting' | 'listening' | 'hearing' | 'transcribing' | 'thinking' | 'speaking' | 'offline' | 'error';

/** What the microphone listens for in a phase. */
function modeFor(p: Phase, bargeIn: boolean): VadMode {
  if (p === 'speaking') return bargeIn ? 'speaking' : 'off';
  if (p === 'thinking' || p === 'transcribing') return 'busy';
  return p === 'listening' || p === 'hearing' ? 'listen' : 'off';
}

/** Seconds after Atlas AI stops talking during which its last words still count as possible echo. */
const ECHO_TAIL_MS = 3000;

export function VoiceMode({
  open,
  onClose,
  onSend,
  onStop,
  live,
}: {
  open: boolean;
  onClose: () => void;
  /** sends the transcript as a normal message; false when it could not be sent */
  onSend: (text: string) => Promise<boolean | void> | boolean | void;
  /** stops the reply being generated */
  onStop: () => void;
  /** the newest live reply of this conversation */
  live?: LiveReply;
}) {
  const { settings, update } = useSettings();
  const [phase, setPhaseState] = useState<Phase>('starting');
  const phaseRef = useRef<Phase>('starting');
  const [level, setLevel] = useState(0);
  const [heard, setHeard] = useState('');
  const [reply, setReply] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [voiceLeft, setVoiceLeft] = useState<number | null>(null);
  const [muted, setMuted] = useState(false);
  const [mic, setMic] = useState<'ok' | 'lost'>('ok');
  const [bargeHint, setBargeHint] = useState(false);
  const [restart, setRestart] = useState(0);

  const engine = useRef<VoiceEngine | null>(null);
  const waitingSince = useRef<number | null>(null);
  const spokenId = useRef<string | null>(null);
  const session = useRef<{ id: string; spoken: number; said: string; s: ReturnType<typeof speechSession> } | null>(null);
  const lastSaid = useRef<{ text: string; at: number } | null>(null);
  const queued = useRef<Turn | null>(null);
  const turns = useRef<Promise<void>>(Promise.resolve());
  const openRef = useRef(open);
  openRef.current = open;
  const sendRef = useRef(onSend);
  sendRef.current = onSend;
  const stopRef = useRef(onStop);
  stopRef.current = onStop;
  const prefs = useRef(settings);
  prefs.current = settings;
  const voiceLeftRef = useRef(voiceLeft);
  voiceLeftRef.current = voiceLeft;
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  const setPhase = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhaseState(p);
  }, []);

  const setMode = useCallback((p: Phase, holdMs = 0) => {
    if (!mutedRef.current) engine.current?.setMode(modeFor(p, prefs.current.voiceBargeIn), holdMs);
  }, []);

  const refreshAllowance = useCallback(() => {
    void speechConfig(true).then((c) => {
      // characters of natural voice left today: the chosen ElevenLabs voice (falls back to Cloudflare) or Cloudflare
      const eleven = prefs.current.voiceProvider === 'elevenlabs' && c.elevenlabs?.available ? (c.elevenlabs.charactersLeft ?? 0) : 0;
      setVoiceLeft(c.naturalVoice || eleven ? Math.max(eleven, c.naturalVoice?.charactersLeft ?? 0) : null);
    });
  }, []);

  const backToListening = useCallback(
    (holdMs = 0) => {
      duckSpeaking(false);
      setBargeHint(false);
      setPhase('listening');
      setMode('listening', holdMs);
    },
    [setPhase, setMode],
  );

  /** Stop the reply that is being spoken or written (the user interrupted). */
  const cutReply = useCallback(() => {
    const cur = session.current;
    if (cur) lastSaid.current = { text: cur.said, at: Date.now() };
    session.current = null;
    stopSpeaking();
    if (waitingSince.current !== null) {
      // still being written: stop it, so it is not read out later (what was written stays in the chat)
      stopRef.current();
      waitingSince.current = null;
    }
  }, []);

  const sendTurn = useCallback(
    async (text: string) => {
      setHeard(text);
      setReply('');
      setNotice(null);
      setPhase('thinking');
      setMode('thinking');
      waitingSince.current = Date.now() - 1000;
      spokenId.current = null;
      const ok = await sendRef.current(text);
      if (ok === false && phaseRef.current === 'thinking') {
        waitingSince.current = null;
        setNotice('That message could not be sent. Please say it again.');
        backToListening();
      }
    },
    [setPhase, setMode, backToListening],
  );

  /** A finished stretch of speech: turn it into text, check it is meant for Atlas AI, send it. */
  const handleTurn = useCallback(
    async (turn: Turn) => {
      if (!openRef.current) return;
      const before = phaseRef.current;
      const overReply = before === 'speaking' || before === 'thinking';
      const echoOf = session.current?.said ?? (lastSaid.current && Date.now() - lastSaid.current.at < ECHO_TAIL_MS ? lastSaid.current.text : undefined);
      if (!navigator.onLine) {
        queued.current = turn;
        setPhase('offline');
        return;
      }
      if (!overReply) {
        setPhase('transcribing');
        setMode('transcribing');
      }
      let text: string;
      try {
        text = (await transcribeWithRetry(turn.wav)).text.trim();
      } catch (err) {
        if (!openRef.current) return;
        const e = err as { code?: string; message?: string };
        if (!navigator.onLine || e.code === 'offline') {
          queued.current = turn;
          setPhase('offline');
          return;
        }
        if (overReply && session.current) {
          duckSpeaking(false);
          setBargeHint(false);
          return;
        }
        if (e.code === 'daily_limit') {
          setError(e.message ?? 'Today’s free voice allowance is used up.');
          setPhase('error');
          setMode('error');
          return;
        }
        setNotice('I didn’t catch that. Please say it again.');
        backToListening();
        return;
      }
      if (!openRef.current) return;
      const verdict = judgeTranscript(text, { barge: overReply, echoOf, voicedMs: turn.voicedMs });
      if (verdict !== 'ok') {
        // background sound, Atlas AI's own voice or nothing at all: carry on as before
        if (phaseRef.current === 'speaking' || phaseRef.current === 'thinking') {
          duckSpeaking(false);
          setBargeHint(false);
        } else backToListening();
        return;
      }
      engine.current?.confirmUser(turn.medianDb);
      if (session.current || waitingSince.current !== null) cutReply();
      await sendTurn(text);
    },
    [setPhase, setMode, backToListening, cutReply, sendTurn],
  );

  // the microphone engine calls these; refs keep them current without restarting it
  const handlers = useRef({
    onStart: (_barge: boolean) => {},
    onBargeStrong: () => {},
    onDiscard: (_barge: boolean) => {},
    onTurn: (_t: Turn) => {},
  });
  handlers.current = {
    onStart: () => {
      const p = phaseRef.current;
      if (p === 'listening') setPhase('hearing');
      else if (p === 'speaking') {
        duckSpeaking(true);
        setBargeHint(true);
      } else if (p === 'thinking' || p === 'transcribing') setBargeHint(true);
    },
    onBargeStrong: () => {
      // a sustained voice over Atlas AI: stop talking now, check the words afterwards
      if (phaseRef.current === 'speaking') {
        cutReply();
        setPhase('hearing');
        setMode('hearing');
      }
    },
    onDiscard: () => {
      duckSpeaking(false);
      setBargeHint(false);
      if (phaseRef.current === 'hearing') backToListening();
    },
    onTurn: (t: Turn) => {
      setBargeHint(false);
      // one turn at a time, in order
      turns.current = turns.current.then(() => handleTurn(t)).catch(() => undefined);
    },
  };

  // open: start the microphone and listen; close: release everything
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPhase('starting');
    setError(null);
    setNotice(null);
    setHeard('');
    setReply('');
    setMic('ok');
    queued.current = null;
    refreshAllowance();
    const e = new VoiceEngine({
      onLevel: setLevel,
      onStart: (b) => handlers.current.onStart(b),
      onBargeStrong: () => handlers.current.onBargeStrong(),
      onDiscard: (b) => handlers.current.onDiscard(b),
      onTurn: (t) => handlers.current.onTurn(t),
      onMic: setMic,
      checkTurn: (pcm) => checkTurnEnd(pcm),
    });
    engine.current = e;
    e.setPatient(prefs.current.voicePatient);
    e.start().then(
      () => {
        if (cancelled) return;
        if (mutedRef.current) e.setMuted(true);
        backToListening();
      },
      (err) => {
        if (cancelled) return;
        setError(micErrorMessage(err));
        setPhase('error');
      },
    );
    return () => {
      cancelled = true;
      e.stop();
      engine.current = null;
      session.current = null;
      waitingSince.current = null;
      stopSpeaking();
    };
  }, [open, restart, refreshAllowance, setPhase, backToListening]);

  useEffect(() => {
    engine.current?.setPatient(settings.voicePatient);
  }, [settings.voicePatient]);

  // network: wait while offline, then carry on with what was said
  useEffect(() => {
    if (!open) return;
    const off = () => {
      if (phaseRef.current === 'listening' || phaseRef.current === 'hearing') setPhase('offline');
    };
    const on = () => {
      const t = queued.current;
      queued.current = null;
      if (t) handlers.current.onTurn(t);
      else if (phaseRef.current === 'offline') backToListening();
    };
    window.addEventListener('offline', off);
    window.addEventListener('online', on);
    return () => {
      window.removeEventListener('offline', off);
      window.removeEventListener('online', on);
    };
  }, [open, setPhase, backToListening]);

  // Speak the reply while it is being written: each finished sentence is spoken as soon as it
  // arrives. The chat engine updates the reply object in place, so its status and length are watched.
  const liveStatus = live?.status;
  const liveLength = live?.content.length ?? 0;
  useEffect(() => {
    if (!open || !live || waitingSince.current === null || live.startedAt < waitingSince.current) return;
    if (live.content) setReply(live.content);
    if (spokenId.current === live.id) return;
    const finished = ['done', 'error', 'stopped'].includes(live.status);

    if (!session.current || session.current.id !== live.id) {
      const left = voiceLeftRef.current;
      const natural = prefs.current.voiceModeNatural && (left === null || left > 40);
      session.current = {
        id: live.id,
        spoken: 0,
        said: '',
        s: speechSession(`voice:${live.id}`, { voiceName: prefs.current.voiceName, natural, voice: naturalVoiceFrom(prefs.current), onFallback: (msg) => setNotice(msg) }),
      };
    }
    const cur = session.current;
    const text = live.content;
    const add = (piece: string) => {
      cur.s.add(piece);
      cur.said += ` ${piece}`;
      if (phaseRef.current !== 'speaking' && phaseRef.current !== 'hearing') {
        setPhase('speaking');
        setMode('speaking');
      }
    };
    // the next piece ends at a sentence or line end outside a code block; the very first piece
    // may end at a comma, so speaking starts as early as possible
    const ready = (from: number): number => {
      let end = -1;
      const re = /[.!?。！？](?=\s)|\n/g;
      re.lastIndex = from;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const upto = m.index + 1;
        if ((text.slice(0, upto).match(/```/g) ?? []).length % 2 === 0) end = upto;
      }
      if (end < 0 && from === 0 && text.length >= 90) {
        const comma = text.slice(0, 160).search(/[,;:—](?=\s)[^,;:—]*$/);
        if (comma >= 40) end = comma + 1;
      }
      return end;
    };
    if (!finished) {
      const end = ready(cur.spoken);
      if (end > cur.spoken && end - cur.spoken >= (cur.spoken === 0 ? 20 : 1)) {
        add(text.slice(cur.spoken, end));
        cur.spoken = end;
      }
      return;
    }

    spokenId.current = live.id;
    waitingSince.current = null;
    const rest =
      live.status === 'error'
        ? (live.error?.message ?? 'Sorry, something went wrong with that reply.')
        : live.approval
          ? 'That request needs a paid model, so I did not run it. You can approve it in the chat.'
          : text.slice(cur.spoken) || (cur.spoken === 0 && live.images.length ? 'Here is your image.' : '');
    if (rest.trim()) add(rest);
    if (!cur.said.trim()) {
      session.current = null;
      backToListening();
      return;
    }
    void cur.s.finish().then(() => {
      // interrupted or closed meanwhile: whoever interrupted decides what happens next
      if (session.current !== cur || !openRef.current) return;
      session.current = null;
      lastSaid.current = { text: cur.said, at: Date.now() };
      if (prefs.current.voiceModeNatural) refreshAllowance();
      if (phaseRef.current === 'speaking') backToListening(350);
    });
  }, [open, live, liveStatus, liveLength, refreshAllowance, setPhase, setMode, backToListening]);

  /** The orb: finish talking now, interrupt Atlas AI, or try again after an error. */
  const tapOrb = () => {
    unlockAudio();
    primeVoiceAudio();
    const p = phaseRef.current;
    if (p === 'hearing' || p === 'listening') engine.current?.finishNow();
    else if (p === 'speaking' || p === 'thinking') {
      cutReply();
      backToListening();
    } else if (p === 'error') setRestart((n) => n + 1);
  };

  const toggleMute = () => {
    primeVoiceAudio();
    const next = !muted;
    setMuted(next);
    mutedRef.current = next;
    engine.current?.setMuted(next);
    if (!next) {
      engine.current?.setMode(modeFor(phaseRef.current, settings.voiceBargeIn));
      if (phaseRef.current === 'hearing') backToListening();
    }
  };

  const end = () => {
    if (phaseRef.current === 'thinking' || waitingSince.current !== null) stopRef.current();
    onClose();
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && end();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!open) return null;

  const label: Record<Phase, string> = {
    starting: 'Starting…',
    listening: muted ? 'Microphone muted' : 'Listening…',
    hearing: 'Hearing you…',
    transcribing: 'Understanding…',
    thinking: 'Thinking…',
    speaking: settings.voiceBargeIn && !muted ? 'Speaking — talk or tap to interrupt' : 'Speaking — tap to interrupt',
    offline: 'You’re offline — waiting for the connection',
    error: 'Something went wrong',
  };
  const busy = phase === 'transcribing' || phase === 'thinking' || phase === 'starting';
  const scale = phase === 'hearing' ? 1 + level * 0.35 : phase === 'listening' && !muted ? 1 + level * 0.12 : 1;

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-bg/95 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Voice Mode">
      <div className="flex items-center justify-between px-4 pt-[max(1rem,env(safe-area-inset-top))]">
        <span className="text-sm font-medium text-muted">Voice Mode</span>
        <button onClick={end} className="rounded-full p-2 text-muted hover:bg-surface-2 hover:text-fg" aria-label="End Voice Mode">
          <X className="size-5" />
        </button>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4">
        <button
          onClick={tapOrb}
          aria-label={phase === 'listening' || phase === 'hearing' ? 'Finish speaking' : phase === 'speaking' || phase === 'thinking' ? 'Interrupt and talk' : 'Talk'}
          className={cn(
            'relative flex size-40 items-center justify-center rounded-full transition-[transform,background-color] duration-150 sm:size-48',
            phase === 'hearing'
              ? 'bg-accent text-accent-fg'
              : phase === 'error'
                ? 'bg-danger-soft text-danger'
                : muted
                  ? 'bg-surface-2 text-muted'
                  : 'bg-accent-soft text-accent',
          )}
          style={{ transform: `scale(${scale})` }}
        >
          {(phase === 'listening' || phase === 'hearing') && !muted && (
            <span className="absolute inset-0 animate-ping rounded-full bg-accent opacity-15" />
          )}
          {phase === 'speaking' && <span className="absolute -inset-3 animate-pulse rounded-full border-2 border-accent/40" />}
          {busy ? (
            <Loader2 className="size-12 animate-spin" />
          ) : phase === 'offline' ? (
            <WifiOff className="size-12" />
          ) : phase === 'error' || muted ? (
            <MicOff className="size-12" />
          ) : phase === 'speaking' ? (
            <AudioLines className="size-12" />
          ) : (
            <Mic className="size-12" />
          )}
        </button>

        <div className="flex flex-col items-center gap-1.5">
          <p className="text-center text-base font-medium text-fg" aria-live="polite">
            {label[phase]}
          </p>
          <p className="flex items-center gap-1.5 text-xs text-muted">
            <span
              className={cn(
                'inline-block size-2 rounded-full',
                muted || mic === 'lost' ? 'bg-danger' : phase === 'hearing' || bargeHint ? 'animate-pulse bg-accent' : 'bg-accent/60',
              )}
            />
            {muted
              ? 'Microphone muted'
              : mic === 'lost'
                ? 'Microphone disconnected — reconnecting…'
                : bargeHint
                  ? 'I hear you — go ahead'
                  : phase === 'speaking' && !settings.voiceBargeIn
                    ? 'Microphone paused while Atlas AI talks'
                    : 'Microphone on'}
          </p>
        </div>

        <div className="w-full max-w-xl space-y-3 text-center">
          {heard && (
            <p className="text-sm text-muted">
              <span className="font-medium text-fg">You:</span> {heard}
            </p>
          )}
          {reply && phase !== 'listening' && phase !== 'hearing' && (
            <p className="line-clamp-5 text-sm text-muted">{reply.replace(/[#*_`>|]/g, '')}</p>
          )}
          {error && <p className="text-sm text-danger">{error}</p>}
          {notice && <p className="text-xs text-muted">{notice}</p>}
        </div>
      </div>

      <div className="flex flex-col items-center gap-3 px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="outline" onClick={toggleMute} aria-pressed={muted}>
            {muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
            {muted ? 'Unmute' : 'Mute'}
          </Button>
          {(phase === 'speaking' || phase === 'thinking') && (
            <Button variant="outline" onClick={tapOrb}>
              Interrupt
            </Button>
          )}
          {phase === 'error' && (
            <Button variant="outline" onClick={tapOrb}>
              Try again
            </Button>
          )}
          <Button variant="danger" onClick={end}>
            End
          </Button>
        </div>
        <div className="flex flex-wrap justify-center gap-x-5 gap-y-2 text-xs text-muted">
          <label className="flex items-center gap-2">
            <Switch checked={settings.voiceBargeIn} onChange={(v) => void update({ voiceBargeIn: v })} label="Interrupt by talking" />
            Interrupt by talking
          </label>
          <label className="flex items-center gap-2">
            <Switch checked={settings.voicePatient} onChange={(v) => void update({ voicePatient: v })} label="More time to speak" />
            More time to speak
          </label>
          <label className="flex items-center gap-2">
            <Switch checked={settings.voiceModeNatural} onChange={(v) => void update({ voiceModeNatural: v })} label="Natural voice" />
            Natural voice
          </label>
        </div>
        <p className="max-w-xl text-center text-[11px] text-subtle">
          Speech is turned into text by Cloudflare and saved in this conversation. Use headphones for the most reliable interruptions.{' '}
          {settings.voiceModeNatural
            ? voiceLeft !== null
              ? voiceLeft > 40
                ? `Natural voice: about ${voiceLeft.toLocaleString()} characters left today; then your device voice is used.`
                : 'Today’s natural-voice share is used up, so your device voice is used until 00:00 UTC.'
              : 'Natural voice on.'
            : 'Replies use your device voice (free).'}
        </p>
      </div>
    </div>,
    document.body,
  );
}
