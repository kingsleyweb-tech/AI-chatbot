import { beforeEach, describe, expect, it } from 'vitest';
import { coolingDown, markFailed, markHealthy, preferHealthy, resetHealth } from '../server/providers/health.js';

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
