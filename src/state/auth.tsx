import { onAuthStateChanged, signOut as fbSignOut, type User } from 'firebase/auth';
import { doc, getDoc, onSnapshot, serverTimestamp, setDoc, updateDoc, FirestoreError } from 'firebase/firestore';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { completeRedirect } from '@/lib/authProviders';
import { auth, db, firebaseConfigured } from '@/lib/firebase';
import { paths } from '@/lib/db';
import { DEFAULT_SETTINGS, type UserProfile } from '@/lib/types';

/** Keep in sync with firestore.rules isBootstrapAdmin() and ADMIN_EMAILS. */
export const BOOTSTRAP_ADMINS = ['kingsleyanaab604@gmail.com'];

/**
 * loading     auth state or access still being determined (never redirect)
 * signed-out  no user
 * phone       email/password account that has not verified a phone number
 * unverified  email address not verified yet
 * denied      not on the approved list
 * error       access or profile could not be checked (retry offered)
 * allowed     full access
 */
export type AccessState = 'loading' | 'signed-out' | 'phone' | 'unverified' | 'denied' | 'allowed' | 'error';

interface AuthCtx {
  user: User | null;
  profile: UserProfile | null;
  access: AccessState;
  admin: boolean;
  /** sign-in method of the current session: password, google.com, apple.com */
  provider: string | null;
  accessError: string | null;
  /** an error from a redirect sign-in that came back to the app */
  signInError: string | null;
  clearSignInError: () => void;
  /** re-read the account (token claims, email verification) and re-check access */
  refreshAccess: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);
const cacheKey = (uid: string) => `tessera.access.${uid}`;

function readCache(uid: string) {
  try {
    return localStorage.getItem(cacheKey(uid));
  } catch {
    return null;
  }
}
function writeCache(uid: string, v: string | null) {
  try {
    if (v) localStorage.setItem(cacheKey(uid), v);
    else localStorage.removeItem(cacheKey(uid));
  } catch {
    /* storage unavailable */
  }
}

const offline = (err: unknown) =>
  (err instanceof FirestoreError && err.code === 'unavailable') || (err as { code?: string })?.code === 'auth/network-request-failed' || !navigator.onLine;

interface Decision {
  state: AccessState;
  admin: boolean;
  provider: string | null;
  error?: string;
}

async function checkAccess(user: User, forceToken: boolean): Promise<Decision> {
  const email = user.email?.toLowerCase() ?? '';
  let provider: string | null = null;
  try {
    const t = await user.getIdTokenResult(forceToken);
    provider = t.signInProvider ?? null;
    // Email/password accounts must verify a phone number (enforced again by the rules and APIs).
    if (provider === 'password' && t.claims.phoneVerified !== true) return { state: 'phone', admin: false, provider };
  } catch (err) {
    if (!offline(err)) return { state: 'error', admin: false, provider, error: 'Could not check your session. Please try again.' };
  }
  if (!user.emailVerified) return { state: 'unverified', admin: false, provider };
  try {
    const snap = await getDoc(doc(db, 'config', 'access'));
    const data = snap.exists() ? (snap.data() as { allowedEmails?: string[]; adminEmails?: string[] }) : {};
    const admins = [...BOOTSTRAP_ADMINS, ...(data.adminEmails ?? [])].map((e) => e.toLowerCase());
    const allowed = (data.allowedEmails ?? []).map((e) => e.toLowerCase());
    const admin = admins.includes(email);
    return { state: admin || allowed.includes(email) ? 'allowed' : 'denied', admin, provider };
  } catch (err) {
    if (err instanceof FirestoreError && err.code === 'permission-denied') return { state: 'denied', admin: false, provider };
    if (offline(err)) {
      // Offline: trust the cached decision so the installed app opens without network.
      const cached = readCache(user.uid);
      if (cached === 'allowed' || cached === 'admin') return { state: 'allowed', admin: cached === 'admin', provider };
    }
    return { state: 'error', admin: false, provider, error: 'We could not reach the server to check your access.' };
  }
}

/**
 * Create the profile on first sign-in; afterwards keep provider, email
 * status and last login current and fill (never overwrite) name and photo.
 * Phone fields and account status are written only by the server.
 */
async function upsertProfile(u: User, provider: string | null) {
  const ref = paths.user(u.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      uid: u.uid,
      email: u.email,
      displayName: u.displayName ?? u.email?.split('@')[0] ?? 'You',
      photoURL: u.photoURL ?? null,
      provider: provider ?? 'unknown',
      emailVerified: u.emailVerified,
      accountCreatedAt: u.metadata.creationTime ?? null,
      lastLoginAt: serverTimestamp(),
      createdAt: serverTimestamp(),
      settings: DEFAULT_SETTINGS,
    });
    return;
  }
  const p = snap.data() as UserProfile;
  await updateDoc(ref, {
    uid: u.uid,
    provider: provider ?? p.provider ?? 'unknown',
    emailVerified: u.emailVerified,
    lastLoginAt: serverTimestamp(),
    ...(!p.displayName && u.displayName ? { displayName: u.displayName } : {}),
    ...(!p.photoURL && u.photoURL ? { photoURL: u.photoURL } : {}),
    ...(!p.accountCreatedAt && u.metadata.creationTime ? { accountCreatedAt: u.metadata.creationTime } : {}),
  });
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [access, setAccess] = useState<AccessState>(firebaseConfigured ? 'loading' : 'error');
  const [admin, setAdmin] = useState(false);
  const [provider, setProvider] = useState<string | null>(null);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [accessError, setAccessError] = useState<string | null>(
    firebaseConfigured ? null : 'Firebase is not configured. Set the VITE_FIREBASE_* environment variables.',
  );
  // Only the latest evaluation may update state (sign-in, refresh and token
  // changes can overlap; a slow, stale check must not overwrite a newer one).
  const seq = useRef(0);
  const redirectDone = useRef<Promise<string | null> | null>(null);

  const evaluate = useCallback(async (u: User | null, forceToken = false) => {
    const mine = ++seq.current;
    if (!u) {
      setAccess('signed-out');
      setAdmin(false);
      setProvider(null);
      setProfile(null);
      return;
    }
    setAccess('loading');
    const r = await checkAccess(u, forceToken);
    if (mine !== seq.current) return;
    setAdmin(r.admin);
    setProvider(r.provider);
    setAccessError(r.error ?? null);
    if (r.state === 'allowed') {
      writeCache(u.uid, r.admin ? 'admin' : 'allowed');
      try {
        await upsertProfile(u, r.provider);
      } catch (err) {
        if (mine !== seq.current) return;
        if (!offline(err)) {
          // Without a profile the app cannot load settings; offer a retry instead of a half-working app.
          setAccessError('Your profile could not be loaded. Please try again.');
          setAccess('error');
          return;
        }
      }
      if (mine !== seq.current) return;
    } else if (r.state !== 'error') {
      writeCache(u.uid, null);
    }
    setAccess(r.state);
  }, []);

  useEffect(() => {
    if (!firebaseConfigured) return;
    // Finish a redirect sign-in first so its errors reach the login page.
    redirectDone.current ??= completeRedirect();
    void redirectDone.current.then((m) => m && setSignInError(m));
    return onAuthStateChanged(auth, (u) => {
      setUser(u);
      void evaluate(u);
    });
  }, [evaluate]);

  // Live profile (settings) subscription once allowed.
  useEffect(() => {
    if (!user || access !== 'allowed') return;
    return onSnapshot(
      paths.user(user.uid),
      (snap) => setProfile(snap.exists() ? (snap.data() as UserProfile) : null),
      () => undefined,
    );
  }, [user, access]);

  const value = useMemo<AuthCtx>(
    () => ({
      user,
      profile,
      access,
      admin,
      provider,
      accessError,
      signInError,
      clearSignInError: () => setSignInError(null),
      refreshAccess: async () => {
        const u = auth.currentUser;
        if (u) await u.reload().catch(() => undefined);
        setUser(auth.currentUser);
        await evaluate(auth.currentUser, true);
      },
      signOut: async () => {
        await fbSignOut(auth);
      },
    }),
    [user, profile, access, admin, provider, accessError, signInError, evaluate],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}

/** Signed-in, allowed user's uid (throws if used outside protected routes). */
export function useUid(): string {
  const { user } = useAuth();
  if (!user) throw new Error('No signed-in user');
  return user.uid;
}
