import { describe, expect, it } from 'vitest';
import { indicatorView, nextThreshold, resetClock, thresholdMessage } from '../src/features/usage/usage.js';
import { availableFeatures, availableText, refusalMessage } from '../server/usage/policy.js';
import type { FeatureView } from '../server/shared/types.js';

const NOW = Date.UTC(2026, 10, 12, 10, 0);
const view = (used: number, limit: number | null, extra: Partial<FeatureView> = {}): FeatureView => {
  const remaining = limit === null ? null : Math.max(0, limit - used);
  return {
    id: 'chat',
    label: 'Chat',
    explain: '',
    limited: limit !== null,
    daily: { used, limit, remaining, resetsAt: NOW + 14 * 3_600_000, key: '2026-11-12' },
    weekly: { used, limit: null, remaining: null, resetsAt: NOW + 4 * 86_400_000, key: '2026-11-09' },
    percent: limit === null ? null : limit === 0 ? 100 : Math.round((used / limit) * 100),
    binding: limit === null ? null : 'daily',
    exhausted: limit !== null && used >= limit,
    ...extra,
  } as FeatureView;
};
const state = { unlimited: null, timezone: 'Africa/Accra' } as const;

describe('usage warnings in the browser', () => {
  it('shows each threshold once per period', () => {
    expect(nextThreshold(view(70, 100), {})).toBeNull();
    const t75 = nextThreshold(view(75, 100), {});
    expect(t75).toEqual({ key: 'chat|daily|2026-11-12', threshold: 75, period: 'daily' });
    expect(nextThreshold(view(80, 100), { [t75!.key]: 75 })).toBeNull();
    expect(nextThreshold(view(90, 100), { [t75!.key]: 75 })?.threshold).toBe(90);
    expect(nextThreshold(view(100, 100), { [t75!.key]: 90 })?.threshold).toBe(100);
  });

  it('jumps straight to the highest threshold reached', () => {
    expect(nextThreshold(view(100, 100), {})?.threshold).toBe(100);
  });

  it('treats one request left as the 99% warning for small allowances', () => {
    expect(nextThreshold(view(9, 10), {})?.threshold).toBe(99);
    expect(thresholdMessage(view(9, 10), 99, 'daily', 'Africa/Accra')).toContain('One request remaining');
  });

  it('starts again in a new period', () => {
    const next = view(80, 100, { daily: { used: 80, limit: 100, remaining: 20, resetsAt: NOW + 86_400_000, key: '2026-11-13' } });
    expect(nextThreshold(next, { 'chat|daily|2026-11-12': 100 })?.threshold).toBe(75);
  });

  it('never warns without a limit', () => {
    expect(nextThreshold(view(500, null), {})).toBeNull();
  });
});

describe('the indicator above the composer', () => {
  const text = (u: number, l: number | null, extra: Partial<FeatureView> = {}) => indicatorView(view(u, l, extra), state, NOW)?.text ?? null;
  it('stays hidden below 75%', () => {
    expect(text(0, 100)).toBeNull();
    expect(text(74, 100)).toBeNull();
  });
  it('shows the 75, 90 and 99% messages', () => {
    expect(text(75, 100)).toBe('75% of your daily chat allowance used.');
    expect(text(90, 100)).toBe("90% used. You're approaching your daily chat limit.");
    expect(text(99, 100)).toBe('99% used. Almost all your daily allowance has been used.');
  });
  it('shows the limit and the reset time in 12-hour form', () => {
    // resets 14 h after 10:00 UTC = 00:00 in Accra (UTC+0)
    expect(text(100, 100)).toBe('Daily chat limit reached. Resets at 12:00 AM.');
  });
  it('names other features', () => {
    expect(text(80, 100, { id: 'images', label: 'Image generation' })).toBe('80% of your daily image generation allowance used.');
  });
  it('follows the real percentage for small allowances (3 of 4 is 75%, 9 of 10 is 90%)', () => {
    expect(indicatorView(view(3, 4), state, NOW)?.text).toBe('75% of your daily chat allowance used.');
    expect(indicatorView(view(9, 10), state, NOW)?.level).toBe(90);
  });
  it('hides itself after the reset, for unlimited access, and without a limit', () => {
    expect(indicatorView(view(100, 100), state, NOW + 15 * 3_600_000)).toBeNull();
    expect(indicatorView(view(100, 100), { unlimited: 'admin', timezone: 'Africa/Accra' }, NOW)).toBeNull();
    expect(text(1, null)).toBeNull();
  });
  it('gives the reset day when it is more than a day away', () => {
    expect(resetClock(NOW + 3 * 86_400_000, 'Africa/Accra', NOW)).toBe('Sun 15 Nov, 10:00 AM');
  });
});

describe('a feature that reaches its limit lists the others still available', () => {
  it('lists the features with allowance left and what is left of each', () => {
    const chat = view(150, 150);
    const research = view(6, 20, { id: 'research', label: 'Web research' });
    const images = view(10, 10, { id: 'images', label: 'Image generation' });
    const translation = view(3, null, { id: 'translation', label: 'Translation' });
    const list = availableFeatures([chat, research, images, translation], 'chat');
    expect(list.map((a) => a.id)).toEqual(['research', 'translation']);
    expect(availableText(list)).toBe('Web research (14 left today), Translation (no limit)');
    const msg = refusalMessage('chat', 'daily', NOW + 14 * 3_600_000, 'Africa/Accra', list);
    expect(msg.startsWith('You have used your daily chat allowance. It resets ')).toBe(true);
    expect(msg.endsWith('You can still use: Web research (14 left today), Translation (no limit).')).toBe(true);
    expect(refusalMessage('chat', 'daily', NOW, 'Africa/Accra', [])).toContain('Your other features have also reached their limits.');
  });
});
