import { Gauge, Infinity as InfinityIcon } from 'lucide-react';
import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useUid } from '@/state/auth';
import { useToast } from '@/state/toast';
import {
  clearUsage,
  indicatorText,
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
 * One compact line directly above the composer: the allowance of the feature the next message
 * will use. Fixed height (no layout shift), never inside the composer, so it cannot make the
 * composer taller or cover the keyboard.
 */
export function UsageIndicator({ focus }: { focus?: FeatureId }) {
  const { state, focus: last } = useUsage();
  if (!state) return <div className="h-5" aria-hidden />;
  const id = focus ?? last;
  const view = state.features.find((f) => f.id === id);
  const text = indicatorText(view, state);
  if (!text) return <div className="h-5" aria-hidden />;
  const pct = view?.percent ?? 0;
  const tone = state.unlimited ? 'text-accent' : pct >= 100 ? 'text-danger' : pct >= 90 ? 'text-warn' : 'text-subtle';
  const bar = pct >= 100 ? 'bg-danger' : pct >= 90 ? 'bg-warn' : 'bg-accent';
  return (
    <div className="mx-auto flex h-5 w-full max-w-3xl items-center px-4 sm:px-6">
      <Link
        to="/usage"
        className={cn('flex min-w-0 items-center gap-1.5 text-[11.5px] leading-none hover:text-fg', tone)}
        aria-label={`${text}. Open AI usage`}
        aria-live="polite"
      >
        {state.unlimited ? <InfinityIcon className="size-3.5 shrink-0" /> : <Gauge className="size-3.5 shrink-0" />}
        {!state.unlimited && (
          <span className="h-1 w-10 shrink-0 overflow-hidden rounded-full bg-surface-2" aria-hidden>
            <span className={cn('block h-full rounded-full transition-[width] duration-300', bar)} style={{ width: `${Math.min(100, pct)}%` }} />
          </span>
        )}
        <span className="truncate">{text}</span>
      </Link>
    </div>
  );
}
