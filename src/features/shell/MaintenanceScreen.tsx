import { useCallback, useEffect, useRef, useState } from 'react';
import { LogoMark } from '@/components/Logo';
import { useAuth } from '@/state/auth';

const COOLDOWN = 5;
const AUTO_CHECK_MS = 60_000;

/**
 * Shown to signed-in users instead of the app while an administrator has maintenance mode on.
 * The public website stays available. "Try again" re-checks with the server (at most every few
 * seconds) and the page also re-checks by itself every minute, so it opens the app as soon as
 * maintenance ends.
 */
export function MaintenanceScreen() {
  const { maintenance, refreshAccess, signOut } = useAuth();
  const [wait, setWait] = useState(COOLDOWN);
  const [checking, setChecking] = useState(false);
  const busy = useRef(false);

  const check = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setChecking(true);
    try {
      await refreshAccess();
    } finally {
      busy.current = false;
      setChecking(false);
      setWait(COOLDOWN);
    }
  }, [refreshAccess]);

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  useEffect(() => {
    const t = setInterval(() => void check(), AUTO_CHECK_MS);
    return () => clearInterval(t);
  }, [check]);

  useEffect(() => {
    const prev = document.title;
    document.title = 'Atlas AI is temporarily unavailable';
    return () => {
      document.title = prev;
    };
  }, []);

  const title = maintenance?.title ?? 'Atlas AI is temporarily unavailable';
  const message = maintenance?.message ?? 'We’re carrying out maintenance. Please try again in a moment.';

  return (
    <main className="flex min-h-dvh items-center justify-center bg-bg px-6 py-16 text-fg">
      <div className="w-full max-w-md text-center" role="alert" aria-live="polite">
        <div className="mb-8 inline-flex items-center gap-2.5">
          <LogoMark className="size-9" />
          <span className="text-[26px] font-semibold tracking-tight">
            Atlas <span className="text-accent">AI</span>
          </span>
        </div>
        <h1 className="text-[22px] font-semibold tracking-tight text-balance sm:text-2xl">{title}</h1>
        <p className="mt-3 text-[15px] leading-relaxed whitespace-pre-line text-muted">{message}</p>
        <div className="mt-8 flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => void check()}
            disabled={wait > 0 || checking}
            className="rounded-lg border border-border bg-surface px-4 py-2 text-sm font-medium transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {checking ? 'Checking…' : wait > 0 ? `Try again in ${wait}s` : 'Try again'}
          </button>
          <button
            type="button"
            onClick={() => void signOut()}
            className="rounded-lg border border-border bg-surface px-4 py-2 text-sm font-medium transition-colors hover:bg-surface-2"
          >
            Log out
          </button>
        </div>
        <p className="mt-10 text-xs text-muted">
          Your chats and settings are safe.{' '}
          <a href="/status" className="underline hover:text-fg">
            Service status
          </a>
        </p>
      </div>
    </main>
  );
}
