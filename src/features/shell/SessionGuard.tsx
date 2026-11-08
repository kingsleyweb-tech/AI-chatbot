import { Clock } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Dialog } from '@/components/ui';
import {
  appAliveAt,
  endSession,
  idleState,
  IDLE_LIMIT_MS,
  isInstalledApp,
  lastActivity,
  markActivity,
  markAppAlive,
  onSignOutElsewhere,
} from '@/lib/session';
import { useAuth } from '@/state/auth';
import { mmss } from '../auth/otpUi';

/** Input that counts as the person being present. Network activity never does. */
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;
/** write the shared timestamp at most this often (cheap, and still precise to the minute) */
const WRITE_EVERY_MS = 10_000;

/**
 * Mounted once for any signed-in person. Website: one-hour inactivity
 * sign-out with a warning at 55 minutes. Installed app: no inactivity
 * sign-out (it only reports that it is open). Both: follow sign-outs from
 * other tabs and windows.
 */
export function SessionGuard() {
  const { user } = useAuth();
  const installed = useRef(isInstalledApp()).current;
  const [warn, setWarn] = useState(false);
  const [left, setLeft] = useState(0);
  const warnRef = useRef(false);
  const lastWrite = useRef(0);

  // Another tab or window signed out: this one ends too (full reload clears its state).
  useEffect(() => onSignOutElsewhere((reason) => void endSession(reason, true)), []);

  // Installed app: heartbeat so website tabs on the same device do not sign the shared session out.
  useEffect(() => {
    if (!installed || !user) return;
    markAppAlive();
    const t = setInterval(markAppAlive, 30_000);
    const onVisible = () => document.visibilityState === 'visible' && markAppAlive();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [installed, user]);

  const check = useCallback(() => {
    const now = Date.now();
    const s = idleState(now, lastActivity(), { installedApp: installed, appAliveAt: appAliveAt() });
    if (s === 'expired') {
      void endSession('inactivity');
      return;
    }
    const w = s === 'warn';
    warnRef.current = w;
    setWarn(w);
    if (w) setLeft(Math.max(0, Math.ceil((lastActivity() + IDLE_LIMIT_MS - now) / 1000)));
  }, [installed]);

  // Website inactivity timer.
  useEffect(() => {
    if (installed || !user) return;
    // A sign-in that just happened starts a new idle period; a restored session keeps the old one
    // (closing the browser for two hours and coming back must not reset the clock).
    const signedInAt = Date.parse(user.metadata.lastSignInTime ?? '') || 0;
    if (!lastActivity() || signedInAt > lastActivity()) markActivity(Math.max(Date.now() - 1000, signedInAt));
    check();

    const onActivity = () => {
      if (warnRef.current) return; // during the warning only "Stay signed in" counts
      const now = Date.now();
      if (now - lastWrite.current < WRITE_EVERY_MS) return;
      lastWrite.current = now;
      markActivity(now);
    };
    for (const e of ACTIVITY_EVENTS) window.addEventListener(e, onActivity, { passive: true, capture: true });
    const onStorage = (e: StorageEvent) => e.key === 'atlas.lastActivity' && check();
    const onWake = () => document.visibilityState === 'visible' && check();
    window.addEventListener('storage', onStorage);
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    const t = setInterval(check, 1000);
    return () => {
      for (const e of ACTIVITY_EVENTS) window.removeEventListener(e, onActivity, { capture: true });
      window.removeEventListener('storage', onStorage);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
      clearInterval(t);
    };
  }, [installed, user, check]);

  const stay = () => {
    markActivity();
    lastWrite.current = Date.now();
    check();
  };

  if (installed || !warn) return null;
  return (
    <Dialog
      open
      onClose={stay}
      size="sm"
      title={
        <span className="inline-flex items-center gap-2">
          <Clock className="size-5 text-warn" /> Still there?
        </span>
      }
      footer={
        <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={() => void endSession('user')}>
            Sign out now
          </Button>
          <Button variant="primary" onClick={stay} autoFocus>
            Stay signed in
          </Button>
        </div>
      }
    >
      <p className="text-sm text-muted" role="alert" aria-live="assertive">
        Your session is about to expire due to inactivity. You will be signed out in{' '}
        <b className="font-semibold tabular-nums text-fg">{mmss(left)}</b>.
      </p>
    </Dialog>
  );
}
