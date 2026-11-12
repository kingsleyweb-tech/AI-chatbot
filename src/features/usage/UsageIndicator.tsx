import { Gauge } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useUid } from '@/state/auth';
import { useToast } from '@/state/toast';
import {
  clearUsage,
  indicatorView,
  refreshUsage,
  setUsageFetcher,
  setUsageWarner,
  useUsage,
  type FeatureId,
  type UsageState,
} from './usage';

/**
 * Loads the allowances once the workspace opens and keeps them fresh (when the app comes back
 * to the foreground). Shows the 75/90/99/100% warnings as small notifications: they never
 * block or interrupt a reply, and each is shown once per period.
 */
export function UsageBridge() {
  const uid = useUid();
  const toast = useToast();
  useEffect(() => {
    setUsageFetcher(() => api<UsageState>('chat?usage'));
    setUsageWarner((message, threshold) => toast(message, threshold >= 100 ? 'error' : 'info'));
    void refreshUsage(true);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshUsage();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      setUsageWarner(null);
      clearUsage();
    };
  }, [uid, toast]);
  return null;
}

/**
 * One compact line directly above the composer, only once the feature the next message will use
 * has used 75% of its allowance. Below that (and for unlimited access) nothing is shown and no
 * space is kept. Never inside the composer, so it cannot make the composer taller.
 */
export function UsageIndicator({ focus }: { focus?: FeatureId }) {
  const { state, focus: last } = useUsage();
  // automatic Advanced Reasoning falls back to chat when its allowance is used up, so the
  // line follows chat unless the composer is set to a specific feature
  const id = focus ?? (last && last !== 'reasoning' ? last : 'chat');
  const view = state?.features.find((f) => f.id === id);
  const shown = state ? indicatorView(view, state) : null;
  const resetsAt = shown && view?.binding ? view[view.binding].resetsAt : null;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!resetsAt) return;
    // hide the line the moment the period resets, then fetch the new figures
    const t = setTimeout(() => {
      tick((n) => n + 1);
      void refreshUsage(true);
    }, Math.max(0, Math.min(resetsAt - Date.now() + 1_000, 2 ** 31 - 1)));
    return () => clearTimeout(t);
  }, [resetsAt]);
  if (!shown) return null;
  const tone = shown.level >= 100 ? 'text-danger' : shown.level >= 90 ? 'text-warn' : 'text-subtle';
  const bar = shown.level >= 100 ? 'bg-danger' : shown.level >= 90 ? 'bg-warn' : 'bg-accent';
  return (
    <div className="mx-auto flex h-5 w-full max-w-3xl items-center px-4 sm:px-6">
      <Link
        to="/usage"
        className={cn('flex min-w-0 items-center gap-1.5 text-[11.5px] leading-none hover:text-fg', tone)}
        aria-label={`${shown.text} Open AI usage`}
        aria-live="polite"
      >
        <Gauge className="size-3.5 shrink-0" />
        <span className="h-1 w-10 shrink-0 overflow-hidden rounded-full bg-surface-2" aria-hidden>
          <span className={cn('block h-full rounded-full transition-[width] duration-300', bar)} style={{ width: `${Math.min(100, shown.percent)}%` }} />
        </span>
        <span className="truncate">{shown.text}</span>
      </Link>
    </div>
  );
}
