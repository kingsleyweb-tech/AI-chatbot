import { describe, expect, it } from 'vitest';
import {
  ANYTIME_HEADLINES,
  EMPTY_MEMORY,
  SUBTITLES,
  TIME_HEADLINES,
  firstName,
  pickGreeting,
  pickHeadline,
  remember,
  renderHeadline,
  timeOfDay,
  type GreetingMemory,
  type TimeOfDay,
} from '../src/features/chat/greetings.js';

const at = (hour: number, minute = 0) => new Date(2026, 10, 8, hour, minute);
const ALL_HEADLINES = [...ANYTIME_HEADLINES, ...Object.values(TIME_HEADLINES).flat()];

/** Deterministic pseudo-random sequence. */
function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

describe('timeOfDay', () => {
  it.each<[number, number, TimeOfDay]>([
    [0, 0, 'lateNight'],
    [4, 59, 'lateNight'],
    [5, 0, 'earlyMorning'],
    [8, 59, 'earlyMorning'],
    [9, 0, 'lateMorning'],
    [11, 59, 'lateMorning'],
    [12, 0, 'afternoon'],
    [16, 59, 'afternoon'],
    [17, 0, 'evening'],
    [20, 59, 'evening'],
    [21, 0, 'lateNight'],
    [23, 59, 'lateNight'],
  ])('%i:%i is %s', (hour, minute, expected) => {
    expect(timeOfDay(at(hour, minute))).toBe(expected);
  });
});

describe('greeting library', () => {
  it('every headline puts the name in exactly once', () => {
    for (const h of ALL_HEADLINES) expect(h.named.split('{name}').length - 1, h.named).toBe(1);
  });

  it('every headline reads cleanly without a name', () => {
    for (const h of ALL_HEADLINES) {
      const plain = renderHeadline(h, '');
      expect(plain, h.named).not.toMatch(/\{name\}|undefined|null|,\s*[.?!]|\s[.?!,]|^\s|\s$|\s{2}/);
      expect(plain[0], h.named).toBe(plain[0].toUpperCase());
    }
  });

  it('every headline reads cleanly with a name', () => {
    for (const h of ALL_HEADLINES) {
      const named = renderHeadline(h, 'Kingsley');
      expect(named).toContain('Kingsley');
      expect(named).not.toMatch(/\{name\}|\s[.?!,]|\s{2}/);
      expect(named[0]).toBe(named[0].toUpperCase());
    }
  });

  it('has no duplicate entries and keeps subtitles phone-sized', () => {
    expect(new Set(ALL_HEADLINES.map((h) => h.named)).size).toBe(ALL_HEADLINES.length);
    expect(new Set(SUBTITLES).size).toBe(SUBTITLES.length);
    for (const s of SUBTITLES) expect(s.length, s).toBeLessThanOrEqual(70);
  });
});

describe('firstName', () => {
  it('takes the first word of a real name', () => {
    expect(firstName('Kingsley Anaab')).toBe('Kingsley');
    expect(firstName('  Kesh  ')).toBe('Kesh');
  });
  it('returns nothing for missing or placeholder values', () => {
    for (const v of [undefined, null, '', '   ', 'undefined', 'null', 'someone@example.com', 'You', 'User']) expect(firstName(v)).toBe('');
  });
  it('ignores a display name that is only the email’s local part (stored when no name was given)', () => {
    expect(firstName('kofimensah604', 'kofimensah604@example.com')).toBe('');
    expect(firstName('Kesh', 'kofimensah604@example.com')).toBe('Kesh');
  });
});

describe('pickGreeting', () => {
  it('uses the pool for the current time, or the any-time pool', () => {
    const rand = seeded(1);
    for (let i = 0; i < 200; i++) {
      const g = pickGreeting(at(7), EMPTY_MEMORY, rand);
      expect(['earlyMorning', 'anytime']).toContain(g.source);
      const pool = g.source === 'anytime' ? ANYTIME_HEADLINES : TIME_HEADLINES.earlyMorning;
      expect(pool).toContain(g.headline);
      expect(SUBTITLES).toContain(g.subtitle);
    }
  });

  it('draws from both pools over time', () => {
    const rand = seeded(2);
    const sources = new Set(Array.from({ length: 100 }, () => pickGreeting(at(22), EMPTY_MEMORY, rand).source));
    expect(sources).toEqual(new Set(['lateNight', 'anytime']));
  });

  it('never repeats a headline or subtitle within a session until the pool runs out', () => {
    const rand = seeded(3);
    let memory: GreetingMemory = EMPTY_MEMORY;
    const headlines: string[] = [];
    const subtitles: string[] = [];
    for (let i = 0; i < 30; i++) {
      const g = pickGreeting(at(14), memory, rand);
      headlines.push(g.headline.named);
      subtitles.push(g.subtitle);
      memory = remember(memory, g);
    }
    expect(new Set(headlines).size).toBe(headlines.length);
    expect(new Set(subtitles).size).toBe(subtitles.length);
  });

  it('starts over once a pool is used up, still avoiding the last one shown', () => {
    const rand = seeded(4);
    let memory: GreetingMemory = EMPTY_MEMORY;
    let previous = '';
    for (let i = 0; i < 300; i++) {
      const g = pickHeadline('evening', memory, rand, true);
      expect(g.headline.named).not.toBe(previous);
      previous = g.headline.named;
      memory = remember(memory, g);
    }
  });

  it('does not repeat the previous visit’s greeting', () => {
    const last = TIME_HEADLINES.afternoon[0].named;
    const rand = seeded(5);
    for (let i = 0; i < 200; i++) {
      const g = pickGreeting(at(13), { ...EMPTY_MEMORY, lastHeadline: last, lastSubtitle: SUBTITLES[0] }, rand);
      expect(g.headline.named).not.toBe(last);
      expect(g.subtitle).not.toBe(SUBTITLES[0]);
    }
  });

  it('forceTime picks a headline that fits the new time', () => {
    const g = pickHeadline('lateNight', EMPTY_MEMORY, () => 0.99, true);
    expect(g.source).toBe('lateNight');
    expect(TIME_HEADLINES.lateNight).toContain(g.headline);
  });
});
