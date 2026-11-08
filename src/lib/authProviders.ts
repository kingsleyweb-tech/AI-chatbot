import { getRedirectResult, GoogleAuthProvider, signInWithPopup, signInWithRedirect, type AuthProvider } from 'firebase/auth';
import { auth } from './firebase';
import { isStandalone } from './utils';

/** Sign in with Apple was removed from the app; Google is the only social provider. */
export type SocialProvider = 'google';

function provider(): AuthProvider {
  const p = new GoogleAuthProvider();
  p.setCustomParameters({ prompt: 'select_account' });
  return p;
}

/** Error codes that mean the user simply backed out: no message is shown. */
const CANCELLED = new Set(['auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/user-cancelled', 'auth/redirect-cancelled-by-user']);
/** Popup cannot work here: fall back to a full-page redirect. */
const NEEDS_REDIRECT = new Set(['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment']);

export function authErrorMessage(err: unknown, id?: SocialProvider): string {
  const code = (err as { code?: string })?.code ?? '';
  const name = id === 'google' ? 'Google' : 'this provider';
  const map: Record<string, string> = {
    'auth/invalid-credential': 'Incorrect email or password.',
    'auth/invalid-email': 'Enter a valid email address.',
    'auth/user-disabled': 'This account is suspended or scheduled for deletion. Contact the administrator if you think this is a mistake.',
    'auth/user-not-found': 'Incorrect email or password.',
    'auth/wrong-password': 'Incorrect email or password.',
    'auth/email-already-in-use': 'An account with this email already exists. Sign in instead.',
    'auth/weak-password': 'Use at least 8 characters for your password.',
    'auth/too-many-requests': 'Too many attempts. Please wait a few minutes and try again.',
    'auth/network-request-failed': 'Network error. Check your connection and try again.',
    'auth/account-exists-with-different-credential':
      'An account already exists with this email but a different sign-in method. Sign in the way you did before.',
    'auth/credential-already-in-use': 'This sign-in is already linked to another account.',
    'auth/operation-not-allowed': `Sign in with ${name} is not set up yet.`,
    'auth/invalid-oauth-client-id': `Sign in with ${name} is not set up correctly yet.`,
    'auth/unauthorized-domain': 'This web address is not authorized for sign-in yet. Add it under Firebase Authentication > Settings > Authorized domains.',
    'auth/configuration-not-found': 'Firebase Authentication is not set up for this project yet.',
    'auth/web-storage-unsupported': 'Your browser is blocking storage that sign-in needs. Allow cookies for this site and try again.',
    'auth/internal-error': `Sign in with ${name} failed. Please try again.`,
  };
  if (map[code]) return map[code];
  if (/code flow is not enabled|OPERATION_NOT_ALLOWED/i.test(String((err as Error)?.message))) return `Sign in with ${name} is not set up yet.`;
  return `Something went wrong (${code || 'unknown error'}). Please try again.`;
}

let inFlight = false;

/**
 * Marks a full-page Google redirect in progress, so the app shows
 * "Signing you in" (not the sign-in form) when it reloads, and can tell the
 * user when the result never arrived. Expires after 10 minutes.
 */
const REDIRECT_KEY = 'atlas.redirect';
function markRedirect(on: boolean) {
  try {
    if (on) localStorage.setItem(REDIRECT_KEY, String(Date.now()));
    else localStorage.removeItem(REDIRECT_KEY);
  } catch {
    /* storage unavailable */
  }
}
export function redirectPending(): boolean {
  try {
    const at = Number(localStorage.getItem(REDIRECT_KEY) ?? 0);
    return at > 0 && Date.now() - at < 10 * 60_000;
  } catch {
    return false;
  }
}

async function redirect(p: AuthProvider) {
  markRedirect(true);
  try {
    await signInWithRedirect(auth, p);
  } catch (err) {
    markRedirect(false);
    throw err;
  }
}

/**
 * Sign in with Google. Uses a popup in the browser and a full-page
 * redirect in installed apps (where popups open outside the app and their
 * result can be lost) or when the popup is blocked. The auth state listener
 * is the single source of truth for what happens next.
 *
 * Returns 'cancelled' when the user closed the window, 'redirect' when the
 * page is navigating away.
 */
export async function signInWithProvider(_id: SocialProvider = 'google'): Promise<'done' | 'cancelled' | 'redirect' | 'busy'> {
  if (inFlight) return 'busy';
  inFlight = true;
  const p = provider();
  try {
    if (isStandalone()) {
      await redirect(p);
      return 'redirect';
    }
    try {
      await signInWithPopup(auth, p);
      return 'done';
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      if (CANCELLED.has(code)) return 'cancelled';
      if (NEEDS_REDIRECT.has(code)) {
        await redirect(p);
        return 'redirect';
      }
      throw err;
    }
  } finally {
    inFlight = false;
  }
}

/**
 * Complete a redirect sign-in after the page reloads. Must run once at
 * start-up, or redirect errors are silently lost.
 */
export async function completeRedirect(): Promise<string | null> {
  const pending = redirectPending();
  try {
    const result = await getRedirectResult(auth);
    markRedirect(false);
    // Came back from Google but no session arrived: say so instead of
    // silently showing the sign-in form again.
    if (pending && !result && !auth.currentUser) {
      return 'Google sign-in did not finish. Please try again. If this keeps happening in the installed app, open Atlas AI in your browser once and sign in there.';
    }
    return null;
  } catch (err) {
    markRedirect(false);
    const code = (err as { code?: string }).code ?? '';
    if (CANCELLED.has(code) || code === 'auth/no-auth-event') return null;
    return authErrorMessage(err);
  }
}
