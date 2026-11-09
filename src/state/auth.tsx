import { onAuthStateChanged, signOut as fbSignOut, type User } from 'firebase/auth';
import { doc, getDoc, onSnapshot, serverTimestamp, setDoc, updateDoc, FirestoreError } from 'firebase/firestore';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ACCOUNT_BLOCK_EVENT, api } from '@/lib/api';
import { completeRedirect, redirectPending } from '@/lib/authProviders';
import { auth, db, firebaseConfigured } from '@/lib/firebase';
import { paths } from '@/lib/db';
import { endSession } from '@/lib/session';
import { DEFAULT_SETTINGS, type UserProfile } from '@/lib/types';

/** Keep in sync with firestore.rules isBootstrapAdmin() and ADMIN_EMAILS. */
export const BOOTSTRAP_ADMINS = ['kingsleyanaab604@gmail.com'];

/**
 * loading     auth state or access still being determined (never redirect)
 * signed-out  no user
 * phone       email/password account that has not verified a phone number
 * unverified  email address not verified yet
 * consent     has not accepted the current Terms of Use and Privacy Policy
 * request     not approved yet and no access request submitted
 * pending     access request waiting for an administrator
 * rejected    an administrator declined access
 * denied      not approved (only when the server could not give details)
 * suspended   suspended by an administrator
 * deleted     scheduled for deletion by an administrator
 * error       access or profile could not be checked (retry offered)
 * allowed     full access
 */
export type AccessState =
  | 'loading'
  | 'signed-out'
  | 'phone'
  | 'unverified'
  | 'consent'
  | 'request'
  | 'pending'
  | 'rejected'
  | 'denied'
  | 'suspended'
  | 'deleted'
  | 'allowed'
  | 'error';

/** The signed-in person's own access request, as the server reports it. */
export interface OwnAccessRequest {
  status: 'pending' | 'approved' | 'rejected';
  fullName: string;
  email: string;
  phoneMasked: string | null;
  phoneVerified: boolean;
  reason: string | null;
  submittedAt: number;
  reviewedAt: number | null;
}
export interface AccessInfo {
  request: OwnAccessRequest | null;
  profile: { displayName: string | null; email: string | null; phoneMasked: string | null; phoneVerified: boolean } | null;
}

interface AuthCtx {
  user: User | null;
  profile: UserProfile | null;
  access: AccessState;
  admin: boolean;
  /** sign-in method of the current session: password, google.com, apple.com */
  provider: string | null;
  accessError: string | null;
  /** access request and profile details for the request / pending screens */
  accessInfo: AccessInfo;
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
  info?: AccessInfo;
  /** the session was revoked (password reset, sign out everywhere): sign out */
  revoked?: boolean;
  /**
   * The server answered and already did the sign-in bookkeeping (profile,
   * login fields, login event). `needsSettings`: the profile has no settings yet.
   */
  server?: { needsSettings: boolean };
}

/**
 * Ask the server why the rules refused this account: the profile of a
 * suspended or deleted account, or of a revoked session, is unreadable.
 */
/** This device was removed from the account in Settings: sign it out and clear its data. */
async function checkDeviceRemoved(): Promise<void> {
  try {
    const s = await api<{ deviceRemoved?: boolean }>('account', { json: { action: 'status' } });
    if (s.deviceRemoved) await endSession('device');
  } catch {
    /* a device_removed error ends the session through the account-block event */
  }
}

async function blockedState(provider: string | null): Promise<Decision | null> {
  try {
    const s = await api<{ accountStatus?: string; sessionRevoked?: boolean }>('account', { json: { action: 'status' } });
    if (s.accountStatus === 'suspended') return { state: 'suspended', admin: false, provider };
    if (s.accountStatus === 'deleted') return { state: 'deleted', admin: false, provider };
    if (s.sessionRevoked) return { state: 'signed-out', admin: false, provider, revoked: true };
  } catch {
    /* fall through to the normal decision */
  }
  return null;
}

interface ServerAccess {
  configured: boolean;
  state?: 'phone' | 'unverified' | 'consent' | 'suspended' | 'deleted' | 'approved' | 'rejected' | 'pending' | 'request' | 'revoked';
  admin?: boolean;
  needsSettings?: boolean;
  request?: OwnAccessRequest | null;
  profile?: AccessInfo['profile'];
}

/**
 * The server decides access (approval, suspension, phone and email checks)
 * and creates the profile of every signed-in person, approved or not.
 * Returns null when the server cannot answer, so the client check below
 * can still let approved users in.
 */
function decisionFrom(r: ServerAccess, provider: string | null): Decision | null {
  if (!r.configured || !r.state) return null;
  const info: AccessInfo = { request: r.request ?? null, profile: r.profile ?? null };
  const admin = Boolean(r.admin);
  switch (r.state) {
    case 'approved':
      return { state: 'allowed', admin, provider, info, server: { needsSettings: Boolean(r.needsSettings) } };
    case 'revoked':
      return { state: 'signed-out', admin: false, provider, revoked: true };
    default:
      return { state: r.state, admin: false, provider, info };
  }
}

async function serverAccess(provider: string | null): Promise<Decision | null> {
  try {
    const r = await api<ServerAccess>('account', { json: { action: 'access', name: auth.currentUser?.displayName ?? undefined } });
    return decisionFrom(r, provider);
  } catch {
    return null;
  }
}

/**
 * Accept the current Terms of Use and Privacy Policy. The server records it
 * (with its own time) and answers with the new access decision.
 */
export async function acceptTermsOnServer(termsVersion: string, privacyVersion: string): Promise<void> {
  await api('account', { json: { action: 'acceptTerms', termsVersion, privacyVersion, name: auth.currentUser?.displayName ?? undefined } });
}

async function checkAccess(user: User, forceToken: boolean): Promise<Decision> {
  const email = user.email?.toLowerCase() ?? '';
  let provider: string | null = null;
  try {
    const t = await user.getIdTokenResult(forceToken);
    provider = t.signInProvider ?? null;
    // Email/password accounts must verify a phone number (enforced again by the rules and APIs).
    if (provider === 'password' && t.claims.phoneVerified !== true) {
      // still store the new account, so administrators can see it
      void api('account', { json: { action: 'access', name: user.displayName ?? undefined } }).catch(() => undefined);
      return { state: 'phone', admin: false, provider };
    }
  } catch (err) {
    // A disabled account cannot refresh its token: suspended or scheduled for deletion.
    if ((err as { code?: string })?.code === 'auth/user-disabled') return { state: 'suspended', admin: false, provider };
    if ((err as { code?: string })?.code === 'auth/user-token-expired') return { state: 'signed-out', admin: false, provider, revoked: true };
    if (!offline(err)) return { state: 'error', admin: false, provider, error: 'Could not check your session. Please try again.' };
  }
  if (!user.emailVerified) return { state: 'unverified', admin: false, provider };
  if (navigator.onLine) {
    const decided = await serverAccess(provider);
    if (decided) return decided;
  }
  try {
    const snap = await getDoc(doc(db, 'config', 'access'));
    const data = snap.exists() ? (snap.data() as { allowedEmails?: string[]; adminEmails?: string[] }) : {};
    const admins = [...BOOTSTRAP_ADMINS, ...(data.adminEmails ?? [])].map((e) => e.toLowerCase());
    const allowed = (data.allowedEmails ?? []).map((e) => e.toLowerCase());
    const admin = admins.includes(email);
    return { state: admin || allowed.includes(email) ? 'allowed' : 'denied', admin, provider };
  } catch (err) {
    if (err instanceof FirestoreError && err.code === 'permission-denied') return (await blockedState(provider)) ?? { state: 'denied', admin: false, provider };
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
async function upsertProfile(u: User, provider: string | null, server?: { needsSettings: boolean }) {
  const ref = paths.user(u.uid);
  // The server already created the profile and updated the login fields: only the
  // settings the browser owns are missing on a profile created before approval.
  if (server) {
    if (server.needsSettings) await updateDoc(ref, { settings: DEFAULT_SETTINGS });
    return;
  }
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
    // profiles created by the server before approval have no settings yet
    ...(!p.settings ? { settings: DEFAULT_SETTINGS } : {}),
    ...(!p.createdAt ? { createdAt: serverTimestamp() } : {}),
  });
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [access, setAccess] = useState<AccessState>(firebaseConfigured ? 'loading' : 'error');
  const [admin, setAdmin] = useState(false);
  const [provider, setProvider] = useState<string | null>(null);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [accessInfo, setAccessInfo] = useState<AccessInfo>({ request: null, profile: null });
  const [accessError, setAccessError] = useState<string | null>(
    firebaseConfigured ? null : 'Firebase is not configured. Set the VITE_FIREBASE_* environment variables.',
  );
  // Only the latest evaluation may update state (sign-in, refresh and token
  // changes can overlap; a slow, stale check must not overwrite a newer one).
  const seq = useRef(0);
  const redirectDone = useRef<Promise<string | null> | null>(null);

  /**
   * Decide access for `u`.
   * - quiet: keep showing the current screen while re-checking (no loading
   *   flash; used by "Refresh status" and other in-page re-checks).
   * - On a normal start, a user the server approved before opens the app at
   *   once from the cached decision while the check runs in the background.
   *   The rules and APIs enforce access on every request regardless, and a
   *   negative answer replaces the optimistic state as soon as it arrives.
   */
  const evaluate = useCallback(async (u: User | null, forceToken = false, quiet = false) => {
    const mine = ++seq.current;
    if (!u) {
      // Coming back from a Google redirect: stay on the loading screen until
      // Firebase has finished processing the result (it then reports the user).
      if (redirectPending() && redirectDone.current) {
        const m = await redirectDone.current;
        if (mine !== seq.current) return;
        if (!m && auth.currentUser) return; // the listener fires again with the user
      }
      setAccess('signed-out');
      setAdmin(false);
      setProvider(null);
      setProfile(null);
      return;
    }
    const cached = !forceToken && !quiet ? readCache(u.uid) : null;
    const optimistic = cached === 'allowed' || cached === 'admin';
    if (optimistic) {
      setAdmin(cached === 'admin');
      setAccess('allowed');
    } else if (!quiet) {
      setAccess('loading');
    }
    let r = await checkAccess(u, forceToken);
    if (mine !== seq.current) return;
    // A transient failure must not throw an approved user out of the open app.
    if (optimistic && r.state === 'error') r = { state: 'allowed', admin: cached === 'admin', provider: r.provider };
    if (r.revoked) {
      writeCache(u.uid, null);
      setSignInError('You were signed out because your password was changed or all sessions were signed out. Please sign in again.');
      await fbSignOut(auth).catch(() => undefined);
      return;
    }
    if (r.state === 'allowed') {
      writeCache(u.uid, r.admin ? 'admin' : 'allowed');
      try {
        await upsertProfile(u, r.provider, r.server);
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
      // one login event per sign-in session (deduplicated on the server); the access call already did it
      if (!r.server) void api('account', { json: { action: 'session' } }).catch(() => undefined);
    } else if (r.state !== 'error') {
      writeCache(u.uid, null);
    }
    // Update everything together, after the profile write: a quiet re-check must
    // never render the old state with new details (the request form flashed).
    setAdmin(r.admin);
    setProvider(r.provider);
    setAccessError(r.error ?? null);
    setAccessInfo(r.info ?? { request: null, profile: null });
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

  // An API call reported a suspended/deleted account or a revoked session: re-check now.
  useEffect(() => {
    const onBlocked = (e: Event) => {
      if ((e as CustomEvent<string>).detail === 'device_removed') {
        void endSession('device');
        return;
      }
      if (auth.currentUser) void evaluate(auth.currentUser, true);
    };
    window.addEventListener(ACCOUNT_BLOCK_EVENT, onBlocked);
    return () => window.removeEventListener(ACCOUNT_BLOCK_EVENT, onBlocked);
  }, [evaluate]);

  // Live profile (settings) subscription once allowed.
  useEffect(() => {
    if (!user || access !== 'allowed') return;
    let authTime = 0;
    void user
      .getIdTokenResult()
      .then((t) => (authTime = Date.parse(t.authTime) / 1000))
      .catch(() => undefined);
    let rechecking = false;
    // "Sign out of all devices", suspension and deletion all update this
    // document; react at once instead of waiting for the next request.
    const recheck = () => {
      if (rechecking || !auth.currentUser) return;
      rechecking = true;
      void evaluate(auth.currentUser, true, true).finally(() => (rechecking = false));
    };
    // A device was removed in Settings after this session started: ask the
    // server whether it is this one (only the server knows the device keys).
    let deviceChecked = 0;
    const checkDevice = (latest: number) => {
      if (latest <= deviceChecked) return;
      deviceChecked = latest;
      void checkDeviceRemoved();
    };
    return onSnapshot(
      paths.user(user.uid),
      (snap) => {
        const p = snap.exists()
          ? (snap.data() as UserProfile & { sessionsValidAfter?: number; accountStatus?: string; removedDevices?: Record<string, number> })
          : null;
        setProfile(p);
        if (!p) return;
        const latestRemoval = Math.max(0, ...Object.values(p.removedDevices ?? {}).filter((t) => typeof t === 'number'));
        if (latestRemoval && latestRemoval >= authTime) checkDevice(latestRemoval);
        if ((p.accountStatus && p.accountStatus !== 'active') || (authTime && (p.sessionsValidAfter ?? 0) > authTime)) recheck();
      },
      // The rules refuse the profile once the session is revoked or the account is blocked.
      (err) => {
        if (err.code === 'permission-denied') recheck();
      },
    );
  }, [user, access, evaluate]);

  const value = useMemo<AuthCtx>(
    () => ({
      user,
      profile,
      access,
      admin,
      provider,
      accessError,
      accessInfo,
      signInError,
      clearSignInError: () => setSignInError(null),
      refreshAccess: async () => {
        const u = auth.currentUser;
        if (u) await u.reload().catch(() => undefined);
        setUser(auth.currentUser);
        await evaluate(auth.currentUser, true, true);
      },
      // Full sign-out: security log, other tabs, Firebase, local session data, then a fresh /login.
      signOut: () => endSession('user'),
    }),
    [user, profile, access, admin, provider, accessError, accessInfo, signInError, evaluate],
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
