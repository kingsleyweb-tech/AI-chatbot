import { cn } from '@/lib/utils';

/**
 * "Last active" shown to administrators. The server writes users/{uid}.lastActiveAt
 * at most every 5 minutes while someone uses the app (time only, never what they did),
 * so "Active now" means within the last 10 minutes.
 */
export const ACTIVE_NOW_MS = 10 * 60_000;
const DAY = 86_400_000;

export type ActiveLevel = 'now' | 'today' | 'idle' | 'never';

export function activeLevel(at: number | null | undefined, now = Date.now()): ActiveLevel {
  if (!at) return 'never';
  if (now - at < ACTIVE_NOW_MS) return 'now';
  if (now - at < DAY) return 'today';
  return 'idle';
}

/** "Active now", "Active 25 min ago", "Active 3 h ago", "Last seen 4 days ago", "Never active" */
export function activeText(at: number | null | undefined, now = Date.now()): string {
  if (!at) return 'Never active';
  const ago = Math.max(0, now - at);
  if (ago < ACTIVE_NOW_MS) return 'Active now';
  if (ago < 3_600_000) return `Active ${Math.round(ago / 60_000)} min ago`;
  if (ago < DAY) return `Active ${Math.round(ago / 3_600_000)} h ago`;
  const days = Math.floor(ago / DAY);
  if (days < 60) return `Last seen ${days} ${days === 1 ? 'day' : 'days'} ago`;
  return `Last seen ${new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

const DOT: Record<ActiveLevel, string> = {
  now: 'bg-emerald-500',
  today: 'bg-amber-400',
  idle: 'bg-border',
  never: 'border border-border bg-transparent',
};

export function ActiveDot({ at, className }: { at: number | null | undefined; className?: string }) {
  const level = activeLevel(at);
  return (
    <span
      role="img"
      aria-label={activeText(at)}
      title={activeText(at)}
      className={cn('inline-block size-2 shrink-0 rounded-full', DOT[level], level === 'now' && 'ring-2 ring-emerald-500/25', className)}
    />
  );
}

/** "Active now: 4 · Last 24 hours: 12 · Last 7 days: 30" */
export function ActiveSummary({ now, today, week, className }: { now: number; today: number; week: number; className?: string }) {
  return (
    <p className={cn('flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted', className)}>
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-block size-2 rounded-full bg-emerald-500" /> Active now: <b className="font-semibold text-fg tabular-nums">{now}</b>
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-block size-2 rounded-full bg-amber-400" /> Last 24 hours: <b className="font-semibold text-fg tabular-nums">{today}</b>
      </span>
      <span>
        Last 7 days: <b className="font-semibold text-fg tabular-nums">{week}</b>
      </span>
    </p>
  );
}
