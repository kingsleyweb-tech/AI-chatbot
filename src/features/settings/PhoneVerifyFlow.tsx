import { useEffect, useState, type FormEvent } from 'react';
import { Button, Label } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { countryByCode, SMS_COUNTRIES, toE164 } from '@/lib/phone';
import { useAuth } from '@/state/auth';
import { CodeBoxes, DeliveryLine, mmss, phoneError, useCountdown, type DeliveryState } from '../auth/otpUi';
import { PhoneField } from '../auth/PhoneField';

/** A code already requested (from /api/phone status), to continue where the person left off. */
export interface PendingCode {
  phoneMasked: string;
  codeLength: number;
  expiresIn: number;
  resendIn: number;
  delivery: { state: DeliveryState; error: string | null } | null;
}

interface SendResult {
  phoneMasked: string;
  phoneDisplay?: string;
  expiresIn: number;
  resendIn: number;
  codeLength?: number;
  delivery?: DeliveryState;
}

/**
 * Enter a number, receive a code by text (Vynfy, through /api/phone), enter
 * the code. Nothing is saved until the server has checked the code: the
 * number, the verified flag and the token claim are all written by the
 * server. Used by Settings and by the "Secure your account" reminder.
 */
export function PhoneVerifyFlow({
  pending,
  submitLabel = 'Send code',
  onVerified,
  secondary,
}: {
  pending?: PendingCode | null;
  submitLabel?: string;
  onVerified: () => void;
  /** extra buttons beside the main one (Cancel, Skip for now) */
  secondary?: (busy: boolean) => React.ReactNode;
}) {
  const { refreshAccess } = useAuth();
  const [step, setStep] = useState<'number' | 'code'>(pending ? 'code' : 'number');
  const [country, setCountry] = useState('GH');
  const [phone, setPhone] = useState('');
  const [masked, setMasked] = useState(pending?.phoneMasked ?? '');
  const [codeLength, setCodeLength] = useState(pending?.codeLength ?? 6);
  const [delivery, setDelivery] = useState(pending?.delivery ?? null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [hint, setHint] = useState('');
  const [busy, setBusy] = useState(false);
  const resend = useCountdown();
  const expiry = useCountdown();

  useEffect(() => {
    if (!pending) return;
    expiry.start(pending.expiresIn);
    if (pending.resendIn) resend.start(pending.resendIn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // While an ordinary SMS is in flight, check its delivery report a few times, then stop.
  const waiting = step === 'code' && (delivery?.state === 'pending' || delivery?.state === 'sent') && expiry.left > 0;
  useEffect(() => {
    if (!waiting) return;
    let n = 0;
    const t = setInterval(() => {
      if (++n > 8) return clearInterval(t);
      api<{ delivery?: { state: DeliveryState; error: string | null } | null }>('phone', { json: { action: 'status' } })
        .then((s) => s.delivery && setDelivery(s.delivery))
        .catch(() => undefined);
    }, 8000);
    return () => clearInterval(t);
  }, [waiting]);

  const request = async (json: Record<string, unknown>) => {
    if (busy) return;
    setError('');
    setHint('');
    setBusy(true);
    try {
      const r = await api<SendResult>('phone', { json });
      setMasked(r.phoneDisplay ?? r.phoneMasked);
      setCodeLength(r.codeLength ?? 6);
      setDelivery(r.delivery ? { state: r.delivery, error: null } : null);
      setCode('');
      expiry.start(r.expiresIn);
      resend.start(r.resendIn);
      setStep('code');
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'resend_cooldown' || err.code === 'otp_pending') && typeof err.details.retryAfter === 'number')
        resend.start(err.details.retryAfter);
      if (err instanceof ApiError && err.code === 'otp_pending' && typeof err.details.ussd === 'string')
        setHint(`No text yet? Dial ${err.details.ussd} on this phone to see your code.`);
      setError(phoneError(err));
    } finally {
      setBusy(false);
    }
  };

  const send = (e?: FormEvent) => {
    e?.preventDefault();
    const c = countryByCode(country);
    if (!SMS_COUNTRIES.has(c.code)) return setError('Verification texts can only be sent to Ghana (+233) numbers at the moment.');
    const e164 = toE164(c, phone);
    if (!e164) return setError(`Enter a valid mobile number, for example ${c.example}.`);
    void request({ action: 'send', phone: e164 });
  };

  const verify = async (e?: FormEvent, typed: string = code) => {
    e?.preventDefault();
    if (busy) return;
    if (typed.length !== codeLength) return setError(`Enter the ${codeLength}-digit code.`);
    setError('');
    setBusy(true);
    try {
      await api('phone', { json: { action: 'verify', code: typed } });
      await refreshAccess();
      onVerified();
    } catch (err) {
      setCode('');
      if (err instanceof ApiError && ['too_many_attempts', 'expired', 'no_code'].includes(err.code)) expiry.start(0);
      setError(phoneError(err));
    } finally {
      setBusy(false);
    }
  };

  if (step === 'number') {
    return (
      <form className="space-y-3" onSubmit={send} noValidate>
        <div>
          <Label htmlFor="verify-phone">Mobile number</Label>
          <PhoneField id="verify-phone" country={country} onCountry={setCountry} value={phone} onChange={setPhone} invalid={Boolean(error)} />
        </div>
        <p className="text-xs text-muted">
          We text one code to confirm the number; it expires after a few minutes. Codes can only be sent to Ghana (+233) numbers at the moment,
          written as 024 123 4567 or +233 24 123 4567.
        </p>
        {error && <p className="text-sm text-danger" role="alert">{error}</p>}
        {hint && <p className="text-xs text-muted">{hint}</p>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {secondary?.(busy)}
          <Button type="submit" variant="primary" loading={busy} disabled={resend.left > 0}>
            {resend.left > 0 ? `Send code in ${resend.left} s` : submitLabel}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <form className="space-y-3" onSubmit={verify}>
      <p className="text-sm">
        Enter the {codeLength}-digit code sent to <b className="font-medium">{masked}</b>.{' '}
        <span className="text-muted">{expiry.left > 0 ? `Expires in ${mmss(expiry.left)}.` : 'The code has expired; request a new one.'}</span>
      </p>
      <DeliveryLine state={delivery?.state} error={delivery?.error} />
      <div className="max-w-xs">
        <CodeBoxes
          value={code}
          onChange={(v) => {
            setCode(v);
            if (v.length === codeLength) void verify(undefined, v);
          }}
          length={codeLength}
          disabled={busy}
          invalid={Boolean(error)}
        />
      </div>
      {error && <p className="text-sm text-danger" role="alert">{error}</p>}
      {hint && <p className="text-xs text-muted">{hint}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" loading={busy}>
          Verify
        </Button>
        <Button type="button" variant="outline" disabled={busy || resend.left > 0} onClick={() => void request({ action: 'resend' })}>
          {resend.left > 0 ? `Resend in ${resend.left} s` : 'Resend code'}
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => (setStep('number'), setError(''), setHint(''))}>
          Use another number
        </Button>
        {secondary?.(busy)}
      </div>
    </form>
  );
}
