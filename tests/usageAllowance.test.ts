import { beforeEach, describe, expect, it } from 'vitest';
import {
  accountPath,
  clearUsageCache,
  reserveUsage,
  resetAllowance,
  snapshotOf,
  updateAccount,
  UsageLimitError,
  USAGE_CONFIG_PATH,
} from '../server/usage/allowance.js';
import {
  costOf,
  dailyPeriod,
  DEFAULT_RESET,
  DEFAULT_USAGE_CONFIG,
  effectiveLimits,
  formatReset,
  normalizeUsageConfig,
  weeklyPeriod,
  zonedTime,
  type UsageAccount,
} from '../server/usage/policy.js';
import { FakeDb } from './fakeDb.js';

const T = (iso: string) => Date.parse(iso);

describe('reset periods', () => {
  it('daily period in Africa/Accra (UTC+0) resets at midnight', () => {
    const p = dailyPeriod(T('2026-11-12T15:30:00Z'), DEFAULT_RESET);
    expect(p.key).toBe('2026-11-12');
    expect(new Date(p.start).toISOString()).toBe('2026-11-12T00:00:00.000Z');
    expect(new Date(p.end).toISOString()).toBe('2026-11-13T00:00:00.000Z');
  });

  it('a reset time later in the day: before it, the period started yesterday', () => {
    const r = { ...DEFAULT_RESET, dailyTime: '06:00' };
    expect(dailyPeriod(T('2026-11-12T05:59:00Z'), r).key).toBe('2026-11-11');
    expect(dailyPeriod(T('2026-11-12T06:00:00Z'), r).key).toBe('2026-11-12');
    expect(new Date(dailyPeriod(T('2026-11-12T05:59:00Z'), r).end).toISOString()).toBe('2026-11-12T06:00:00.000Z');
  });

  it('weekly period starts on the configured day (Monday 00:00 by default)', () => {
    // 12 Nov 2026 is a Thursday
    const p = weeklyPeriod(T('2026-11-12T10:00:00Z'), DEFAULT_RESET);
    expect(p.key).toBe('2026-11-09');
    expect(new Date(p.end).toISOString()).toBe('2026-11-16T00:00:00.000Z');
    // exactly at the reset, the new week has begun
    expect(weeklyPeriod(T('2026-11-16T00:00:00Z'), DEFAULT_RESET).key).toBe('2026-11-16');
    const fri = { ...DEFAULT_RESET, weeklyDay: 5, weeklyTime: '18:00' };
    expect(weeklyPeriod(T('2026-11-13T17:59:00Z'), fri).key).toBe('2026-11-06');
    expect(weeklyPeriod(T('2026-11-13T18:00:00Z'), fri).key).toBe('2026-11-13');
  });

  it('is DST-safe: the next reset follows the zone offset change', () => {
    const ny = { ...DEFAULT_RESET, timezone: 'America/New_York' };
    // the night US clocks fall back (1 Nov 2026): the day is 25 hours long
    const p = dailyPeriod(T('2026-11-01T12:00:00Z'), ny);
    expect(new Date(p.start).toISOString()).toBe('2026-11-01T04:00:00.000Z'); // 00:00 EDT
    expect(new Date(p.end).toISOString()).toBe('2026-11-02T05:00:00.000Z'); // 00:00 EST
    // spring forward (8 Mar 2026): 02:30 does not exist and moves to a real instant
    const gap = zonedTime(2026, 3, 8, 2, 30, 'America/New_York');
    expect(Number.isFinite(gap)).toBe(true);
    expect(dailyPeriod(T('2026-03-08T12:00:00Z'), ny).end - dailyPeriod(T('2026-03-08T12:00:00Z'), ny).start).toBe(23 * 3600_000);
  });

  it('formats the reset time in the configured zone (no fixed message)', () => {
    expect(formatReset(T('2026-11-13T00:00:00Z'), 'Africa/Accra')).toBe('at 00:00 on Fri 13 Nov (Africa/Accra)');
    expect(formatReset(T('2026-11-13T00:00:00Z'), 'Europe/London')).toContain('(Europe/London)');
  });
});

describe('profiles and effective limits', () => {
  const cfg = DEFAULT_USAGE_CONFIG;
  const now = T('2026-11-12T10:00:00Z');

  it('administrators are unlimited automatically', () => {
    expect(effectiveLimits(cfg, null, true, now).unlimited).toBe('admin');
  });

  it('an unlimited grant applies until it expires, then the profile applies again', () => {
    const acct: UsageAccount = { profile: 'premium', unlimited: { until: now + 3600_000, previousProfile: 'premium', grantedBy: 'a', grantedAt: now } };
    const e = effectiveLimits(cfg, acct, false, now);
    expect(e.unlimited).toBe('grant');
    expect(e.unlimitedUntil).toBe(now + 3600_000);
    const later = effectiveLimits(cfg, acct, false, now + 7200_000);
    expect(later.unlimited).toBe(null);
    expect(later.grantExpired).toBe(true);
    expect(later.profileId).toBe('premium');
    expect(later.limits.chat.daily).toBe(300);
  });

  it('custom limits and a temporary override change only what they set', () => {
    const acct: UsageAccount = {
      profile: 'standard',
      customLimits: { images: { daily: 25 } },
      override: { limits: { chat: { daily: 999 } }, until: now + 1000 },
    };
    const e = effectiveLimits(cfg, acct, false, now);
    expect(e.limits.images).toEqual({ daily: 25, weekly: 40 });
    expect(e.limits.chat.daily).toBe(999);
    expect(effectiveLimits(cfg, acct, false, now + 2000).limits.chat.daily).toBe(150);
  });

  it('normalizes a stored config: bad values fall back, unknown profiles need a valid id', () => {
    const c = normalizeUsageConfig({
      reset: { timezone: 'Not/AZone', dailyTime: '25:00', weeklyDay: 9 },
      profiles: { team_a: { name: 'Team A', limits: { chat: { daily: 500, weekly: null } } }, 'Bad Id': { name: 'x' } },
      defaultProfile: 'unlimited',
      features: { images: { enabled: false } },
    });
    expect(c.reset).toEqual(DEFAULT_RESET);
    expect(c.profiles.team_a.limits.chat).toEqual({ daily: 500, weekly: null });
    expect(c.profiles['Bad Id']).toBeUndefined();
    expect(c.defaultProfile).toBe('standard'); // unlimited cannot be everyone's default
    expect(c.features.images.enabled).toBe(false);
    expect(c.features.chat.enabled).toBe(true);
  });

  it('heavier work counts more units', () => {
    expect(costOf('chat')).toBe(1);
    expect(costOf('research', { deepResearch: true })).toBe(3);
    expect(costOf('voice_output', { chars: 2500 })).toBe(3);
    expect(costOf('translation', { chars: 100 })).toBe(1);
  });
});

describe('reserve and settle', () => {
  let fake: FakeDb;
  const db = () => fake.asFirestore();
  const now = T('2026-11-12T10:00:00Z');
  const uid = 'u1';
  const setLimit = async (feature: string, daily: number | null, weekly: number | null = null) => {
    await fake.set(USAGE_CONFIG_PATH, { profiles: { standard: { limits: { [feature]: { daily, weekly } } } } });
    clearUsageCache();
  };

  beforeEach(() => {
    fake = new FakeDb();
    clearUsageCache();
  });

  it('counts a request and shows the new totals', async () => {
    const r = await reserveUsage(db(), { uid, admin: false, feature: 'chat', requestId: 'm1', now });
    expect(r.counted).toBe(true);
    expect(r.view.daily).toMatchObject({ used: 1, limit: 150, remaining: 149 });
    await r.settle();
    const acct = fake.docs.get(accountPath(uid)) as UsageAccount;
    expect(acct.counters?.chat).toEqual({ d: '2026-11-12', du: 1, w: '2026-11-09', wu: 1 });
  });

  it('refuses before anything starts when the allowance is used, with the real reset time', async () => {
    await setLimit('images', 2);
    for (const id of ['a', 'b']) await (await reserveUsage(db(), { uid, admin: false, feature: 'images', requestId: id, now })).settle();
    const err = await reserveUsage(db(), { uid, admin: false, feature: 'images', requestId: 'c', now }).catch((e) => e);
    expect(err).toBeInstanceOf(UsageLimitError);
    expect(err.status).toBe(429);
    expect(err.details).toMatchObject({ feature: 'images', period: 'daily', used: 2, limit: 2, resetsAt: T('2026-11-13T00:00:00Z') });
    expect(err.message).toContain('at 00:00 on Fri 13 Nov (Africa/Accra)');
  });

  it('one feature running out does not block another', async () => {
    await setLimit('images', 1);
    await (await reserveUsage(db(), { uid, admin: false, feature: 'images', requestId: 'a', now })).settle();
    await expect(reserveUsage(db(), { uid, admin: false, feature: 'images', requestId: 'b', now })).rejects.toBeInstanceOf(UsageLimitError);
    await expect(reserveUsage(db(), { uid, admin: false, feature: 'chat', requestId: 'b', now })).resolves.toMatchObject({ counted: true });
  });

  it('a retry with the same request id is not counted twice', async () => {
    const a = await reserveUsage(db(), { uid, admin: false, feature: 'chat', requestId: 'same', now });
    await a.settle();
    const b = await reserveUsage(db(), { uid, admin: false, feature: 'chat', requestId: 'same', now });
    expect(b.counted).toBe(false);
    await b.settle();
    await a.settle(); // settling twice changes nothing
    expect((fake.docs.get(accountPath(uid)) as UsageAccount).counters?.chat?.du).toBe(1);
  });

  it('a failure before processing gives the units back; a later retry is counted once', async () => {
    const r = await reserveUsage(db(), { uid, admin: false, feature: 'research', requestId: 'x', detail: { deepResearch: true }, now });
    expect(r.view.daily.used).toBe(3);
    await r.release();
    expect((fake.docs.get(accountPath(uid)) as UsageAccount).counters?.research?.du).toBe(0);
    const again = await reserveUsage(db(), { uid, admin: false, feature: 'research', requestId: 'x', detail: { deepResearch: true }, now });
    expect(again.counted).toBe(true);
    await again.settle();
    expect((fake.docs.get(accountPath(uid)) as UsageAccount).counters?.research?.du).toBe(3);
  });

  it('settles a different final amount (actual usage)', async () => {
    const r = await reserveUsage(db(), { uid, admin: false, feature: 'voice_output', requestId: 'v', detail: { chars: 3000 }, now });
    await r.settle(1);
    expect((fake.docs.get(accountPath(uid)) as UsageAccount).counters?.voice_output?.du).toBe(1);
  });

  it('concurrent requests never pass the limit (optimistic concurrency)', async () => {
    await setLimit('images', 3);
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => reserveUsage(db(), { uid, admin: false, feature: 'images', requestId: `c${i}`, now })),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    expect(ok).toBe(3);
    expect((fake.docs.get(accountPath(uid)) as UsageAccount).counters?.images?.du).toBe(3);
  });

  it('a request that starts with something left finishes, even if heavier than what is left', async () => {
    await setLimit('research', 4);
    await (await reserveUsage(db(), { uid, admin: false, feature: 'research', requestId: 'a', detail: { deepResearch: true }, now })).settle();
    const r = await reserveUsage(db(), { uid, admin: false, feature: 'research', requestId: 'b', detail: { deepResearch: true }, now });
    expect(r.counted).toBe(true);
    expect(r.view.exhausted).toBe(true);
  });

  it('counts restart when the day resets; the week keeps counting', async () => {
    await (await reserveUsage(db(), { uid, admin: false, feature: 'chat', requestId: 'a', now })).settle();
    const next = await reserveUsage(db(), { uid, admin: false, feature: 'chat', requestId: 'b', now: T('2026-11-13T00:00:01Z') });
    expect(next.view.daily.used).toBe(1);
    expect(next.view.weekly.used).toBe(2);
  });

  it('administrators and unlimited users are not limited (counted for analytics only)', async () => {
    await setLimit('images', 1);
    await (await reserveUsage(db(), { uid, admin: true, feature: 'images', requestId: 'a', now })).settle();
    await expect(reserveUsage(db(), { uid, admin: true, feature: 'images', requestId: 'b', now })).resolves.toMatchObject({ counted: true });
    await updateAccount(db(), 'u2', () => ({ unlimited: { until: null, previousProfile: 'standard', grantedBy: 'admin', grantedAt: now } }));
    for (const id of ['a', 'b', 'c']) await (await reserveUsage(db(), { uid: 'u2', admin: false, feature: 'images', requestId: id, now })).settle();
    expect(fake.docs.get('usageStats/2026-11-12')).toMatchObject({ images_requests: 5 });
  });

  it('an expired temporary grant is cleared and recorded in the audit log', async () => {
    await setLimit('images', 1);
    await updateAccount(db(), uid, () => ({ profile: 'premium', unlimited: { until: now - 1, previousProfile: 'premium', grantedBy: 'admin', grantedAt: now - 10 } }));
    await (await reserveUsage(db(), { uid, admin: false, feature: 'chat', requestId: 'a', now })).settle();
    await new Promise((r) => setTimeout(r, 10));
    expect((fake.docs.get(accountPath(uid)) as UsageAccount).unlimited).toBeNull();
    expect((fake.docs.get(accountPath(uid)) as UsageAccount).profile).toBe('premium');
    const log = fake.under('adminLogs/').map((p) => fake.docs.get(p)!);
    expect(log[0]).toMatchObject({ action: 'usage_unlimited_expired', targetUid: uid });
  });

  it('a manual reset clears the chosen period only', async () => {
    for (const id of ['a', 'b']) await (await reserveUsage(db(), { uid, admin: false, feature: 'chat', requestId: id, now })).settle();
    await resetAllowance(db(), uid, 'chat', 'daily', now);
    expect((fake.docs.get(accountPath(uid)) as UsageAccount).counters?.chat).toMatchObject({ du: 0, wu: 2 });
    await resetAllowance(db(), uid, 'all', 'both', now);
    expect((fake.docs.get(accountPath(uid)) as UsageAccount).counters?.chat).toMatchObject({ du: 0, wu: 0 });
  });

  it('a disabled feature or master switch means no individual limit', async () => {
    await fake.set(USAGE_CONFIG_PATH, { features: { images: { enabled: false } }, profiles: { standard: { limits: { images: { daily: 0, weekly: 0 } } } } });
    clearUsageCache();
    await expect(reserveUsage(db(), { uid, admin: false, feature: 'images', requestId: 'a', now })).resolves.toMatchObject({ counted: true });
    const snap = snapshotOf(normalizeUsageConfig({ enabled: false }), null, false, now);
    expect(snap.features.every((f) => !f.limited)).toBe(true);
  });

  it('the snapshot shows percentages and the period that runs out first', () => {
    const cfg = normalizeUsageConfig({ profiles: { standard: { limits: { chat: { daily: 100, weekly: 120 } } } } });
    const acct: UsageAccount = { counters: { chat: { d: '2026-11-12', du: 50, w: '2026-11-09', wu: 108 } } };
    const chat = snapshotOf(cfg, acct, false, now).features.find((f) => f.id === 'chat')!;
    expect(chat.percent).toBe(90);
    expect(chat.binding).toBe('weekly');
    expect(chat.weekly.remaining).toBe(12);
  });
});
