import { beforeEach, describe, expect, it } from 'vitest';
import { coolingDown, failureStreak, markFailed, markHealthy, preferHealthy, resetHealth } from '../server/providers/health.js';

describe('model health', () => {
  beforeEach(() => resetHealth());

  it('moves a model whose quota just ran out to the end of the chain', () => {
    markFailed('gemini:flash', 'rate_limited', 1_000);
    expect(preferHealthy(['gemini:flash', 'gemini:pro', 'or:free'], 2_000)).toEqual(['gemini:pro', 'or:free', 'gemini:flash']);
  });

  it('forgets the failure after the cooldown or a success', () => {
    markFailed('a', 'timeout', 0);
    expect(coolingDown('a', 60_000)).toBe(true);
    expect(coolingDown('a', 4 * 60_000)).toBe(false);
    markFailed('b', 'daily_limit', 0);
    markHealthy('b');
    expect(preferHealthy(['b', 'c'], 1)).toEqual(['b', 'c']);
  });

  it('does not cool down on errors that are about the request', () => {
    markFailed('a', 'bad_request', 0);
    markFailed('a', 'context_too_long', 0);
    expect(coolingDown('a', 1)).toBe(false);
  });
});

describe('repeated failures back off, and recover on success', () => {
  beforeEach(() => resetHealth());

  it('a model that keeps timing out rests longer each time (3, 6, 12 ... up to 30 min)', () => {
    const MIN = 60_000;
    markFailed('m', 'timeout', 0);
    expect(coolingDown('m', 3 * MIN - 1)).toBe(true);
    expect(coolingDown('m', 3 * MIN)).toBe(false);
    markFailed('m', 'timeout', 3 * MIN); // failed again right after
    expect(failureStreak('m')).toBe(2);
    expect(coolingDown('m', 3 * MIN + 6 * MIN - 1)).toBe(true);
    let t = 9 * MIN;
    for (let i = 0; i < 6; i++) {
      markFailed('m', 'timeout', t);
      t += 30 * MIN;
    }
    // capped at 30 minutes
    expect(coolingDown('m', t - 30 * MIN + 30 * MIN - 1)).toBe(true);
    expect(coolingDown('m', t)).toBe(false);
  });

  it('one success ends the streak; a failure long after the last one starts over', () => {
    markFailed('m', 'timeout', 0);
    markFailed('m', 'timeout', 3 * 60_000);
    markHealthy('m');
    expect(failureStreak('m')).toBe(0);
    markFailed('n', 'timeout', 0);
    markFailed('n', 'timeout', 5 * 60 * 60_000);
    expect(failureStreak('n')).toBe(1);
  });

  it('server errors rest a model briefly; the provider can also report a model as resting', () => {
    markFailed('a', 'provider_error', 0);
    expect(coolingDown('a', 30_000)).toBe(true);
    expect(coolingDown('a', 61_000)).toBe(false);
    const chain = ['gemini:gemini-3.6-flash', 'gemini:gemini-3.8-flash', 'or:free'];
    expect(preferHealthy(chain, 0, (m) => m === 'gemini:gemini-3.6-flash')).toEqual(['gemini:gemini-3.8-flash', 'or:free', 'gemini:gemini-3.6-flash']);
    // nothing resting: order kept exactly
    expect(preferHealthy(chain, 0, () => false)).toBe(chain);
  });
});
