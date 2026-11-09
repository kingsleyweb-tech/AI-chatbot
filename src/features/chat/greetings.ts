/**
 * Welcome-page greeting library and selection logic.
 *
 * Headlines are written with the user's first name built into the sentence as `{name}`. Each headline
 * also reads naturally without a name: by default the `, {name}` is removed ("Keep moving forward, {name}."
 * → "Keep moving forward."); entries whose sentence would not survive that removal give an explicit `plain`.
 *
 * Subtitles are short inspirational lines rotated independently of the headline.
 *
 * To add a greeting, add a line to the right list. `tests/greetings.test.ts` checks every entry.
 */

export type TimeOfDay = 'earlyMorning' | 'lateMorning' | 'afternoon' | 'evening' | 'lateNight';

export type Headline = { named: string; plain?: string };

/** Headline text from the time-of-day pools or the any-time pool. */
export type HeadlineSource = TimeOfDay | 'anytime';

const h = (named: string, plain?: string): Headline => (plain ? { named, plain } : { named });

/** Any-time headlines: suit every hour of the day. */
export const ANYTIME_HEADLINES: Headline[] = [
  // Short, intelligent welcome greetings
  h('Welcome back, {name}.', 'Welcome back, thinker.'),
  h('Ready to explore, {name}?'),
  h('What’s on your mind today, {name}?'),
  h('Let’s think beyond the obvious, {name}.'),
  h('Your ideas have a place here, {name}.'),
  h('Ready for your next discovery, {name}?'),
  h('Let’s make something happen, {name}.'),
  h('Where shall curiosity take us, {name}?'),
  h('Think freely, {name}. Explore endlessly.'),
  h('Let’s get your mind moving, {name}.'),
  h('Welcome to a world of possibilities, {name}.'),
  h('What shall we figure out today, {name}?'),
  h('There’s always more to discover, {name}.'),
  h('Think further, {name}. Go beyond.'),
  h('Let’s turn questions into clarity, {name}.'),
  h('Make curiosity your starting point, {name}.'),
  h('Let’s explore what’s possible, {name}.'),
  h('The next move starts with a thought, {name}.'),
  // Atlas-style greetings
  h('Your thinking space is ready, {name}.'),
  h('Intelligence meets imagination. Let’s begin, {name}.'),
  h('Another chance to think beyond limits, {name}.'),
  h('Your workspace is ready for exploration, {name}.'),
  h('Let’s unlock a new perspective, {name}.'),
  h('{name}, a world of knowledge is one question away.', 'A world of knowledge, one question away.'),
  h('Your curiosity just found its home, {name}.'),
  h('Discover more, {name}. Understand deeper.'),
  h('Ideas in motion, {name}. Possibilities without limits.'),
  h('The next discovery starts with you, {name}.'),
  h('Think without boundaries, {name}.'),
  h('Your personal space for discovery is ready, {name}.'),
  h('Explore ideas and find answers, {name}.'),
  h('{name}, beyond answers there’s understanding.', 'Beyond answers, there’s understanding.'),
  h('Your next great discovery is one question away, {name}.'),
  h('Welcome to your space for limitless thinking, {name}.'),
  h('More than answers, {name}. A better way to think.'),
  h('Think further and do more, {name}.'),
  // Written around the user's name
  h('Welcome back, {name}. What’s on your mind?'),
  h('Good to have you here, {name}. Ready to explore?'),
  h('Your next idea starts here, {name}.'),
  h('Ready to discover something new, {name}?'),
  h('The thinking space is yours, {name}.'),
  h('What are we figuring out today, {name}?'),
  h('Keep pushing boundaries, {name}.'),
  h('Let’s get something great started, {name}.'),
];

/** Time-of-day headlines. */
export const TIME_HEADLINES: Record<TimeOfDay, Headline[]> = {
  earlyMorning: [
    h('A new day, {name}. A fresh perspective.'),
    h('Your next big idea starts here, {name}.'),
    h('The world is waking up, {name}. What will you create?'),
    h('A fresh chapter begins with you, {name}.'),
    h('New light, new possibilities, {name}.'),
    h('Make this day count, {name}.'),
    h('Start curious, {name}. Stay inspired.'),
    h('The possibilities are already waiting, {name}.'),
    h('Today is another chance to think bigger, {name}.'),
    h('Let’s make today meaningful, {name}.'),
  ],
  lateMorning: [
    h('You’re right on time for something great, {name}.'),
    h('Keep the momentum going, {name}.'),
    h('Big ideas don’t wait, {name}. Neither should you.'),
    h('There’s more to discover today, {name}.'),
    h('Stay curious, {name}. Keep building.'),
    h('Your next breakthrough could start with a question, {name}.'),
    h('Turn your thoughts into possibilities, {name}.'),
    h('Keep moving forward, {name}.'),
    h('Make room for better ideas, {name}.'),
    h('Let’s take things further, {name}.'),
  ],
  afternoon: [
    h('There’s still more to accomplish, {name}.'),
    h('Keep your ideas moving, {name}.'),
    h('A little progress can change everything, {name}.'),
    h('The day still has possibilities, {name}.'),
    h('Think clearly, {name}. Move boldly.'),
    h('Your curiosity has no closing time, {name}.'),
    h('Keep building on what you’ve started, {name}.'),
    h('There’s always another way forward, {name}.'),
    h('Let your next idea take shape, {name}.'),
    h('Make this moment productive, {name}.'),
  ],
  evening: [
    h('The day may be winding down, {name}, but ideas never do.', 'The day may be winding down, but ideas never do.'),
    h('Take a moment to explore something new, {name}.'),
    h('Let curiosity lead the way, {name}.'),
    h('Some of the best ideas come in quiet moments, {name}.'),
    h('Reflect, rethink and discover, {name}.'),
    h('Your imagination doesn’t follow a schedule, {name}.'),
    h('A quieter moment for bigger thoughts, {name}.'),
    h('There’s always something new to learn, {name}.'),
    h('End the day with a new perspective, {name}.'),
    h('One more idea could change everything, {name}.'),
  ],
  lateNight: [
    h('{name}, this is for minds that never stop exploring.', 'For minds that never stop exploring.'),
    h('The quiet hours belong to big thinkers, {name}.'),
    h('Still curious, {name}? So are we.'),
    h('Great ideas don’t watch the clock, {name}.'),
    h('Your mind has no closing hours, {name}.'),
    h('The world is quiet, {name}. Let your ideas speak.'),
    h('Late hours, {name}. Limitless possibilities.'),
    h('One thought can open a new world, {name}.'),
    h('Keep exploring beyond the ordinary, {name}.'),
    h('The night is yours to discover, {name}.'),
  ],
};

/** Subtitles shown under the headline, rotated independently. Kept short enough for phone screens. */
export const SUBTITLES: string[] = [
  'Every great achievement begins with the courage to ask a question.',
  'You don’t need to know everything. You just need to keep learning.',
  'Small steps, taken consistently, create remarkable progress.',
  'Your curiosity is one of your greatest strengths.',
  'Never underestimate what one good idea can become.',
  'Growth begins when you challenge what you already know.',
  'Progress isn’t always loud. Sometimes it’s simply showing up again.',
  'The smartest move is often asking a better question.',
  'Think beyond what is familiar.',
  'Knowledge becomes powerful when you put it into action.',
  'Don’t wait for perfect conditions to begin.',
  'Every problem has another perspective worth exploring.',
  'What you learn today can change what you build tomorrow.',
  'Stay open to ideas that challenge your thinking.',
  'Your potential is bigger than your current understanding.',
  'Be patient with the process. Keep improving.',
  'The future belongs to those willing to keep learning.',
  'Don’t just collect information. Turn it into understanding.',
  'One new skill can open a thousand new doors.',
  'Keep questioning. Keep discovering. Keep growing.',
  'Every question opens another possibility.',
  'Think. Discover. Create.',
  'Curiosity starts here.',
  'Ideas deserve exploration.',
  'Knowledge in every direction.',
  'Make every question count.',
  'Explore beyond the familiar.',
  'A smarter way to move forward.',
  'Discover what you didn’t know.',
  'Your thoughts, taken further.',
  'Possibilities begin with curiosity.',
  'Learn something. Build something.',
  'Better questions. Deeper understanding.',
  'Stay curious. Stay ahead.',
  'Let ideas become reality.',
  'Your imagination sets the limit.',
];

/** Time-of-day category from the device's local clock (Date#getHours is local time, not UTC or server time). */
export function timeOfDay(now: Date): TimeOfDay {
  const hour = now.getHours();
  if (hour >= 5 && hour < 9) return 'earlyMorning';
  if (hour >= 9 && hour < 12) return 'lateMorning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'evening';
  return 'lateNight';
}

/**
 * First name from a display name, or '' when there is nothing real to show. Profiles created without a
 * name store the email's local part or a stand-in ('You', 'User') as the display name; neither is a name.
 */
export function firstName(displayName: string | null | undefined, email?: string | null): string {
  const full = (displayName ?? '').trim();
  const first = full.split(/\s+/)[0] ?? '';
  if (!first || /^(undefined|null|you|user)$/i.test(first) || first.includes('@')) return '';
  const local = email?.split('@')[0]?.toLowerCase();
  if (local && full.toLowerCase() === local) return '';
  return first;
}

/** The headline as displayed: the name in place, or the name-free wording when there is no name. */
export function renderHeadline(headline: Headline, name: string): string {
  if (name) return headline.named.replace('{name}', name);
  return headline.plain ?? headline.named.replace(', {name}', '');
}

/** What has already been shown: this session (sessionStorage) and on the previous visit (localStorage). */
export type GreetingMemory = {
  seenHeadlines: string[];
  seenSubtitles: string[];
  lastHeadline?: string;
  lastSubtitle?: string;
};

export const EMPTY_MEMORY: GreetingMemory = { seenHeadlines: [], seenSubtitles: [] };

export type Greeting = { headline: Headline; source: HeadlineSource; subtitle: string };

/** Share of headlines drawn from the current time-of-day pool; the rest come from the any-time pool. */
const TIME_SHARE = 0.55;

/** Picks from `pool`, skipping anything seen this session or on the last visit; once everything is used, starts over (still skipping the last one). */
function pickFresh<T>(pool: T[], key: (item: T) => string, seen: string[], last: string | undefined, rand: () => number): T {
  const blocked = new Set(seen);
  let choices = pool.filter((item) => !blocked.has(key(item)) && key(item) !== last);
  if (!choices.length) choices = pool.filter((item) => key(item) !== last);
  if (!choices.length) choices = pool;
  return choices[Math.min(choices.length - 1, Math.floor(rand() * choices.length))];
}

/** A headline only (used when the time-of-day changes while the page is open). */
export function pickHeadline(
  tod: TimeOfDay,
  memory: GreetingMemory,
  rand: () => number = Math.random,
  forceTime = false,
): { headline: Headline; source: HeadlineSource } {
  let source: HeadlineSource = forceTime || rand() < TIME_SHARE ? tod : 'anytime';
  const poolFor = (s: HeadlineSource) => (s === 'anytime' ? ANYTIME_HEADLINES : TIME_HEADLINES[s]);
  const unseen = (s: HeadlineSource) => poolFor(s).some((x) => !memory.seenHeadlines.includes(x.named) && x.named !== memory.lastHeadline);
  // Once one pool has been used up this session, use the other before repeating anything.
  if (!forceTime && !unseen(source)) {
    const other: HeadlineSource = source === 'anytime' ? tod : 'anytime';
    if (unseen(other)) source = other;
  }
  const headline = pickFresh(poolFor(source), (x) => x.named, memory.seenHeadlines, memory.lastHeadline, rand);
  return { headline, source };
}

/** A full greeting for the time `now`, avoiding repeats recorded in `memory`. */
export function pickGreeting(now: Date, memory: GreetingMemory, rand: () => number = Math.random): Greeting {
  const { headline, source } = pickHeadline(timeOfDay(now), memory, rand);
  const subtitle = pickFresh(SUBTITLES, (x) => x, memory.seenSubtitles, memory.lastSubtitle, rand);
  return { headline, source, subtitle };
}

/** Memory after showing `greeting`. */
export function remember(memory: GreetingMemory, greeting: { headline: Headline; subtitle?: string }): GreetingMemory {
  const seenHeadlines = memory.seenHeadlines.includes(greeting.headline.named)
    ? memory.seenHeadlines
    : [...memory.seenHeadlines, greeting.headline.named];
  const seenSubtitles =
    !greeting.subtitle || memory.seenSubtitles.includes(greeting.subtitle)
      ? memory.seenSubtitles
      : [...memory.seenSubtitles, greeting.subtitle];
  return {
    seenHeadlines,
    seenSubtitles,
    lastHeadline: greeting.headline.named,
    lastSubtitle: greeting.subtitle ?? memory.lastSubtitle,
  };
}
