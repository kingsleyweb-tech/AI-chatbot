/**
 * The signed-in user's AI allowances in the browser: one shared store, fed by
 * GET /api/chat?usage (on demand, never a Firestore listener) and by the `allowance` event each
 * chat reply sends right after it was reserved. The server decides everything; this only shows it.
 *
 * Also the warning thresholds (75, 90, 99 and 100%): each is shown once per feature and
 * period, remembered on this device, and forgotten when that period resets.
 */
import { useSyncExternalStore } from 'react';
// relative imports (no path aliases): the tests import this file directly
import type { FeatureId } from '../../../server/usage/policy.js';
import type { FeatureView } from '../../../server/shared/types.js';

export type { FeatureId, FeatureView };

export interface UsageDayRow {
  day: string;
  [feature: string]: number | string;
}

export interface UsageState {
  profile: { id: string; name: string };
  unlimited: 'admin' | 'grant' | 'profile' | null;
  unlimitedUntil: number | null;
  timezone: string;
  enabled: boolean;
  features: FeatureView[];
  history: UsageDayRow[];
  generatedAt: number;
}

let state: UsageState | null = null;
let error: string | null = null;
let inflight: Promise<void> | null = null;
let lastFetch = 0;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

let fetcher: (() => Promise<UsageState>) | null = null;
/** set once by the app (keeps this module free of the API client, for tests) */
export function setUsageFetcher(f: () => Promise<UsageState>) {
  fetcher = f;
}

export function refreshUsage(force = false): Promise<void> {
  if (!fetcher) return Promise.resolve();
  if (inflight) return inflight;
  if (!force && state && Date.now() - lastFetch < 15_000) return Promise.resolve();
  inflight = fetcher()
    .then((s) => {
      state = s;
      error = null;
      lastFetch = Date.now();
      checkThresholds(s.features);
    })
    .catch((e: unknown) => {
      error = e instanceof Error ? e.message : 'Usage is not available right now.';
    })
    .finally(() => {
      inflight = null;
      notify();
    });
  return inflight;
}

/** A reply was accepted: its feature's new totals (from the chat stream). */
export function applyFeature(view: FeatureView) {
  if (state) state = { ...state, features: state.features.map((f) => (f.id === view.id ? view : f)) };
  lastFocus = view.id;
  checkThresholds([view]);
  notify();
}

let lastFocus: FeatureId = 'chat';
export function setUsageFocus(f: FeatureId) {
  if (lastFocus === f) return;
  lastFocus = f;
  notify();
}

export function clearUsage() {
  state = null;
  error = null;
  lastFetch = 0;
  notify();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
let snap: { state: UsageState | null; error: string | null; focus: FeatureId } = { state, error, focus: lastFocus };
function getSnapshot() {
  if (snap.state !== state || snap.error !== error || snap.focus !== lastFocus) snap = { state, error, focus: lastFocus };
  return snap;
}
export function useUsage() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/* ---------------------------------------------------------------- thresholds */

export const THRESHOLDS = [75, 90, 99, 100] as const;

/** The highest threshold this period has reached that has not been shown yet (pure). */
export function nextThreshold(view: FeatureView, shown: Record<string, number>): { key: string; threshold: number; period: 'daily' | 'weekly' } | null {
  if (view.percent === null || !view.binding) return null;
  const p = view[view.binding];
  if (p.limit === null) return null;
  const pct = p.limit === 0 ? 100 : (p.used / p.limit) * 100;
  // 99% means "one request left" for small allowances too
  const reached = [...THRESHOLDS].reverse().find((t) => (t === 99 ? p.remaining === 1 || pct >= 99 : pct >= t));
  if (!reached) return null;
  const key = `${view.id}|${view.binding}|${p.key}`;
  if ((shown[key] ?? 0) >= reached) return null;
  return { key, threshold: reached, period: view.binding };
}

/** The warning text, with the real figures. */
export function thresholdMessage(view: FeatureView, threshold: number, period: 'daily' | 'weekly', tz: string): string {
  const p = view[period];
  const when = resetText(p.resetsAt, tz);
  const name = view.label.toLowerCase();
  if (threshold >= 100) return `You've used all of your ${period} ${name} allowance. It resets ${when}. Other features still work.`;
  if (threshold >= 99 || p.remaining === 1) return `You've used ${Math.floor((p.used / (p.limit || 1)) * 100)}% of your ${period} ${name} allowance. One request remaining. Resets ${when}.`;
  return `You've used ${Math.round((p.used / (p.limit || 1)) * 100)}% of your ${period} ${name} allowance (${p.remaining} left). Resets ${when}.`;
}

const SHOWN_KEY = 'atlas.usageWarnings';
function loadShown(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(SHOWN_KEY) ?? '{}') as Record<string, number>;
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}
function saveShown(shown: Record<string, number>, current: FeatureView[]) {
  // forget periods that have ended (their keys are no longer current)
  const live = new Set(current.flatMap((f) => [`${f.id}|daily|${f.daily.key}`, `${f.id}|weekly|${f.weekly.key}`]));
  const kept = Object.fromEntries(Object.entries(shown).filter(([k]) => live.has(k) || !current.some((f) => k.startsWith(`${f.id}|`))));
  try {
    localStorage.setItem(SHOWN_KEY, JSON.stringify(kept));
  } catch {
    /* private mode: warnings may repeat on this device */
  }
}

let warn: ((message: string, threshold: number) => void) | null = null;
export function setUsageWarner(w: ((message: string, threshold: number) => void) | null) {
  warn = w;
}

function checkThresholds(views: FeatureView[]) {
  if (!warn || !state) return;
  const shown = loadShown();
  let changed = false;
  for (const v of views) {
    const next = nextThreshold(v, shown);
    if (!next) continue;
    shown[next.key] = next.threshold;
    changed = true;
    warn(thresholdMessage(v, next.threshold, next.period, state.timezone), next.threshold);
  }
  if (changed) saveShown(shown, state.features.map((f) => views.find((v) => v.id === f.id) ?? f));
}

/* ---------------------------------------------------------------- formatting */

/** "today at 00:00", "tomorrow at 00:00", "Mon 16 Nov at 00:00" in the allowance's time zone. */
export function resetText(at: number, tz: string, now = Date.now()): string {
  const day = (t: number) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));
  if (day(at) === day(now)) return `today at ${time}`;
  if (day(at) === day(now + 86_400_000)) return `tomorrow at ${time}`;
  const d = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(at));
  return `${d} at ${time}`;
}

/** "3 h 20 min", "12 min", "2 days 4 h" */
export function countdown(at: number, now = Date.now()): string {
  const ms = Math.max(0, at - now);
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ${min % 60 ? `${min % 60} min` : ''}`.trim();
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'}${h % 24 ? ` ${h % 24} h` : ''}`;
}

/** The compact line above the composer. */
export function indicatorText(view: FeatureView | undefined, s: Pick<UsageState, 'unlimited' | 'timezone'>, now = Date.now()): string | null {
  if (s.unlimited) return 'Unlimited AI Access';
  if (!view || view.percent === null || !view.binding) return null;
  const p = view[view.binding];
  if (p.limit === null) return null;
  const used = p.limit === 0 ? 100 : Math.min(100, Math.round((p.used / p.limit) * 100));
  const when = resetText(p.resetsAt, s.timezone, now);
  if (p.remaining === 0) return `${view.label}: allowance used | Resets ${when}`;
  if (p.remaining === 1) return `${view.label}: ${used}% used | One request remaining | Resets ${when}`;
  return `${view.label}: ${used}% used | ${100 - used}% remaining | Resets ${when}`;
}
