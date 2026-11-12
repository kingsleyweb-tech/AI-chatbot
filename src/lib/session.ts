/**
 * Session lifecycle on this device: signing out cleanly, and the website's
 * inactivity timeout.
 *
 * Sign-out (explicit, inactivity, or from another tab) always ends with a
 * full page load of /login: every piece of in-memory state (open chat,
 * drafts, the page the user was on, React Router history state) is gone, so
 * the next sign-in starts fresh on New Chat. Stored data (conversations,
 * projects, memory, files, preferences) lives in Firestore and is untouched.
 *
 * Inactivity (website only, never the installed app):
 * - All tabs share one "last activity" timestamp in localStorage, so there is
 *   one deadline, not one timer per tab. Any tab that sees the deadline pass
 *   signs out and tells the others (BroadcastChannel, with a storage-event
 *   fallback); Firebase's shared persistence signs the other tabs out too.
 * - Only real input counts as activity (pointer, keys, touch, wheel/scroll);
 *   background requests and polling never touch the timestamp.
 * - Returning after the browser was closed or the computer slept past the
 *   deadline signs out at once.
 * - On desktop the installed app and the browser share one sign-in. While an
 *   installed-app window is open (it writes a heartbeat), website tabs do not
 *   sign out for inactivity, because that would sign the app out as well.
 */
import { clearIndexedDbPersistence, terminate } from 'firebase/firestore';
import { signOut as fbSignOut } from 'firebase/auth';
import { api } from './api';
import { auth, db } from './firebase';
import { isInstalledApp, signOutDestination, type SignOutReason } from './idle';

export { APP_HEARTBEAT_MS, IDLE_LIMIT_MS, IDLE_WARN_MS, idleState, isInstalledApp, signOutDestination, type IdleState, type SignOutReason } from './idle';

const LAST_ACTIVITY = 'atlas.lastActivity';
const APP_ALIVE = 'atlas.appAlive';
const LOGOUT_SIGNAL = 'atlas.logout';
const CHANNEL = 'atlas-session';


function num(key: string): number {
  try {
    return Number(localStorage.getItem(key) ?? 0) || 0;
  } catch {
    return 0;
  }
}
function put(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

export const lastActivity = () => num(LAST_ACTIVITY);
export const appAliveAt = () => num(APP_ALIVE);
export function markActivity(now = Date.now()) {
  put(LAST_ACTIVITY, String(now));
}
export function markAppAlive(now = Date.now()) {
  put(APP_ALIVE, String(now));
}

let channel: BroadcastChannel | null = null;
function bus(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  channel ??= new BroadcastChannel(CHANNEL);
  return channel;
}

/** Other tabs signed out: run `cb` once with the reason. Returns an unsubscribe. */
export function onSignOutElsewhere(cb: (reason: 'user' | 'inactivity') => void): () => void {
  const b = bus();
  const onMsg = (e: MessageEvent) => {
    if (e.data?.type === 'signed-out') cb(e.data.reason === 'inactivity' ? 'inactivity' : 'user');
  };
  const onStorage = (e: StorageEvent) => {
    if (e.key === LOGOUT_SIGNAL && e.newValue) cb(e.newValue.startsWith('inactivity') ? 'inactivity' : 'user');
  };
  b?.addEventListener('message', onMsg);
  window.addEventListener('storage', onStorage);
  return () => {
    b?.removeEventListener('message', onMsg);
    window.removeEventListener('storage', onStorage);
  };
}

/** Per-session data on this device: removed at sign-out. Preferences (theme, sidebar) stay. */
function clearSessionStorage() {
  try {
    sessionStorage.clear();
  } catch {
    /* storage unavailable */
  }
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && (k.startsWith('tessera.access.') || k === LAST_ACTIVITY || k === 'atlas.redirect')) localStorage.removeItem(k);
    }
  } catch {
    /* storage unavailable */
  }
}

let signingOut = false;
const endingListeners = new Set<() => void>();

/**
 * True from the moment sign-out starts until the page reloads. The app then shows only a
 * neutral splash, so no page (for example the sign-in page, once Firebase reports the user
 * signed out) touches Firestore while its client is being terminated and its offline copy
 * cleared ("The client has already been terminated").
 */
export function sessionEnding(): boolean {
  return signingOut;
}
export function subscribeSessionEnding(cb: () => void): () => void {
  endingListeners.add(cb);
  return () => endingListeners.delete(cb);
}

/**
 * End the session on this device and open the sign-in page.
 * - In the tab where it happens: tell the server (security log), tell the
 *   other tabs, sign out of Firebase.
 * - `fromOtherTab`: another tab already did that; only clean up here.
 * The offline copy of Firestore data (IndexedDB) is cleared, so nothing
 * private stays readable on a shared computer.
 */
export async function endSession(reason: SignOutReason, fromOtherTab = false): Promise<void> {
  if (signingOut) return;
  signingOut = true;
  for (const cb of endingListeners) cb();
  if (!fromOtherTab && reason !== 'revoked' && reason !== 'device') {
    if (auth.currentUser) {
      // Best effort and short: never keep someone signed in because the network is slow.
      await Promise.race([
        api('account', { json: { action: 'signedOut', reason: reason === 'inactivity' ? 'inactivity' : 'user' } }).catch(() => undefined),
        new Promise((r) => setTimeout(r, 2500)),
      ]);
    }
    bus()?.postMessage({ type: 'signed-out', reason });
    put(LOGOUT_SIGNAL, `${reason}:${Date.now()}`);
  }
  await fbSignOut(auth).catch(() => undefined);
  clearSessionStorage();
  try {
    await terminate(db);
    await clearIndexedDbPersistence(db);
  } catch {
    /* another tab still holds the cache; it clears it when it signs out */
  }
  window.location.replace(signOutDestination(reason, isInstalledApp()));
}

