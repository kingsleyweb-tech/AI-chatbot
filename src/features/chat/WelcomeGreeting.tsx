import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  EMPTY_MEMORY,
  pickGreeting,
  pickHeadline,
  remember,
  renderHeadline,
  timeOfDay,
  type Greeting,
  type GreetingMemory,
  type TimeOfDay,
} from './greetings';

const SESSION_KEY = 'atlas.greeting.session';
const LAST_KEY = 'atlas.greeting.last';
/** How often to check whether the time-of-day category has changed while the page stays open. */
const CHECK_MS = 60_000;

function loadMemory(): GreetingMemory {
  const memory: GreetingMemory = { ...EMPTY_MEMORY };
  try {
    const session = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    if (Array.isArray(session?.seenHeadlines)) memory.seenHeadlines = session.seenHeadlines.filter((x: unknown) => typeof x === 'string');
    if (Array.isArray(session?.seenSubtitles)) memory.seenSubtitles = session.seenSubtitles.filter((x: unknown) => typeof x === 'string');
  } catch {
    /* storage unavailable or malformed: start fresh */
  }
  try {
    const last = JSON.parse(localStorage.getItem(LAST_KEY) || 'null');
    if (typeof last?.headline === 'string') memory.lastHeadline = last.headline;
    if (typeof last?.subtitle === 'string') memory.lastSubtitle = last.subtitle;
  } catch {
    /* storage unavailable or malformed */
  }
  return memory;
}

function saveMemory(memory: GreetingMemory) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ seenHeadlines: memory.seenHeadlines, seenSubtitles: memory.seenSubtitles }));
  } catch {
    /* storage unavailable */
  }
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify({ headline: memory.lastHeadline, subtitle: memory.lastSubtitle }));
  } catch {
    /* storage unavailable */
  }
}

/** Longest wait for the profile (and so the name) before showing the greeting without it. */
const NAME_WAIT_MS = 3000;

/**
 * Rotating, time-aware welcome headline and inspirational subtitle. `name` is the user's first name, or ''.
 * `ready` is false while the profile is still loading: the greeting keeps its space but stays hidden, so it
 * does not appear without the name and then change a moment later.
 */
export function WelcomeGreeting({ name, ready }: { name: string; ready: boolean }) {
  const reduceMotion = useReducedMotion();
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    if (ready) return;
    const id = window.setTimeout(() => setWaited(true), NAME_WAIT_MS);
    return () => window.clearTimeout(id);
  }, [ready]);
  const visible = ready || waited;
  const [state, setState] = useState<{ greeting: Greeting; tod: TimeOfDay }>(() => {
    const now = new Date();
    return { greeting: pickGreeting(now, loadMemory()), tod: timeOfDay(now) };
  });

  // Record what is on screen, so it is not repeated this session or on the next visit.
  useEffect(() => {
    saveMemory(remember(loadMemory(), state.greeting));
  }, [state.greeting]);

  // If the page stays open across a time-of-day boundary, swap a time-specific headline for one that fits the new time.
  useEffect(() => {
    const check = () => {
      const tod = timeOfDay(new Date());
      setState((prev) => {
        if (tod === prev.tod) return prev;
        if (prev.greeting.source === 'anytime') return { ...prev, tod };
        const { headline, source } = pickHeadline(tod, loadMemory(), Math.random, true);
        return { tod, greeting: { ...prev.greeting, headline, source } };
      });
    };
    const id = window.setInterval(check, CHECK_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const title = renderHeadline(state.greeting.headline, name);
  const fade = reduceMotion
    ? { initial: { opacity: 1 }, animate: { opacity: 1 }, exit: { opacity: 1 }, transition: { duration: 0 } }
    : { initial: { opacity: 0, y: 4 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -4 }, transition: { duration: 0.35 } };

  return (
    <div className={`flex flex-col items-center ${visible ? '' : 'invisible'}`}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.h1
          key={state.greeting.headline.named}
          {...fade}
          className="max-w-xl text-balance text-[22px] font-semibold leading-snug tracking-tight sm:text-[28px]"
        >
          {title}
        </motion.h1>
      </AnimatePresence>
      <p className="mt-2 max-w-md text-balance text-[15px] text-muted">{state.greeting.subtitle}</p>
    </div>
  );
}
