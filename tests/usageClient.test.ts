import { describe, expect, it } from 'vitest';
import { indicatorText, nextThreshold, thresholdMessage } from '../src/features/usage/usage.js';
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
  it('shows used, remaining and the reset', () => {
    const t = indicatorText(view(75, 100), state, NOW)!;
    expect(t).toMatch(/^Chat: 75% used \| 25% remaining \| Resets /);
  });
  it('says when one request is left and when it is used up', () => {
    expect(indicatorText(view(9, 10), state, NOW)).toContain('One request remaining');
    expect(indicatorText(view(10, 10), state, NOW)).toMatch(/^Chat: allowance used \| Resets /);
  });
  it('shows unlimited access and hides itself without a limit', () => {
    expect(indicatorText(view(1, 10), { unlimited: 'admin', timezone: 'Africa/Accra' }, NOW)).toBe('Unlimited AI Access');
    expect(indicatorText(view(1, null), state, NOW)).toBeNull();
  });
});
