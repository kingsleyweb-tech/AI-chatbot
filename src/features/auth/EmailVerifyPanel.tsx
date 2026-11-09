import { sendEmailVerification } from 'firebase/auth';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { auth } from '@/lib/firebase';
import { useAuth } from '@/state/auth';
import { CodeBoxes, useCountdown } from './otpUi';

/** When the last verification code was sent (this tab), so reopening a screen does not send another. */
export const EMAIL_CODE_SENT = 'atlas.emailCodeSentAt';

function lastSent(): number {
  try {
    return Number(sessionStorage.getItem(EMAIL_CODE_SENT) ?? 0);
  } catch {
    return 0;
  }
}
function remember(at: number | null) {
  try {
    if (at === null) sessionStorage.removeItem(EMAIL_CODE_SENT);
    else sessionStorage.setItem(EMAIL_CODE_SENT, String(at));
  } catch {
    /* storage unavailable */
  }
}

/**
 * Verify the account's email with a 6-digit code (sent through /api/account,
 * checked on the server, which then marks the address verified). Falls back
 * to Firebase's verification link when email codes are unavailable.
 * Used by the sign-up screen, the dashboard reminder and Settings › Security.
 */
export function EmailVerifyPanel({
  autoSend = false,
  onVerified,
  secondary,
  intro,
}: {
  /** send a code as soon as the panel opens (otherwise a "Send code" button is shown first) */
  autoSend?: boolean;
  onVerified: () => void | Promise<void>;
  /** extra actions under the form, e.g. "Skip for now" */
  secondary?: (busy: boolean) => ReactNode;
  intro?: ReactNode;
}) {
  const { user, refreshAccess } = useAuth();
  const recent = Date.now() - lastSent() < 9 * 60_000;
  const [mode, setMode] = useState<'idle' | 'sending' | 'code' | 'link'>(
    recent ? 'code' : autoSend ? 'sending' : 'idle',
  );
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const resend = useCountdown();
  const started = useRef(false);

  const sendLink = useCallback(async (quiet = false) => {
    if (!auth.currentUser) return;
    try {
      await sendEmailVerification(auth.currentUser, { url: window.location.origin + '/' });
      setMode('link');
      if (!quiet) setMsg('Verification link sent.');
    } catch (err) {
      setMode('link');
      setMsg(err instanceof Error ? 'The link could not be sent. Try again in a few minutes.' : '');
    }
  }, []);

  const sendCode = useCallback(
    async (initial = false) => {
      setError('');
      setMsg('');
      setBusy(true);
      if (initial) setMode('sending');
      try {
        const r = await api<{ sentTo: string; resendIn: number }>('account', {
          json: { action: 'emailCodeSend', purpose: 'verify_email' },
        });
        remember(Date.now());
        setSentTo(r.sentTo);
        resend.start(r.resendIn);
        setMode('code');
        if (!initial) setMsg('A new code is on its way.');
      } catch (err) {
        const c = err instanceof ApiError ? err.code : '';
        if (c === 'already_verified') {
          await refreshAccess();
          await onVerified();
        } else if (c === 'resend_cooldown') {
          setMode('code');
          resend.start(Number((err as ApiError).details.retryAfter ?? 60));
        } else if (
          c === 'email_unavailable' ||
          c === 'email_failed' ||
          c === 'admin_unconfigured' ||
          !c
        ) {
          // Email codes are not available: use Firebase's verification link instead.
          await sendLink(true);
        } else {
          setMode('code');
          setError(err instanceof ApiError ? err.message : 'The code could not be sent.');
        }
      } finally {
        setBusy(false);
      }
    },
    [refreshAccess, resend, sendLink, onVerified],
  );

  useEffect(() => {
    if (!autoSend || started.current || recent) return;
    started.current = true;
    void sendCode(true);
  }, [autoSend, recent, sendCode]);

  const verify = async (e: FormEvent) => {
    e.preventDefault();
    if (code.length !== 6) return setError('Enter the 6-digit code.');
    setBusy(true);
    setError('');
    try {
      await api('account', { json: { action: 'emailCodeVerify', purpose: 'verify_email', code } });
      remember(null);
      await refreshAccess();
      await onVerified();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The code could not be checked. Try again.');
      if (
        err instanceof ApiError &&
        (err.code === 'too_many_attempts' || err.code === 'expired' || err.code === 'no_code')
      )
        setCode('');
    } finally {
      setBusy(false);
    }
  };

  const email = sentTo || user?.email || 'your email';
  return (
    <div>
      <p className="mb-4 text-sm text-muted">
        {mode === 'link' ? (
          <>
            We sent a verification link to <b className="font-medium text-fg">{user?.email}</b>.
            Open it, then come back here.
          </>
        ) : mode === 'code' ? (
          <>
            Enter the 6-digit code we emailed to <b className="font-medium text-fg">{email}</b>.
            Check your spam folder if it is not in your inbox.
          </>
        ) : mode === 'sending' ? (
          'Sending a code to your email…'
        ) : (
          (intro ?? (
            <>
              We will email a 6-digit code to <b className="font-medium text-fg">{user?.email}</b>.
            </>
          ))
        )}
      </p>
      {msg && <p className="mb-3 text-sm text-accent">{msg}</p>}
      {mode === 'code' && (
        <form className="mb-3 space-y-4" onSubmit={(e) => void verify(e)}>
          <CodeBoxes value={code} onChange={setCode} disabled={busy} invalid={Boolean(error)} />
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
            Verify email
          </Button>
        </form>
      )}
      <div className="flex flex-col gap-2">
        {mode === 'idle' && (
          <Button
            variant="primary"
            size="lg"
            className="w-full"
            loading={busy}
            onClick={() => void sendCode(true)}
          >
            Send code
          </Button>
        )}
        {mode === 'link' && (
          <Button
            variant="primary"
            size="lg"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              await refreshAccess();
              setBusy(false);
              if (auth.currentUser?.emailVerified) await onVerified();
              else setMsg('Not verified yet. Check your inbox and spam folder.');
            }}
          >
            I’ve verified my email
          </Button>
        )}
        {mode === 'code' && (
          <Button
            variant="ghost"
            disabled={busy || resend.left > 0}
            onClick={() => void sendCode()}
          >
            {resend.left > 0 ? `Resend code in ${resend.left} s` : 'Resend code'}
          </Button>
        )}
        {(mode === 'code' || mode === 'link') && (
          <Button variant="ghost" disabled={busy} onClick={() => void sendLink()}>
            {mode === 'link' ? 'Resend link' : 'Send me a link instead'}
          </Button>
        )}
        {secondary?.(busy)}
      </div>
    </div>
  );
}
