import { describe, expect, it } from 'vitest';
import {
  Downsampler,
  encodeWav,
  FRAME_MS,
  FRAME_SAMPLES,
  frameFeatures,
  judgeTranscript,
  SAMPLE_RATE,
  VoiceActivityDetector,
  type VadEvent,
  type VadMode,
} from '../src/lib/vad.js';

/* ---------- made-up audio ---------- */

let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
const amp = (db: number) => 10 ** (db / 20);

/** A voiced sound (pitch f0 plus harmonics, like a vowel) at about `db` dBFS. */
function voice(ms: number, db: number, f0 = 140): Float32Array {
  const n = (ms / 1000) * SAMPLE_RATE;
  const out = new Float32Array(n);
  const a = amp(db) * Math.SQRT2 * 0.75;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    out[i] = a * (Math.sin(2 * Math.PI * f0 * t) + 0.5 * Math.sin(4 * Math.PI * f0 * t) + 0.25 * Math.sin(6 * Math.PI * f0 * t)) + amp(db - 30) * rand();
  }
  return out;
}
/** Steady noise (fan, rain, traffic) at about `db` dBFS. */
function noise(ms: number, db: number): Float32Array {
  const n = (ms / 1000) * SAMPLE_RATE;
  const out = new Float32Array(n);
  const a = amp(db) * Math.sqrt(3);
  for (let i = 0; i < n; i++) out[i] = a * rand();
  return out;
}
const quiet = (ms: number) => noise(ms, -62);

function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

interface Timed {
  at: number;
  ev: VadEvent;
}
/** Feed audio through a detector; `react` may answer events (like the app answers "pause"). */
function run(vad: VoiceActivityDetector, audio: Float32Array, react?: (ev: VadEvent, vad: VoiceActivityDetector) => void): Timed[] {
  const out: Timed[] = [];
  let prev: Float32Array | undefined;
  for (let i = 0, k = 0; i + FRAME_SAMPLES <= audio.length; i += FRAME_SAMPLES, k++) {
    const frame = audio.subarray(i, i + FRAME_SAMPLES);
    for (const ev of vad.push(frameFeatures(frame, prev))) {
      out.push({ at: k * FRAME_MS, ev });
      react?.(ev, vad);
    }
    prev = frame;
  }
  return out;
}
const types = (t: Timed[]) => t.map((x) => x.ev.type);
function detector(mode: VadMode = 'listen') {
  const v = new VoiceActivityDetector();
  // learn the room first
  run(v, quiet(1000));
  v.setMode(mode);
  return v;
}

/** Atlas AI's voice coming back through the microphone, in syllables with small gaps. */
function echo(ms: number, db: number): Float32Array {
  const parts: Float32Array[] = [];
  for (let t = 0; t < ms; t += 300) parts.push(voice(220, db, 110 + (t % 900) / 10), quiet(80));
  return concat(...parts);
}

/* ---------- tests ---------- */

describe('frame features', () => {
  it('measures the level and tells a voiced sound from steady noise', () => {
    const v = voice(40, -25);
    const f = frameFeatures(v.subarray(320, 640), v.subarray(0, 320));
    expect(f.db).toBeGreaterThan(-28);
    expect(f.db).toBeLessThan(-22);
    expect(f.voicing).toBeGreaterThan(0.8);
    const n = noise(40, -25);
    expect(frameFeatures(n.subarray(320, 640), n.subarray(0, 320)).voicing).toBeLessThan(0.35);
  });
});

describe('turn taking (listening)', () => {
  it('starts on speech and ends after a pause when the turn model could not answer', () => {
    const v = detector();
    const t = run(v, concat(voice(1500, -25), quiet(3000)), (ev, d) => ev.type === 'pause' && d.setVerdict('failed'));
    expect(types(t)).toEqual(['start', 'pause', 'end']);
    const end = t.find((x) => x.ev.type === 'end')!;
    // speech ended at 1.5 s; without an answer the pause that ends a turn is 1.3 s
    expect(end.at).toBeGreaterThanOrEqual(2700);
    expect(end.at).toBeLessThanOrEqual(3000);
    expect(end.ev).toMatchObject({ barge: false });
    expect((end.ev as { voicedMs: number }).voicedMs).toBeGreaterThan(1200);
  });

  it('does not cut the user off at a short pause or a breath mid-sentence', () => {
    const v = detector();
    const t = run(v, concat(voice(1000, -25), quiet(700), noise(200, -50), voice(1000, -25, 120), quiet(3000)));
    expect(types(t).filter((x) => x === 'end')).toHaveLength(1);
    expect(types(t).filter((x) => x === 'start')).toHaveLength(1);
  });

  it('while the turn model has not answered yet, it waits (at most the longest pause)', () => {
    const v = detector();
    const end = run(v, concat(voice(1500, -25), quiet(3500))).find((x) => x.ev.type === 'end')!;
    expect(end.at - 1500).toBeGreaterThanOrEqual(2500);
    expect(end.at - 1500).toBeLessThanOrEqual(2800);
  });

  it('ignores a fan or traffic that starts suddenly', () => {
    const v = detector();
    expect(run(v, concat(noise(3000, -30), quiet(1000)))).toEqual([]);
  });

  it('ends quickly when the turn model says the speaker sounds finished', () => {
    const v = detector();
    const t = run(v, concat(voice(1500, -25), quiet(3000)), (ev, d) => ev.type === 'pause' && d.setVerdict('complete'));
    const end = t.find((x) => x.ev.type === 'end')!;
    expect(end.at - 1500).toBeLessThan(800);
  });

  it('waits longer when the turn model says the speaker is not finished (slow speakers)', () => {
    const v = detector();
    const t = run(v, concat(voice(1500, -25), quiet(4000)), (ev, d) => ev.type === 'pause' && d.setVerdict('incomplete'));
    const end = t.find((x) => x.ev.type === 'end')!;
    expect(end.at - 1500).toBeGreaterThanOrEqual(2500);
  });

  it('"more time to speak" waits through a longer pause', () => {
    const v = detector();
    v.setPatient(true);
    const t = run(v, concat(voice(1500, -25), quiet(1800), voice(800, -25), quiet(4000)));
    expect(types(t).filter((x) => x === 'end')).toHaveLength(1);
  });

  it('ignores steady background noise (fan, traffic, rain)', () => {
    const v = detector();
    expect(run(v, noise(5000, -35))).toEqual([]);
  });

  it('a knock or a click is not a turn', () => {
    const v = detector();
    const t = run(v, concat(voice(160, -20), quiet(1500)));
    expect(types(t)).not.toContain('end');
  });

  it('once it knows the user, quiet speech from across the room (TV, another person) does not start a turn', () => {
    const v = detector();
    v.confirmUser(-22);
    expect(run(v, concat(voice(2000, -48, 200), quiet(2000)))).toEqual([]);
    // the user, at their usual level, still does
    expect(types(run(v, concat(voice(1200, -23), quiet(3000))))).toContain('end');
  });

  it('forceEnd finishes the current turn at once (tap to finish)', () => {
    const v = detector();
    run(v, voice(800, -25));
    expect(v.forceEnd()).toMatchObject({ type: 'end' });
    expect(v.forceEnd()).toBeNull();
  });
});

describe('interrupting Atlas AI (barge-in)', () => {
  it('does not mistake its own voice (echo) for the user', () => {
    const v = detector('speaking');
    expect(run(v, echo(6000, -38))).toEqual([]);
  });

  it('keeps talking through steady background noise', () => {
    const v = detector('speaking');
    expect(run(v, concat(echo(1000, -40), noise(3000, -30)))).toEqual([]);
  });

  it('a nearby person talking quietly while it speaks does not interrupt', () => {
    const v = detector();
    v.confirmUser(-20);
    v.setMode('speaking');
    expect(run(v, concat(echo(1000, -40), voice(2500, -42, 210)))).toEqual([]);
  });

  it('the user speaking clearly over it: lower the voice, then stop it, then the finished turn', () => {
    const v = detector('speaking');
    const t = run(v, concat(echo(1000, -40), voice(2000, -20), quiet(3000)));
    expect(types(t)).toEqual(['start', 'barge-strong', 'pause', 'end']);
    expect(t[0].ev).toMatchObject({ barge: true });
    // noticed within about half a second of the user starting at 1 s
    expect(t[0].at - 1000).toBeLessThan(600);
  });

  it('a short loud sound over it (a cough) is dropped and it carries on', () => {
    const v = detector('speaking');
    const t = run(v, concat(echo(1000, -40), voice(320, -18), quiet(1500)));
    expect(types(t)).not.toContain('barge-strong');
    expect(types(t)).not.toContain('end');
  });

  it('measures its own voice for a moment before listening for interruptions', () => {
    const v = detector('speaking');
    // loud syllables from the moment it starts talking are taken as echo
    expect(run(v, echo(2000, -26))).toEqual([]);
  });

  it('while it is thinking, speech interrupts at normal sensitivity', () => {
    const v = detector('busy');
    const t = run(v, concat(voice(1200, -28), quiet(3000)));
    expect(t[0].ev).toMatchObject({ type: 'start', barge: true });
    expect(t.at(-1)!.ev).toMatchObject({ type: 'end', barge: true });
  });

  it('off: the microphone is ignored', () => {
    const v = detector('off');
    expect(run(v, voice(2000, -20))).toEqual([]);
  });
});

describe('what was heard', () => {
  it('drops Whisper stock phrases in near-silence, fillers and noise tags', () => {
    expect(judgeTranscript('Thank you.', { voicedMs: 300 })).toBe('noise');
    expect(judgeTranscript('Thanks for watching!')).toBe('noise');
    expect(judgeTranscript('Um... uh.')).toBe('noise');
    expect(judgeTranscript('[Music]')).toBe('noise');
    expect(judgeTranscript('   ')).toBe('empty');
  });
  it('keeps a real "thank you" after real speech, and ordinary messages', () => {
    expect(judgeTranscript('Thank you.', { voicedMs: 1200 })).toBe('ok');
    expect(judgeTranscript('What is the capital of Ghana?')).toBe('ok');
  });
  it('recognises Atlas AI own words coming back as echo', () => {
    const said = 'The capital of France is Paris, a city on the Seine.';
    expect(judgeTranscript('capital of France is Paris', { echoOf: said })).toBe('echo');
    expect(judgeTranscript('Paris', { echoOf: said, barge: true })).toBe('echo');
    expect(judgeTranscript('What about Germany?', { echoOf: said, barge: true })).toBe('ok');
  });
  it('an interruption must be a real phrase or a clear stop word', () => {
    expect(judgeTranscript('okay', { barge: true })).toBe('noise');
    expect(judgeTranscript('hmm', { barge: true })).toBe('noise');
    expect(judgeTranscript('Stop.', { barge: true })).toBe('ok');
    expect(judgeTranscript('Wait, wait.', { barge: true })).toBe('ok');
    expect(judgeTranscript('Tell me more about that', { barge: true })).toBe('ok');
  });
});

describe('audio helpers', () => {
  it('writes a 16 kHz mono 16-bit WAV', async () => {
    const wav = encodeWav(new Float32Array(1600).fill(0.5));
    expect(wav.type).toBe('audio/wav');
    const b = new DataView(await wav.arrayBuffer());
    expect(b.byteLength).toBe(44 + 3200);
    expect(String.fromCharCode(b.getUint8(0), b.getUint8(1), b.getUint8(2), b.getUint8(3))).toBe('RIFF');
    expect(b.getUint32(24, true)).toBe(16_000);
    expect(b.getInt16(44, true)).toBe(16383);
  });
  it('resamples 48 kHz to 16 kHz in pieces of any size', () => {
    const d = new Downsampler(48_000);
    const a = d.push(new Float32Array(2048).fill(0.2));
    const b = d.push(new Float32Array(2048).fill(0.2));
    expect(a.length + b.length).toBe(Math.floor(4096 / 3));
    expect(a[0]).toBeCloseTo(0.2, 5);
  });
});
