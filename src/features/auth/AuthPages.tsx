import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  updateProfile,
} from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { ArrowLeft, Mail, ShieldAlert } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Logo } from '@/components/Logo';
import { Button, Input, Label } from '@/components/ui';
import { auth, db } from '@/lib/firebase';
import { isIOS, isStandalone } from '@/lib/utils';
import { useAuth } from '@/state/auth';

type Mode = 'login' | 'register' | 'reset' | 'verify' | 'denied';

function friendlyAuthError(err: unknown): string {
  const code = (err as { code?: string })?.code ?? '';
  const map: Record<string, string> = {
    'auth/invalid-credential': 'Incorrect email or password.',
    'auth/invalid-email': 'Enter a valid email address.',
    'auth/user-disabled': 'This account has been disabled.',
    'auth/user-not-found': 'Incorrect email or password.',
    'auth/wrong-password': 'Incorrect email or password.',
    'auth/email-already-in-use': 'An account with this email already exists. Try signing in.',
    'auth/weak-password': 'Use at least 8 characters for your password.',
    'auth/too-many-requests': 'Too many attempts. Please wait a few minutes and try again.',
    'auth/network-request-failed': 'Network error. Check your connection.',
    'auth/popup-closed-by-user': 'The Google sign-in window was closed.',
    'auth/operation-not-allowed': 'This sign-in method is not enabled in Firebase yet.',
    'auth/unauthorized-domain': 'This domain is not authorized for sign-in in Firebase.',
    'auth/configuration-not-found': 'Firebase Authentication is not set up for this project yet.',
  };
  return map[code] ?? (err instanceof Error ? err.message.replace(/^Firebase: /, '') : 'Something went wrong.');
}

function Shell({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="scroll-thin touch-scroll flex h-full flex-col overflow-y-auto bg-bg pt-safe pb-safe">
      <div className="flex flex-1 flex-col items-center justify-center px-5 py-10">
        <div className="w-full max-w-[380px]">
          <div className="mb-8 flex justify-center">
            <Logo />
          </div>
          {children}
        </div>
      </div>
      {footer && <div className="pb-6 text-center text-xs text-subtle">{footer}</div>}
    </div>
  );
}

function GoogleButton({ onError }: { onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="outline"
      size="lg"
      className="w-full"
      loading={busy}
      onClick={async () => {
        setBusy(true);
        const provider = new GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        try {
          // Popups are unreliable in iOS home-screen apps; use a redirect there.
          if (isStandalone() && isIOS()) await signInWithRedirect(auth, provider);
          else await signInWithPopup(auth, provider);
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code === 'auth/popup-blocked') {
            await signInWithRedirect(auth, provider).catch((e) => onError(friendlyAuthError(e)));
          } else if (code !== 'auth/cancelled-popup-request') {
            onError(friendlyAuthError(err));
          }
        } finally {
          setBusy(false);
        }
      }}
      icon={
        <svg viewBox="0 0 24 24" className="size-[18px]" aria-hidden="true">
          <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.2-2.1 3.5-5.1 3.5-8.7z" />
          <path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24z" />
          <path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6h-4a12 12 0 0 0 0 10.8l4-3.1z" />
          <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.9 3.6-4.9 6.7-4.9z" />
        </svg>
      }
    >
      Continue with Google
    </Button>
  );
}

function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
      {children}
    </p>
  );
}

function useRegistrationOpen() {
  const [open, setOpen] = useState<boolean | null>(null);
  useEffect(() => {
    getDoc(doc(db, 'config', 'public'))
      .then((s) => setOpen(Boolean(s.data()?.registrationOpen)))
      .catch(() => setOpen(false));
  }, []);
  return open;
}

function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const regOpen = useRegistrationOpen();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
    } catch (err) {
      setError(friendlyAuthError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell footer="Private assistant · access by invitation">
      <h1 className="mb-1 text-center text-xl font-semibold tracking-tight">Welcome back</h1>
      <p className="mb-7 text-center text-sm text-muted">Sign in to continue to Tessera.</p>
      <div className="space-y-4">
        <GoogleButton onError={setError} />
        <div className="flex items-center gap-3 text-xs text-subtle">
          <div className="h-px flex-1 bg-border" />
          or
          <div className="h-px flex-1 bg-border" />
        </div>
        <form className="space-y-3.5" onSubmit={submit}>
          <div>
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <div className="flex items-baseline justify-between">
              <Label htmlFor="password">Password</Label>
              <Link to="/reset" className="text-xs text-accent hover:underline">
                Forgot password?
              </Link>
            </div>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <ErrorText>{error}</ErrorText>
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
            Sign in
          </Button>
        </form>
        {regOpen && (
          <p className="text-center text-sm text-muted">
            New here?{' '}
            <Link to="/register" className="font-medium text-accent hover:underline">
              Create an account
            </Link>
          </p>
        )}
      </div>
    </Shell>
  );
}

function Register() {
  const regOpen = useRegistrationOpen();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (regOpen === null) return <Shell>{null}</Shell>;
  if (!regOpen) {
    return (
      <Shell>
        <div className="rounded-2xl border border-border p-6 text-center">
          <h1 className="text-lg font-semibold">Registration is closed</h1>
          <p className="mt-2 text-sm text-muted">
            Tessera is invitation-only. Ask the administrator to approve your email, or sign in with an approved Google account.
          </p>
          <Link to="/login" className="mt-5 inline-block text-sm font-medium text-accent hover:underline">
            Back to sign in
          </Link>
        </div>
      </Shell>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < 8) return setError('Use at least 8 characters for your password.');
    setBusy(true);
    try {
      const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
      if (name.trim()) await updateProfile(cred.user, { displayName: name.trim() });
      await sendEmailVerification(cred.user, { url: window.location.origin + '/' });
    } catch (err) {
      setError(friendlyAuthError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell>
      <h1 className="mb-1 text-center text-xl font-semibold tracking-tight">Create your account</h1>
      <p className="mb-7 text-center text-sm text-muted">Access still requires approval by the administrator.</p>
      <form className="space-y-3.5" onSubmit={submit}>
        <div>
          <Label htmlFor="name">Name</Label>
          <Input id="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="password" hint="At least 8 characters.">
            Password
          </Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <ErrorText>{error}</ErrorText>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
          Create account
        </Button>
      </form>
      <p className="mt-5 text-center text-sm text-muted">
        Already have an account?{' '}
        <Link to="/login" className="font-medium text-accent hover:underline">
          Sign in
        </Link>
      </p>
    </Shell>
  );
}

function Reset() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Shell>
      <Link to="/login" className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" /> Back
      </Link>
      <h1 className="mb-1 text-xl font-semibold tracking-tight">Reset your password</h1>
      <p className="mb-6 text-sm text-muted">We’ll email you a link to choose a new password.</p>
      {sent ? (
        <div className="flex gap-3 rounded-xl border border-border bg-surface p-4 text-sm">
          <Mail className="mt-0.5 size-4 shrink-0 text-accent" />
          <p>
            If an account exists for <b>{email}</b>, a reset link is on its way. Check your inbox and spam folder.
          </p>
        </div>
      ) : (
        <form
          className="space-y-3.5"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            try {
              await sendPasswordResetEmail(auth, email.trim(), { url: window.location.origin + '/login' });
              setSent(true);
            } catch (err) {
              const code = (err as { code?: string }).code;
              if (code === 'auth/user-not-found') setSent(true);
              else setError(friendlyAuthError(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <div>
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <ErrorText>{error}</ErrorText>
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
            Send reset link
          </Button>
        </form>
      )}
    </Shell>
  );
}

function Verify() {
  const { user, access, refreshAccess, signOut } = useAuth();
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  if (access === 'signed-out') return <Navigate to="/login" replace />;
  if (access === 'allowed') return <Navigate to="/" replace />;
  if (access === 'denied') return <Navigate to="/denied" replace />;
  return (
    <Shell>
      <div className="rounded-2xl border border-border p-6">
        <div className="mb-4 flex size-10 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Mail className="size-5" />
        </div>
        <h1 className="text-lg font-semibold">Verify your email</h1>
        <p className="mt-2 text-sm text-muted">
          We sent a verification link to <b className="text-fg">{user?.email}</b>. Open it, then come back here.
        </p>
        {msg && <p className="mt-3 text-sm text-accent">{msg}</p>}
        <div className="mt-5 flex flex-col gap-2">
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              await refreshAccess();
              setBusy(false);
              setMsg(auth.currentUser?.emailVerified ? '' : 'Not verified yet. Check your inbox.');
            }}
          >
            I’ve verified my email
          </Button>
          <Button
            variant="ghost"
            onClick={async () => {
              if (!auth.currentUser) return;
              try {
                await sendEmailVerification(auth.currentUser, { url: window.location.origin + '/' });
                setMsg('Verification email sent.');
              } catch (err) {
                setMsg(friendlyAuthError(err));
              }
            }}
          >
            Resend email
          </Button>
          <Button variant="ghost" onClick={() => signOut()}>
            Use a different account
          </Button>
        </div>
      </div>
    </Shell>
  );
}

function Denied() {
  const { user, access, accessError, refreshAccess, signOut } = useAuth();
  if (access === 'signed-out') return <Navigate to="/login" replace />;
  if (access === 'allowed') return <Navigate to="/" replace />;
  if (access === 'unverified') return <Navigate to="/verify" replace />;
  return (
    <Shell>
      <div className="rounded-2xl border border-border p-6">
        <div className="mb-4 flex size-10 items-center justify-center rounded-xl bg-warn-soft text-warn">
          <ShieldAlert className="size-5" />
        </div>
        <h1 className="text-lg font-semibold">{access === 'error' ? 'Can’t verify access' : 'Access not approved'}</h1>
        <p className="mt-2 text-sm text-muted">
          {access === 'error'
            ? accessError ?? 'We could not reach the server to check your access.'
            : (
              <>
                <b className="text-fg">{user?.email}</b> is not on the approved list. Ask the administrator to add this email in Settings → Access.
              </>
            )}
        </p>
        <div className="mt-5 flex flex-col gap-2">
          <Button variant="primary" onClick={() => refreshAccess()}>
            Check again
          </Button>
          <Button variant="ghost" onClick={() => signOut()}>
            Sign out
          </Button>
        </div>
      </div>
    </Shell>
  );
}

export default function AuthPages({ mode }: { mode: Mode }) {
  const { access } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  useEffect(() => {
    if ((mode === 'login' || mode === 'register') && access !== 'loading' && access !== 'signed-out') {
      navigate(access === 'allowed' ? from : access === 'unverified' ? '/verify' : '/denied', { replace: true });
    }
  }, [access, mode, navigate, from]);

  if (mode === 'login') return <Login />;
  if (mode === 'register') return <Register />;
  if (mode === 'reset') return <Reset />;
  if (mode === 'verify') return <Verify />;
  return <Denied />;
}
