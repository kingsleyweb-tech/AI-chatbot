import {
  getAdditionalUserInfo,
  getRedirectResult,
  GoogleAuthProvider,
  OAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  updateProfile,
  type AuthProvider,
  type UserCredential,
} from 'firebase/auth';
import { auth } from './firebase';
import { isStandalone } from './utils';

export type SocialProvider = 'google' | 'apple';

function provider(id: SocialProvider): AuthProvider {
  if (id === 'google') {
    const p = new GoogleAuthProvider();
    p.setCustomParameters({ prompt: 'select_account' });
    return p;
  }
  const p = new OAuthProvider('apple.com');
  p.addScope('email');
  p.addScope('name');
  return p;
}

/** Error codes that mean the user simply backed out: no message is shown. */
const CANCELLED = new Set(['auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/user-cancelled', 'auth/redirect-cancelled-by-user']);
/** Popup cannot work here: fall back to a full-page redirect. */
const NEEDS_REDIRECT = new Set(['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment']);

export function authErrorMessage(err: unknown, id?: SocialProvider): string {
  const code = (err as { code?: string })?.code ?? '';
  const name = id === 'apple' ? 'Apple' : id === 'google' ? 'Google' : 'this provider';
  const map: Record<string, string> = {
    'auth/invalid-credential': 'Incorrect email or password.',
    'auth/invalid-email': 'Enter a valid email address.',
    'auth/user-disabled': 'This account has been disabled.',
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
  // Apple returns this while the Service ID / key is missing in Firebase.
  if (/code flow is not enabled|OPERATION_NOT_ALLOWED/i.test(String((err as Error)?.message))) return `Sign in with ${name} is not set up yet.`;
  return `Something went wrong (${code || 'unknown error'}). Please try again.`;
}

/**
 * Apple shares the user's name only on the very first sign-in and Firebase
 * does not store it, so copy it onto the account when present.
 */
async function keepAppleName(cred: UserCredential | null) {
  if (!cred || cred.user.displayName) return;
  const info = getAdditionalUserInfo(cred);
  if (info?.providerId !== 'apple.com') return;
  const p = (info.profile ?? {}) as { name?: { firstName?: string; lastName?: string } | string; firstName?: string; lastName?: string };
  const n = typeof p.name === 'object' ? p.name : p;
  const full = typeof p.name === 'string' ? p.name : [n?.firstName, n?.lastName].filter(Boolean).join(' ');
  if (full) await updateProfile(cred.user, { displayName: full }).catch(() => undefined);
}

let inFlight = false;

/**
 * Sign in with Google or Apple. Uses a popup in the browser and a full-page
 * redirect in installed apps (where popups open outside the app and their
 * result can be lost) or when the popup is blocked. The auth state listener
 * is the single source of truth for what happens next.
 *
 * Returns 'cancelled' when the user closed the window, 'redirect' when the
 * page is navigating away.
 */
export async function signInWithProvider(id: SocialProvider): Promise<'done' | 'cancelled' | 'redirect' | 'busy'> {
  if (inFlight) return 'busy';
  inFlight = true;
  const p = provider(id);
  try {
    if (isStandalone()) {
      await signInWithRedirect(auth, p);
      return 'redirect';
    }
    try {
      await keepAppleName(await signInWithPopup(auth, p));
      return 'done';
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      if (CANCELLED.has(code)) return 'cancelled';
      if (NEEDS_REDIRECT.has(code)) {
        await signInWithRedirect(auth, p);
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
 * start-up, or redirect errors (and Apple's one-time name) are silently lost.
 */
export async function completeRedirect(): Promise<string | null> {
  try {
    await keepAppleName(await getRedirectResult(auth));
    return null;
  } catch (err) {
    const code = (err as { code?: string }).code ?? '';
    if (CANCELLED.has(code) || code === 'auth/no-auth-event') return null;
    return authErrorMessage(err);
  }
}
