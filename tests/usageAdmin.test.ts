import { beforeEach, describe, expect, it } from 'vitest';
import { accountPath, clearUsageCache, reserveUsage } from '../server/usage/allowance.js';
import { usageAdmin, usageOpSchema, type UsageAdminDeps } from '../server/usage/admin.js';
import { STANDARD_LIMITS, type UsageAccount } from '../server/usage/policy.js';
import { FakeDb } from './fakeDb.js';

const now = Date.parse('2026-11-12T10:00:00Z');
let fake: FakeDb;
let deps: UsageAdminDeps;
const op = (o: unknown) => usageAdmin(deps, usageOpSchema.parse(o));
const logs = () => fake.under('adminLogs/').map((p) => fake.docs.get(p) as Record<string, unknown>);
const acct = (uid: string) => fake.docs.get(accountPath(uid)) as UsageAccount;

beforeEach(() => {
  fake = new FakeDb();
  clearUsageCache();
  deps = {
    db: fake.asFirestore(),
    actor: { uid: 'admin1', email: 'owner@example.com' },
    accounts: async () => [
      { uid: 'u1', email: 'ama@example.com', name: 'Ama' },
      { uid: 'u2', email: 'kofi@example.com', name: 'Kofi' },
      { uid: 'admin1', email: 'owner@example.com', name: 'Owner' },
    ],
    isAdminEmail: (e) => e === 'owner@example.com',
    now,
  };
});

describe('administrator allowance operations', () => {
  it('assigning a profile keeps custom limits, overrides and unlimited access, and is audited', async () => {
    await op({ op: 'assign', uid: 'u1', customLimits: { images: { daily: 30 } } });
    await op({ op: 'unlimited', uid: 'u1', grant: true, until: null, confirm: true });
    await op({ op: 'assign', uid: 'u1', profile: 'premium', reason: 'pilot' });
    expect(acct('u1').profile).toBe('premium');
    expect(acct('u1').customLimits).toEqual({ images: { daily: 30 } });
    expect(acct('u1').unlimited).toMatchObject({ until: null, grantedBy: 'admin1' });
    const last = logs().at(-1)!;
    expect(last).toMatchObject({ action: 'usage_profile_assigned', adminUid: 'admin1', adminEmail: 'owner@example.com', targetUid: 'u1', targetEmail: 'ama@example.com' });
    expect(last.detail).toContain('Standard → Premium');
    expect(last.changes).toMatchObject({ before: { profile: 'standard' }, after: { profile: 'premium' } });
  });

  it('temporary unlimited access records the expiry; revoking restores the profile', async () => {
    const until = now + 48 * 3600_000;
    await op({ op: 'unlimited', uid: 'u2', grant: true, until, reason: 'event week', confirm: true });
    expect(logs().at(-1)).toMatchObject({ action: 'usage_unlimited_granted', changes: { after: { unlimited: true, until } } });
    expect(String(logs().at(-1)!.detail)).toContain('until');
    await op({ op: 'unlimited', uid: 'u2', grant: false, confirm: true });
    expect(acct('u2').unlimited).toBeNull();
    expect(logs().at(-1)).toMatchObject({ action: 'usage_unlimited_revoked', targetUid: 'u2' });
    await expect(op({ op: 'unlimited', uid: 'u2', grant: false, confirm: true })).rejects.toMatchObject({ code: 'not_unlimited' });
    await expect(op({ op: 'unlimited', uid: 'u2', grant: true, until: now - 1, confirm: true })).rejects.toMatchObject({ code: 'bad_time' });
  });

  it('sensitive actions need explicit confirmation', () => {
    expect(() => usageOpSchema.parse({ op: 'reset', uid: 'u1', feature: 'all', period: 'both' })).toThrow();
    expect(() => usageOpSchema.parse({ op: 'unlimited', uid: 'u1', grant: true })).toThrow();
    expect(() => usageOpSchema.parse({ op: 'profileDelete', id: 'team_a' })).toThrow();
  });

  it('profiles: create, edit, delete (built-ins cannot be deleted; unlimited has no limits)', async () => {
    await op({ op: 'profileSave', id: 'team_a', name: 'Team A', limits: STANDARD_LIMITS });
    const got = (await op({ op: 'get' })) as { config: { profiles: Record<string, { name: string }> } };
    expect(got.config.profiles.team_a.name).toBe('Team A');
    await op({ op: 'assign', uid: 'u1', profile: 'team_a' });
    await expect(op({ op: 'profileDelete', id: 'standard', confirm: true })).rejects.toMatchObject({ code: 'builtin_profile' });
    await expect(op({ op: 'profileSave', id: 'unlimited', name: 'x', limits: STANDARD_LIMITS })).rejects.toMatchObject({ code: 'bad_profile' });
    await op({ op: 'profileDelete', id: 'team_a', confirm: true });
    // the account falls back to the default profile; its stored choice is kept for the audit trail
    const user = (await op({ op: 'user', uid: 'u1' })) as { snapshot: { profile: { id: string } } };
    expect(user.snapshot.profile.id).toBe('standard');
    expect(logs().map((l) => l.action)).toEqual(['usage_profile_saved', 'usage_profile_assigned', 'usage_profile_deleted']);
  });

  it('reset settings are validated and audited', async () => {
    await expect(op({ op: 'config', reset: { timezone: 'Mars/Base', dailyTime: '00:00', weeklyDay: 1, weeklyTime: '00:00' } })).rejects.toMatchObject({ code: 'bad_timezone' });
    await expect(op({ op: 'config', defaultProfile: 'unlimited' })).rejects.toMatchObject({ code: 'bad_profile' });
    await op({ op: 'config', reset: { timezone: 'Europe/London', dailyTime: '06:00', weeklyDay: 0, weeklyTime: '06:00' }, features: { images: { enabled: false } } });
    const got = (await op({ op: 'get' })) as { config: { reset: { timezone: string }; features: Record<string, { enabled: boolean }> } };
    expect(got.config.reset.timezone).toBe('Europe/London');
    expect(got.config.features.images.enabled).toBe(false);
    expect(logs().at(-1)).toMatchObject({ action: 'usage_config_changed', changes: { before: { reset: { timezone: 'Africa/Accra' } } } });
  });

  it('lists users near or at their limits; administrators show as unlimited', async () => {
    await op({ op: 'profileSave', id: 'restricted', name: 'Restricted', limits: { ...STANDARD_LIMITS, chat: { daily: 4, weekly: null } } });
    await op({ op: 'assign', uid: 'u1', profile: 'restricted' });
    await op({ op: 'assign', uid: 'u2', profile: 'restricted' });
    for (const id of ['a', 'b', 'c', 'd']) await (await reserveUsage(fake.asFirestore(), { uid: 'u1', admin: false, feature: 'chat', requestId: id, now })).settle();
    for (const id of ['a', 'b', 'c']) await (await reserveUsage(fake.asFirestore(), { uid: 'u2', admin: false, feature: 'chat', requestId: id, now })).settle();
    const r = (await op({ op: 'users' })) as { users: { uid: string; exhausted: string[]; near: string[]; unlimited: string | null }[] };
    expect(r.users.find((u) => u.uid === 'u1')?.exhausted).toEqual(['chat']);
    expect(r.users.find((u) => u.uid === 'u2')?.near).toEqual(['chat']);
    expect(r.users.find((u) => u.uid === 'admin1')?.unlimited).toBe('admin');
    // a manual reset is audited with the counters before and after
    await op({ op: 'reset', uid: 'u1', feature: 'chat', period: 'daily', confirm: true });
    expect(acct('u1').counters?.chat?.du).toBe(0);
    expect(logs().at(-1)).toMatchObject({ action: 'usage_reset', changes: { before: { chat: { du: 4 } }, after: { chat: { du: 0 } } } });
    const a = (await op({ op: 'analytics' })) as { days: { day: string; chat: { requests: number } }[] };
    expect(a.days[0]).toMatchObject({ day: '2026-11-12', chat: { requests: 7 } });
  });
});
