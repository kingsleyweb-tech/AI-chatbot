/** Client for the administrator AI-usage actions (POST /api/admin {action:'usage', op}). The server checks everything. */
import { api } from '@/lib/api';
import type { FeatureId, FeatureView } from '../usage/usage';

export type { FeatureId };

export interface PeriodLimit {
  daily: number | null;
  weekly: number | null;
}
export type Limits = Record<FeatureId, PeriodLimit>;
export interface Profile {
  name: string;
  description: string;
  unlimited?: boolean;
  builtin?: boolean;
  limits: Limits;
}
export interface UsageConfig {
  enabled: boolean;
  features: Record<FeatureId, { enabled: boolean }>;
  reset: { timezone: string; dailyTime: string; weeklyDay: number; weeklyTime: string };
  defaultProfile: string;
  profiles: Record<string, Profile>;
}
export interface FeatureInfo {
  id: FeatureId;
  label: string;
  unit: string;
  explain: string;
}
export interface UsageUserRow {
  uid: string;
  email: string | null;
  name: string;
  profile: { id: string; name: string };
  unlimited: 'admin' | 'grant' | 'profile' | null;
  unlimitedUntil: number | null;
  hasCustom: boolean;
  override: { until: number | null } | null;
  maxPercent: number | null;
  exhausted: FeatureId[];
  near: FeatureId[];
  used: Record<FeatureId, number>;
}
export interface UsageUserDetail {
  uid: string;
  email: string | null;
  account: {
    profile: string | null;
    customLimits: Partial<Record<FeatureId, Partial<PeriodLimit>>> | null;
    override: { limits: Partial<Record<FeatureId, Partial<PeriodLimit>>>; until: number | null; reason?: string | null } | null;
    unlimited: { until: number | null; previousProfile: string; grantedAt: number; reason?: string | null } | null;
  };
  snapshot: { profile: { id: string; name: string }; unlimited: UsageUserRow['unlimited']; timezone: string; features: FeatureView[] };
  history: ({ day: string } & Partial<Record<FeatureId, number>>)[];
}

/** API environment whose allowances the usage pages manage; null = the active (global) environment. */
export type UsageEnvironment = 'main' | 'secondary' | 'temporary';
const ENV_KEY = 'atlas.admin.usageEnvironment';
let chosen: UsageEnvironment | null | undefined;
export function selectedUsageEnvironment(): UsageEnvironment | null {
  if (chosen !== undefined) return chosen;
  try {
    const v = sessionStorage.getItem(ENV_KEY);
    chosen = v === 'main' || v === 'secondary' || v === 'temporary' ? v : null;
  } catch {
    chosen = null;
  }
  return chosen;
}
export function selectUsageEnvironment(v: UsageEnvironment | null) {
  chosen = v;
  try {
    if (v) sessionStorage.setItem(ENV_KEY, v);
    else sessionStorage.removeItem(ENV_KEY);
  } catch {
    // storage unavailable: the choice lasts until the page is reloaded
  }
}

export function usageOp<T>(op: Record<string, unknown>): Promise<T> {
  const environment = selectedUsageEnvironment();
  return api<T>('admin', { json: { action: 'usage', op, ...(environment ? { environment } : {}) } });
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "13 Nov 2026, 18:00" in a time zone */
export function fmtTime(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
}

/** The local date-time value for an <input type="datetime-local"> (browser time) */
export function toLocalInput(ms: number): string {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}
