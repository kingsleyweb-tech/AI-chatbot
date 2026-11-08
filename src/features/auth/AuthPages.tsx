import {
  createUserWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  updateProfile,
} from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { ArrowLeft, CheckCircle2, Clock, Eye, EyeOff, Mail, ShieldAlert, Smartphone, UserPlus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { LogoMark, TAGLINE } from '@/components/Logo';
import { Button, Input, Label, Spinner, Textarea } from '@/components/ui';
import { api, ApiError, publicApi } from '@/lib/api';
import { authErrorMessage, redirectPending, signInWithProvider, type SocialProvider } from '@/lib/authProviders';
import { countryByCode, toE164 } from '@/lib/phone';
import { PhoneField } from './PhoneField';
import { auth, db } from '@/lib/firebase';
import { validateRegistration } from './validate';
import { CodeBoxes, mmss, phoneError, useCountdown } from './otpUi';
import { useAuth, type AccessState } from '@/state/auth';

type Mode = 'login' | 'register' | 'reset' | 'verify' | 'phone' | 'denied' | 'request';

/** Where each access state belongs. */
function routeFor(access: AccessState, from = '/'): string | null {
  switch (access) {
    case 'allowed':
      return from;
    case 'phone':
      return '/verify-phone';
    case 'unverified':
      return '/verify';
    case 'request':
    case 'pending':
    case 'rejected':
      return '/request-access';
    case 'denied':
    case 'error':
    case 'suspended':
    case 'deleted':
      return '/denied';
    case 'signed-out':
      return '/login';
    default:
      return null;
  }
}

function Shell({ children, footer = TAGLINE }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="scroll-thin touch-scroll flex h-full flex-col overflow-y-auto bg-bg pt-safe pb-safe">
      <div className="flex flex-1 flex-col items-center justify-center px-5 py-10">
        <div className="w-full max-w-[380px]">{children}</div>
      </div>
      <div className="space-y-1.5 pb-6 text-center text-xs text-subtle">
        {footer && <div>{footer}</div>}
        <div>
          <Link to="/privacy" className="hover:text-fg hover:underline">
            Privacy Policy
          </Link>
          <span aria-hidden> · </span>
          <Link to="/terms" className="hover:text-fg hover:underline">
            Terms of Use
          </Link>
        </div>
      </div>
    </div>
  );
}

function Heading({ title, subtitle }: { title: string; subtitle?: ReactNode }) {
  return (
    <div className="mb-7 flex flex-col items-center text-center">
      <LogoMark className="mb-5 size-12" />
      <h1 className="text-[22px] font-semibold tracking-tight">{title}</h1>
      {subtitle && <p className="mt-1.5 text-sm text-muted">{subtitle}</p>}
    </div>
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

const GoogleIcon = (
  <svg viewBox="0 0 24 24" className="size-[18px]" aria-hidden="true">
    <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.2-2.1 3.5-5.1 3.5-8.7z" />
    <path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24z" />
    <path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6h-4a12 12 0 0 0 0 10.8l4-3.1z" />
    <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.9 3.6-4.9 6.7-4.9z" />
  </svg>
);

function SocialButtons({ onError }: { onError: (m: string) => void }) {
  const [busy, setBusy] = useState<SocialProvider | null>(null);
  const go = async (id: SocialProvider) => {
    if (busy) return;
    onError('');
    setBusy(id);
    try {
      const r = await signInWithProvider(id);
      // 'done': the auth listener takes over (it shows a loading state while access is checked).
      // 'redirect': the page is navigating away; keep the spinner.
      if (r !== 'redirect') setBusy(null);
    } catch (err) {
      onError(authErrorMessage(err, id));
      setBusy(null);
    }
  };
  return (
    <div className="space-y-2.5">
      <Button variant="outline" size="lg" className="w-full" loading={busy === 'google'} disabled={busy !== null} onClick={() => go('google')} icon={GoogleIcon}>
        Continue with Google
      </Button>
    </div>
  );
}

function Divider() {
  return (
    <div className="flex items-center gap-3 text-[11px] font-medium tracking-wide text-subtle">
      <div className="h-px flex-1 bg-border" />
      OR CONTINUE WITH EMAIL
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function PasswordInput({ id, value, onChange, autoComplete, invalid }: { id: string; value: string; onChange: (v: string) => void; autoComplete: string; invalid?: boolean }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input
        id={id}
        type={show ? 'text' : 'password'}
        autoComplete={autoComplete}
        value={value}
        aria-invalid={invalid || undefined}
        onChange={(e) => onChange(e.target.value)}
        className="pr-10"
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-subtle hover:text-fg"
        aria-label={show ? 'Hide password' : 'Show password'}
      >
        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}

function useRegistrationOpen() {
  const [open, setOpen] = useState<boolean | null>(null);
  useEffect(() => {
    getDoc(doc(db, 'config', 'public'))
      // New accounts need administrator approval, so sign-up is open unless an admin closed it.
      .then((s) => setOpen(s.data()?.registrationOpen !== false))
      .catch(() => setOpen(true));
  }, []);
  return open;
}

/** Signed in, waiting for the access check: never show the form again in the meantime. */
function Checking() {
  return (
    <Shell>
      <div className="flex flex-col items-center gap-3 text-sm text-muted">
        <Spinner className="size-5" />
        Signing you in…
      </div>
    </Shell>
  );
}

function Login() {
  const { signInError, clearSignInError } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const regOpen = useRegistrationOpen();
  const shown = error || signInError || '';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    clearSignInError();
    setError('');
    if (!email.trim() || !password) return setError('Enter your email and password.');
    setBusy(true);
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
    } catch (err) {
      setError(authErrorMessage(err));
      // best-effort security event for the account owner (silent for unknown addresses)
      const code = (err as { code?: string }).code;
      if (code === 'auth/invalid-credential' || code === 'auth/wrong-password') void publicApi('recovery', { action: 'failedLogin', email: email.trim() }).catch(() => undefined);
      setBusy(false);
    }
  };

  return (
    <Shell>
      <Heading title="Welcome to Atlas AI" subtitle="Your intelligent assistant for thinking, creating and discovering." />
      <div className="space-y-5">
        <SocialButtons
          onError={(m) => {
            clearSignInError();
            setError(m);
          }}
        />
        <Divider />
        <form className="space-y-3.5" onSubmit={submit} noValidate>
          <div>
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <div className="flex items-baseline justify-between">
              <Label htmlFor="password">Password</Label>
              <Link to="/reset" className="text-xs text-accent hover:underline">
                Forgot password?
              </Link>
            </div>
            <PasswordInput id="password" autoComplete="current-password" value={password} onChange={setPassword} />
          </div>
          <ErrorText>{shown}</ErrorText>
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
            Sign in
          </Button>
        </form>
        {regOpen && (
          <p className="text-center text-sm text-muted">
            New to Atlas AI?{' '}
            <Link to="/register" className="font-medium text-accent hover:underline">
              Create an account
            </Link>
          </p>
        )}
      </div>
    </Shell>
  );
}

function FieldError({ children }: { children?: string }) {
  return children ? <p className="mt-1 text-xs text-danger">{children}</p> : null;
}

function Register() {
  const regOpen = useRegistrationOpen();
  const [v, setV] = useState({ name: '', email: '', country: 'GH', phone: '', password: '', confirm: '' });
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const errors = validateRegistration(v);
  const set = (k: keyof typeof v) => (value: string) => setV((s) => ({ ...s, [k]: value }));

  if (regOpen === null) return <Checking />;
  if (!regOpen) {
    return (
      <Shell>
        <Heading title="Registration is closed" subtitle="Atlas AI is invitation-only. Ask the administrator to approve your email, or sign in with an approved Google account." />
        <Link to="/login" className="block text-center text-sm font-medium text-accent hover:underline">
          Back to sign in
        </Link>
      </Shell>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    setError('');
    if (Object.keys(errors).length) return;
    setBusy(true);
    try {
      const e164 = toE164(countryByCode(v.country), v.phone)!;
      // An existing account with this email is refused here by Firebase
      // (auth/email-already-in-use); a number already linked to another
      // account is refused by the server when the code is requested.
      const cred = await createUserWithEmailAndPassword(auth, v.email.trim(), v.password);
      await updateProfile(cred.user, { displayName: v.name.trim() });
      await sendEmailVerification(cred.user, { url: window.location.origin + '/' }).catch(() => undefined);
      // Store the new account (pending approval) and text the code straight away.
      await api('account', { json: { action: 'access', name: v.name.trim() } }).catch(() => undefined);
      try {
        await api('phone', { json: { action: 'send', phone: e164 } });
      } catch (err) {
        rememberPhoneError(phoneError(err), v.phone);
      }
      // The auth listener moves on to the code screen.
    } catch (err) {
      setError(authErrorMessage(err));
      setBusy(false);
    }
  };

  const show = (k: keyof typeof errors) => (touched ? errors[k] : undefined);
  return (
    <Shell>
      <Heading title="Create your account" subtitle="Your intelligent assistant for thinking, creating and discovering." />
      <div className="space-y-5">
        <SocialButtons onError={setError} />
        <Divider />
        <form className="space-y-3.5" onSubmit={submit} noValidate>
          <div>
            <Label htmlFor="name">Full name</Label>
            <Input id="name" autoComplete="name" value={v.name} aria-invalid={!!show('name') || undefined} onChange={(e) => set('name')(e.target.value)} />
            <FieldError>{show('name')}</FieldError>
          </div>
          <div>
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" autoComplete="email" inputMode="email" value={v.email} aria-invalid={!!show('email') || undefined} onChange={(e) => set('email')(e.target.value)} />
            <FieldError>{show('email')}</FieldError>
          </div>
          <div>
            <Label htmlFor="phone">Mobile number</Label>
            <PhoneField id="phone" country={v.country} onCountry={set('country')} value={v.phone} onChange={set('phone')} invalid={!!show('phone')} />
            <FieldError>{show('phone')}</FieldError>
          </div>
          <div>
            <Label htmlFor="password" hint="At least 8 characters, with a number.">
              Password
            </Label>
            <PasswordInput id="password" autoComplete="new-password" value={v.password} onChange={set('password')} invalid={!!show('password')} />
            <FieldError>{show('password')}</FieldError>
          </div>
          <div>
            <Label htmlFor="confirm">Confirm password</Label>
            <PasswordInput id="confirm" autoComplete="new-password" value={v.confirm} onChange={set('confirm')} invalid={!!show('confirm')} />
            <FieldError>{show('confirm')}</FieldError>
          </div>
          <ErrorText>{error}</ErrorText>
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
            Create account
          </Button>
          <p className="text-center text-xs text-subtle">We will text a 6-digit code to confirm your number. New accounts are reviewed by an administrator before they can use Atlas AI.</p>
        </form>
        <p className="text-center text-sm text-muted">
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-accent hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </Shell>
  );
}

type ResetStep = 'email' | 'code' | 'password' | 'done' | 'link-sent';

/**
 * Password reset. Email/password accounts with a verified phone get a
 * 6-digit code by text message; the email link stays available for everyone
 * else. The page never says whether an address has an account.
 */
function Reset() {
  const navigate = useNavigate();
  const [step, setStep] = useState<ResetStep>('email');
  const [email, setEmail] = useState('');
  const [rid, setRid] = useState('');
  const [masked, setMasked] = useState('');
  const [code, setCode] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const resend = useCountdown();
  const expiry = useCountdown();

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(phoneError(err));
    } finally {
      setBusy(false);
    }
  };

  const start = () =>
    run(async () => {
      const r = await publicApi<{ recoveryId: string; phoneMasked: string; expiresIn: number; resendIn: number }>('recovery', { action: 'start', email: email.trim() });
      setRid(r.recoveryId);
      setMasked(r.phoneMasked);
      setCode('');
      resend.start(r.resendIn);
      expiry.start(r.expiresIn);
      setStep('code');
    });

  const sendLink = () =>
    run(async () => {
      try {
        await sendPasswordResetEmail(auth, email.trim(), { url: window.location.origin + '/login' });
      } catch (err) {
        if ((err as { code?: string }).code !== 'auth/user-not-found') throw new ApiError(400, 'email', authErrorMessage(err));
      }
      setStep('link-sent');
    });

  const back = (
    <Link to="/login" className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
      <ArrowLeft className="size-4" /> Back to sign in
    </Link>
  );

  if (step === 'done') {
    return (
      <Shell>
        <Heading title="Password changed" subtitle="Your password has been updated and every device was signed out. Sign in with your new password." />
        <Button variant="primary" size="lg" className="w-full" onClick={() => navigate('/login', { replace: true })}>
          Go to sign in
        </Button>
      </Shell>
    );
  }

  if (step === 'link-sent') {
    return (
      <Shell>
        {back}
        <h1 className="mb-1 text-xl font-semibold tracking-tight">Check your email</h1>
        <div className="mt-4 flex gap-3 rounded-xl border border-border bg-surface p-4 text-sm">
          <Mail className="mt-0.5 size-4 shrink-0 text-accent" />
          <p>
            If an account exists for <b>{email}</b>, a reset link is on its way. Check your inbox and spam folder.
          </p>
        </div>
      </Shell>
    );
  }

  if (step === 'code') {
    return (
      <Shell>
        <button type="button" onClick={() => setStep('email')} className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
          <ArrowLeft className="size-4" /> Change email
        </button>
        <h1 className="mb-1 text-xl font-semibold tracking-tight">Enter the code</h1>
        <p className="mb-6 text-sm text-muted">
          If <b className="font-medium text-fg">{email}</b> has a verified phone number, we sent a 6-digit code to <b className="font-medium text-fg">{masked}</b>.
          {expiry.left > 0 ? ` It expires in ${Math.floor(expiry.left / 60)}:${String(expiry.left % 60).padStart(2, '0')}.` : ' The code has expired; request a new one.'}
        </p>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (code.length !== 6) return setError('Enter the 6-digit code.');
            void run(async () => {
              const r = await publicApi<{ resetToken: string }>('recovery', { action: 'verify', recoveryId: rid, code });
              setResetToken(r.resetToken);
              setStep('password');
            });
          }}
        >
          <CodeBoxes value={code} onChange={setCode} disabled={busy} invalid={Boolean(error)} />
          <ErrorText>{error}</ErrorText>
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
            Verify code
          </Button>
        </form>
        <div className="mt-4 flex flex-col items-center gap-2 text-sm">
          <button type="button" className="text-accent disabled:text-subtle" disabled={busy || resend.left > 0} onClick={() => void start()}>
            {resend.left > 0 ? `Resend code in ${resend.left} s` : 'Resend code'}
          </button>
          <button type="button" className="text-muted hover:text-fg" disabled={busy} onClick={() => void sendLink()}>
            No text message? Email me a reset link instead
          </button>
        </div>
      </Shell>
    );
  }

  if (step === 'password') {
    return (
      <Shell>
        <h1 className="mb-1 text-xl font-semibold tracking-tight">Choose a new password</h1>
        <p className="mb-6 text-sm text-muted">Use at least 8 characters with letters and a number. All devices will be signed out.</p>
        <form
          className="space-y-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) return setError('Use at least 8 characters with letters and at least one number.');
            if (password !== confirm) return setError('The passwords do not match.');
            void run(async () => {
              await publicApi('recovery', { action: 'reset', recoveryId: rid, resetToken, password });
              setPassword('');
              setConfirm('');
              setStep('done');
            });
          }}
        >
          <div>
            <Label htmlFor="new-password">New password</Label>
            <div className="relative">
              <Input id="new-password" type={show ? 'text' : 'password'} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className="pr-10" />
              <button type="button" aria-label={show ? 'Hide password' : 'Show password'} onClick={() => setShow(!show)} className="absolute top-1/2 right-2.5 -translate-y-1/2 text-subtle hover:text-fg">
                {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </div>
          <div>
            <Label htmlFor="confirm-password">Confirm new password</Label>
            <Input id="confirm-password" type={show ? 'text' : 'password'} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </div>
          <ErrorText>{error}</ErrorText>
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
            Change password
          </Button>
        </form>
      </Shell>
    );
  }

  return (
    <Shell>
      {back}
      <h1 className="mb-1 text-xl font-semibold tracking-tight">Reset your password</h1>
      <p className="mb-6 text-sm text-muted">Enter your account email. If it has a verified phone number, we will text you a 6-digit code.</p>
      <form
        className="space-y-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) return setError('Enter a valid email address.');
          void start();
        }}
        noValidate
      >
        <div>
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <ErrorText>{error}</ErrorText>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} icon={<Smartphone className="size-4" />}>
          Text me a code
        </Button>
        <Button type="button" variant="ghost" className="w-full" disabled={busy || !email.trim()} onClick={() => void sendLink()}>
          Email me a reset link instead
        </Button>
      </form>
    </Shell>
  );
}

/* ----------------------------- phone verification ----------------------------- */

interface PhoneStatus {
  required: boolean;
  verified: boolean;
  configured: boolean;
  pending?: boolean;
  phoneMasked?: string | null;
  expiresIn?: number;
  resendIn?: number;
  attemptsLeft?: number;
}

const PHONE_ERROR_KEY = 'atlas.phoneError';
/** Carry a failed first text (from registration) over to the phone screen. */
function rememberPhoneError(message: string, phone: string) {
  try {
    sessionStorage.setItem(PHONE_ERROR_KEY, JSON.stringify({ message, phone }));
  } catch {
    /* storage unavailable */
  }
}
function takePhoneError(): { message: string; phone: string } | null {
  try {
    const v = sessionStorage.getItem(PHONE_ERROR_KEY);
    sessionStorage.removeItem(PHONE_ERROR_KEY);
    return v ? (JSON.parse(v) as { message: string; phone: string }) : null;
  } catch {
    return null;
  }
}

function PhoneVerify() {
  const { user, access, refreshAccess, signOut } = useAuth();
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  const [step, setStep] = useState<'number' | 'code'>('number');
  const [carried] = useState(takePhoneError);
  const [phone, setPhone] = useState(carried?.phone ?? '');
  const [masked, setMasked] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState(carried?.message ?? '');
  const [codeInvalid, setCodeInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const resend = useCountdown();
  const expiry = useCountdown();

  const load = useCallback(async () => {
    try {
      const s = await api<PhoneStatus>('phone', { json: { action: 'status' } });
      setStatus(s);
      if (s.verified) {
        await refreshAccess();
        return;
      }
      if (s.pending && s.phoneMasked) {
        setMasked(s.phoneMasked);
        setStep('code');
        expiry.start(s.expiresIn ?? 0);
      }
      if (s.resendIn) resend.start(s.resendIn);
    } catch (err) {
      setStatus({ required: true, verified: false, configured: true });
      setError(phoneError(err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshAccess]);

  useEffect(() => {
    if (access === 'phone') void load();
  }, [access, load]);

  if (access === 'loading') return <Checking />;
  if (access !== 'phone') return <Navigate to={routeFor(access) ?? '/'} replace />;
  if (!status) return <Checking />;

  if (!status.configured) {
    return (
      <Shell>
        <Heading title="Phone verification unavailable" subtitle="Text-message verification has not been set up on the server yet. Please try again later or contact the administrator." />
        <div className="flex flex-col gap-2">
          <Button variant="primary" onClick={() => void load()}>
            Try again
          </Button>
          <Button variant="ghost" onClick={() => signOut()}>
            Sign out
          </Button>
        </div>
      </Shell>
    );
  }

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    setError('');
    setCodeInvalid(false);
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 9) return setError('Enter your mobile number, for example 024 123 4567.');
    setBusy(true);
    try {
      const r = await api<{ phoneMasked: string; expiresIn: number; resendIn: number }>('phone', { json: { action: 'send', phone: digits } });
      setMasked(r.phoneMasked);
      setStep('code');
      setCode('');
      expiry.start(r.expiresIn);
      resend.start(r.resendIn);
    } catch (err) {
      if (err instanceof ApiError && typeof err.details.retryAfter === 'number' && err.code === 'resend_cooldown') resend.start(err.details.retryAfter);
      setError(phoneError(err));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (value = code) => {
    if (value.length !== 6 || busy) return;
    setError('');
    setCodeInvalid(false);
    setBusy(true);
    try {
      await api('phone', { json: { action: 'verify', code: value } });
      // The server set the phoneVerified claim: refresh the token and move on.
      await refreshAccess();
    } catch (err) {
      setCodeInvalid(true);
      setCode('');
      if (err instanceof ApiError && ['too_many_attempts', 'expired', 'no_code'].includes(err.code)) expiry.start(0);
      setError(phoneError(err));
      setBusy(false);
    }
  };

  if (step === 'number') {
    return (
      <Shell>
        <div className="mb-7 flex flex-col items-center text-center">
          <div className="mb-5 flex size-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
            <Smartphone className="size-6" />
          </div>
          <h1 className="text-[22px] font-semibold tracking-tight">Verify your phone</h1>
          <p className="mt-1.5 text-sm text-muted">We’ll text a 6-digit code to confirm it’s you. Standard message rates may apply.</p>
        </div>
        <form className="space-y-3.5" onSubmit={send} noValidate>
          <div>
            <Label htmlFor="phone">Mobile number</Label>
            <div className="flex gap-2">
              <span className="flex h-11 items-center rounded-xl border border-border bg-surface-2 px-3 text-[15px] text-muted" aria-label="Country code Ghana">
                GH +233
              </span>
              <Input
                id="phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel-national"
                placeholder="024 123 4567"
                value={phone}
                onChange={(e) => setPhone(e.target.value.replace(/[^\d\s]/g, '').slice(0, 13))}
                className="flex-1"
              />
            </div>
            <p className="mt-1.5 text-xs text-subtle">Ghana mobile numbers are supported at the moment.</p>
          </div>
          <ErrorText>{error}</ErrorText>
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={resend.left > 0}>
            {resend.left > 0 ? `Send code in ${resend.left} s` : 'Send code'}
          </Button>
        </form>
        <div className="mt-6 text-center text-sm text-muted">
          Signed in as {user?.email}.{' '}
          <button className="font-medium text-accent hover:underline" onClick={() => signOut()}>
            Sign out
          </button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <button
        onClick={() => {
          setStep('number');
          setError('');
        }}
        className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" /> Change number
      </button>
      <h1 className="text-[22px] font-semibold tracking-tight">Enter the code</h1>
      <p className="mt-1.5 mb-6 text-sm text-muted">
        We sent a 6-digit code to <b className="font-medium text-fg">{masked}</b>.
      </p>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void verify();
        }}
      >
        <CodeBoxes
          value={code}
          disabled={busy}
          invalid={codeInvalid}
          onChange={(v) => {
            setCode(v);
            setCodeInvalid(false);
            if (v.length === 6) void verify(v);
          }}
        />
        <p className="text-xs text-subtle" aria-live="polite">
          {expiry.left > 0 ? `The code expires in ${mmss(expiry.left)}.` : 'This code has expired or is no longer valid. Request a new one.'}
        </p>
        <ErrorText>{error}</ErrorText>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={code.length !== 6}>
          Verify
        </Button>
      </form>
      <div className="mt-5 text-center text-sm text-muted">
        Didn’t get it?{' '}
        {resend.left > 0 ? (
          <span className="tabular-nums">Resend in {mmss(resend.left)}</span>
        ) : (
          <button className="font-medium text-accent hover:underline" onClick={() => void send()} disabled={busy}>
            Resend code
          </button>
        )}
      </div>
    </Shell>
  );
}

/* ----------------------------- other states ----------------------------- */

function Verify() {
  const { user, access, refreshAccess, signOut } = useAuth();
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  if (access === 'loading' && !busy) return <Checking />;
  if (access !== 'unverified' && access !== 'loading') return <Navigate to={routeFor(access) ?? '/'} replace />;
  return (
    <Shell>
      <div className="mb-7 flex flex-col items-center text-center">
        <div className="mb-5 flex size-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
          <Mail className="size-6" />
        </div>
        <h1 className="text-[22px] font-semibold tracking-tight">Verify your email</h1>
        <p className="mt-1.5 text-sm text-muted">
          We sent a verification link to <b className="font-medium text-fg">{user?.email}</b>. Open it, then come back here.
        </p>
      </div>
      {msg && <p className="mb-3 text-center text-sm text-accent">{msg}</p>}
      <div className="flex flex-col gap-2">
        <Button
          variant="primary"
          size="lg"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            await refreshAccess();
            setBusy(false);
            setMsg(auth.currentUser?.emailVerified ? '' : 'Not verified yet. Check your inbox and spam folder.');
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
              setMsg(authErrorMessage(err));
            }
          }}
        >
          Resend email
        </Button>
        <Button variant="ghost" onClick={() => signOut()}>
          Use a different account
        </Button>
      </div>
    </Shell>
  );
}

function Denied() {
  const { user, access, accessError, refreshAccess, signOut } = useAuth();
  const [busy, setBusy] = useState(false);
  if (access === 'loading' && !busy) return <Checking />;
  if (access !== 'denied' && access !== 'error' && access !== 'suspended' && access !== 'deleted' && access !== 'loading') return <Navigate to={routeFor(access) ?? '/'} replace />;
  const isError = access === 'error';
  if (access === 'suspended' || access === 'deleted') {
    return (
      <Shell>
        <div className="mb-7 flex flex-col items-center text-center">
          <div className="mb-5 flex size-12 items-center justify-center rounded-2xl bg-danger-soft text-danger">
            <ShieldAlert className="size-6" />
          </div>
          <h1 className="text-[22px] font-semibold tracking-tight">{access === 'suspended' ? 'Account suspended' : 'Account scheduled for deletion'}</h1>
          <p className="mt-1.5 text-sm text-muted">
            {access === 'suspended'
              ? 'An administrator has suspended this account, so it cannot be used right now. Your data has not been deleted. Contact the administrator if you think this is a mistake.'
              : 'An administrator has scheduled this account for deletion. It can still be restored by the administrator for a limited time; after that it is permanently removed.'}
          </p>
        </div>
        <Button variant="primary" size="lg" className="w-full" onClick={() => signOut()}>
          Sign out
        </Button>
      </Shell>
    );
  }
  return (
    <Shell>
      <div className="mb-7 flex flex-col items-center text-center">
        <div className="mb-5 flex size-12 items-center justify-center rounded-2xl bg-warn-soft text-warn">
          <ShieldAlert className="size-6" />
        </div>
        <h1 className="text-[22px] font-semibold tracking-tight">{isError ? 'Something went wrong' : 'Access not approved'}</h1>
        <p className="mt-1.5 text-sm text-muted">
          {isError ? (
            accessError ?? 'We could not reach the server to check your access.'
          ) : (
            <>
              <b className="font-medium text-fg">{user?.email}</b> is not on the approved list yet. Ask the administrator to add this email in Settings &gt; Access.
            </>
          )}
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Button
          variant="primary"
          size="lg"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            await refreshAccess();
            setBusy(false);
          }}
        >
          {isError ? 'Try again' : 'Check again'}
        </Button>
        <Button variant="ghost" onClick={() => signOut()}>
          Sign out
        </Button>
      </div>
    </Shell>
  );
}

/* ----------------------------- access requests ----------------------------- */

const fmtDate = (ms: number | null | undefined) =>
  ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2 text-sm">
      <span className="text-muted">{label}</span>
      <span className="min-w-0 truncate text-right font-medium text-fg">{children}</span>
    </div>
  );
}

/**
 * Accounts that are signed in (and verified) but not approved. Shows the
 * request form, or the status of the request already submitted. Status is
 * re-checked when the app comes back into view and every two minutes while
 * the page is open (at most 15 times), never in a tight loop.
 */
function AccessRequest() {
  const { user, access, accessInfo, provider, refreshAccess, signOut } = useAuth();
  const isPassword = provider === 'password';
  const [name, setName] = useState(accessInfo.profile?.displayName ?? user?.displayName ?? '');
  const [country, setCountry] = useState('GH');
  const [phone, setPhone] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const checks = useRef(0);

  const check = useCallback(async () => {
    setChecking(true);
    await refreshAccess();
    setChecking(false);
  }, [refreshAccess]);

  useEffect(() => {
    if (access !== 'pending') return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible' || checks.current >= 15) return;
      checks.current += 1;
      void check();
    }, 120_000);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [access, check]);

  if (access === 'loading' && !busy && !checking) return <Checking />;
  if (!['request', 'pending', 'rejected', 'loading'].includes(access)) return <Navigate to={routeFor(access) ?? '/'} replace />;

  const req = accessInfo.request;

  if (access === 'rejected') {
    return (
      <Shell>
        <div className="mb-7 flex flex-col items-center text-center">
          <div className="mb-5 flex size-12 items-center justify-center rounded-2xl bg-danger-soft text-danger">
            <ShieldAlert className="size-6" />
          </div>
          <h1 className="text-[22px] font-semibold tracking-tight">Access not approved</h1>
          <p className="mt-1.5 text-sm text-muted">
            The administrator reviewed the request for <b className="font-medium text-fg">{user?.email}</b> and did not approve access to Atlas AI. Contact the administrator if you think this is a mistake.
          </p>
        </div>
        {req && (
          <div className="mb-6 divide-y divide-border rounded-xl border border-border px-4">
            <Detail label="Status">Not approved</Detail>
            <Detail label="Submitted">{fmtDate(req.submittedAt)}</Detail>
            {req.reviewedAt && <Detail label="Reviewed">{fmtDate(req.reviewedAt)}</Detail>}
          </div>
        )}
        <Button variant="primary" size="lg" className="w-full" onClick={() => signOut()}>
          Sign out
        </Button>
      </Shell>
    );
  }

  if (access === 'pending' && req) {
    return (
      <Shell>
        <div className="mb-7 flex flex-col items-center text-center">
          <div className="mb-5 flex size-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
            <CheckCircle2 className="size-6" />
          </div>
          <h1 className="text-[22px] font-semibold tracking-tight">Your request has been submitted</h1>
          <p className="mt-1.5 text-sm text-muted">
            Thank you for your interest in Atlas AI. Your access request has been sent to the administrator. You will be able to use Atlas AI as soon as your account has been approved.
          </p>
        </div>
        <div className="mb-6 divide-y divide-border rounded-xl border border-border px-4">
          <Detail label="Name">{req.fullName}</Detail>
          <Detail label="Email">{req.email}</Detail>
          {req.phoneMasked && (
            <Detail label="Phone">
              {req.phoneMasked} {req.phoneVerified ? '' : <span className="font-normal text-subtle">(not verified)</span>}
            </Detail>
          )}
          <Detail label="Status">
            <span className="inline-flex items-center gap-1.5 text-warn">
              <Clock className="size-3.5" /> Waiting for review
            </span>
          </Detail>
          <Detail label="Submitted">{fmtDate(req.submittedAt)}</Detail>
        </div>
        <div className="flex flex-col gap-2">
          <Button variant="primary" size="lg" loading={checking} onClick={() => void check()}>
            Refresh status
          </Button>
          <Button variant="ghost" onClick={() => signOut()}>
            Sign out
          </Button>
        </div>
        <p className="mt-4 text-center text-xs text-subtle">You can close the app; your request stays on file. Sign in again any time to check its status.</p>
      </Shell>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (name.trim().length < 2) return setError('Enter your full name.');
    let e164: string | undefined;
    if (!isPassword) {
      const n = toE164(countryByCode(country), phone);
      if (!n) return setError(`Enter a valid phone number, for example ${countryByCode(country).example}.`);
      e164 = n;
    }
    setBusy(true);
    try {
      await api('account', {
        json: { action: 'requestAccess', fullName: name.trim(), phone: e164, dialCode: countryByCode(country).dial, reason: reason.trim() || undefined },
      });
      await refreshAccess();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Your request could not be sent. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell>
      <div className="mb-7 flex flex-col items-center text-center">
        <div className="mb-5 flex size-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
          <UserPlus className="size-6" />
        </div>
        <h1 className="text-[22px] font-semibold tracking-tight">Request Access to Atlas AI</h1>
        <p className="mt-1.5 text-sm text-muted">
          Atlas AI currently requires administrator approval before new users can access the application. Submit your details below to request access.
        </p>
      </div>
      <form className="space-y-3.5" onSubmit={submit} noValidate>
        <div>
          <Label htmlFor="req-name">Full name</Label>
          <Input id="req-name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="req-email">Email address</Label>
          <Input id="req-email" type="email" value={user?.email ?? ''} readOnly className="bg-surface-2 text-muted" />
        </div>
        <div>
          <Label htmlFor="req-phone">Phone number</Label>
          {isPassword ? (
            <Input id="req-phone" value={`${accessInfo.profile?.phoneMasked ?? ''} (verified)`} readOnly className="bg-surface-2 text-muted" />
          ) : (
            <PhoneField id="req-phone" country={country} onCountry={setCountry} value={phone} onChange={setPhone} />
          )}
        </div>
        <div>
          <Label htmlFor="req-reason" hint="Optional">
            Reason for requesting access
          </Label>
          <Textarea id="req-reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <ErrorText>{error}</ErrorText>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
          Submit Access Request
        </Button>
      </form>
      <div className="mt-6 text-center text-sm text-muted">
        Signed in as {user?.email}.{' '}
        <button className="font-medium text-accent hover:underline" onClick={() => signOut()}>
          Sign out
        </button>
      </div>
    </Shell>
  );
}

export default function AuthPages({ mode }: { mode: Mode }) {
  const { access } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/';
  const entry = mode === 'login' || mode === 'register' || mode === 'reset';

  // Sign-in, register and reset pages follow the auth state once a user exists.
  useEffect(() => {
    if (!entry || access === 'signed-out' || access === 'loading') return;
    const to = routeFor(access, from);
    if (to) navigate(to, { replace: true });
  }, [access, entry, navigate, from]);

  // Signed in (or returning from Google) while access is checked: never flash the form.
  if (entry && access === 'loading' && (auth.currentUser || redirectPending())) return <Checking />;
  if (mode === 'login') return <Login />;
  if (mode === 'register') return <Register />;
  if (mode === 'reset') return <Reset />;
  if (mode === 'verify') return <Verify />;
  if (mode === 'phone') return <PhoneVerify />;
  if (mode === 'request') return <AccessRequest />;
  return <Denied />;
}
