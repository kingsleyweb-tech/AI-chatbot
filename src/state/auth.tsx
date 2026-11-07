import {
  onAuthStateChanged,
  signOut as fbSignOut,
  type User,
} from 'firebase/auth';
import { doc, getDoc, onSnapshot, serverTimestamp, setDoc, FirestoreError } from 'firebase/firestore';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { auth, db, firebaseConfigured } from '@/lib/firebase';
import { paths } from '@/lib/db';
import { DEFAULT_SETTINGS, type UserProfile } from '@/lib/types';

/** Keep in sync with firestore.rules isBootstrapAdmin() and ADMIN_EMAILS. */
export const BOOTSTRAP_ADMINS = ['kingsleyanaab604@gmail.com'];

export type AccessState = 'loading' | 'signed-out' | 'unverified' | 'denied' | 'allowed' | 'error';

interface AuthCtx {
  user: User | null;
  profile: UserProfile | null;
  access: AccessState;
  admin: boolean;
  accessError: string | null;
  refreshAccess: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

async function checkAccess(user: User): Promise<{ state: AccessState; admin: boolean; error?: string }> {
  const email = user.email?.toLowerCase() ?? '';
  if (!user.emailVerified) return { state: 'unverified', admin: false };
  try {
    const snap = await getDoc(doc(db, 'config', 'access'));
    const data = snap.exists() ? (snap.data() as { allowedEmails?: string[]; adminEmails?: string[] }) : {};
    const admins = [...BOOTSTRAP_ADMINS, ...(data.adminEmails ?? [])].map((e) => e.toLowerCase());
    const allowed = (data.allowedEmails ?? []).map((e) => e.toLowerCase());
    const admin = admins.includes(email);
    return { state: admin || allowed.includes(email) ? 'allowed' : 'denied', admin };
  } catch (err) {
    if (err instanceof FirestoreError && err.code === 'permission-denied') return { state: 'denied', admin: false };
    if (err instanceof FirestoreError && err.code === 'unavailable') {
      // Offline: trust the cached decision so the PWA opens without network.
      const cached = localStorage.getItem(`tessera.access.${user.uid}`);
      if (cached === 'allowed' || cached === 'admin') return { state: 'allowed', admin: cached === 'admin' };
    }
    return { state: 'error', admin: false, error: err instanceof Error ? err.message : 'Could not verify access.' };
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [access, setAccess] = useState<AccessState>(firebaseConfigured ? 'loading' : 'error');
  const [admin, setAdmin] = useState(false);
  const [accessError, setAccessError] = useState<string | null>(
    firebaseConfigured ? null : 'Firebase is not configured. Set the VITE_FIREBASE_* environment variables.',
  );

  const evaluate = useCallback(async (u: User | null) => {
    if (!u) {
      setAccess('signed-out');
      setAdmin(false);
      setProfile(null);
      return;
    }
    const r = await checkAccess(u);
    setAdmin(r.admin);
    setAccessError(r.error ?? null);
    if (r.state === 'allowed') {
      try {
        localStorage.setItem(`tessera.access.${u.uid}`, r.admin ? 'admin' : 'allowed');
      } catch {
        /* ignore */
      }
      // Ensure a profile document exists.
      try {
        const ref = paths.user(u.uid);
        const snap = await getDoc(ref);
        if (!snap.exists()) {
          await setDoc(ref, {
            email: u.email,
            displayName: u.displayName ?? u.email?.split('@')[0] ?? 'You',
            photoURL: u.photoURL ?? null,
            createdAt: serverTimestamp(),
            settings: DEFAULT_SETTINGS,
          });
        }
      } catch {
        /* offline: profile will sync later */
      }
    }
    setAccess(r.state);
  }, []);

  useEffect(() => {
    if (!firebaseConfigured) return;
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
      accessError,
      refreshAccess: async () => {
        if (auth.currentUser) await auth.currentUser.reload();
        setUser(auth.currentUser);
        await evaluate(auth.currentUser);
      },
      signOut: async () => {
        await fbSignOut(auth);
      },
    }),
    [user, profile, access, admin, accessError, evaluate],
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
