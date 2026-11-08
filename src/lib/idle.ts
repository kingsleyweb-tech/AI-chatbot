/** Website inactivity rules (pure: no Firebase, no DOM side effects), shared by the guard and the tests. */

export const IDLE_LIMIT_MS = 60 * 60_000;
export const IDLE_WARN_MS = 55 * 60_000;
/** an installed-app window counts as open while its heartbeat is this fresh */
export const APP_HEARTBEAT_MS = 90_000;

/**
 * Installed app: launched from the home screen or app list (display-mode
 * standalone, or the desktop title-bar overlay mode), or iOS home-screen app.
 * Not "fullscreen": a normal browser tab in F11 full screen can match it.
 */
export function isInstalledApp(): boolean {
  if (typeof window === 'undefined') return false;
  const modes = ['standalone', 'window-controls-overlay'];
  return (
    modes.some((m) => window.matchMedia?.(`(display-mode: ${m})`).matches) ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export type IdleState = 'active' | 'warn' | 'expired' | 'exempt';

/** Pure decision used by the guard (and the tests). */
export function idleState(now: number, lastActivity: number, opts: { installedApp: boolean; appAliveAt: number }): IdleState {
  if (opts.installedApp) return 'exempt';
  if (opts.appAliveAt && now - opts.appAliveAt < APP_HEARTBEAT_MS) return 'exempt';
  // No timestamp means storage is unavailable: never sign out in a loop because nothing can be stored.
  if (!lastActivity) return 'active';
  const idle = now - lastActivity;
  if (idle >= IDLE_LIMIT_MS) return 'expired';
  if (idle >= IDLE_WARN_MS) return 'warn';
  return 'active';
}
