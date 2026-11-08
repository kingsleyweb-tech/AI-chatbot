import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';

/** Shared pieces for SMS code entry (sign-up, password reset, settings). Codes are 4-8 digits. */

export function useCountdown() {
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until <= now) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until, now]);
  const start = useCallback((s: number) => {
    const t = Date.now();
    setNow(t);
    setUntil(t + s * 1000);
  }, []);
  return { left: Math.max(0, Math.ceil((until - now) / 1000)), start };
}

export const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

export function CodeBoxes({ value, onChange, disabled, invalid, length = 6 }: { value: string; onChange: (v: string) => void; disabled?: boolean; invalid?: boolean; length?: number }) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const digits = Array.from({ length }, (_, i) => value[i] ?? '');
  const put = (i: number, text: string) => {
    const clean = text.replace(/\D/g, '');
    if (!clean) return;
    const next = (value.slice(0, i) + clean).slice(0, length);
    onChange(next);
    refs.current[Math.min(next.length, length - 1)]?.focus();
  };
  return (
    <div className="flex justify-between gap-2" role="group" aria-label={`${length}-digit code`}>
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          value={d}
          disabled={disabled}
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          maxLength={i === 0 ? length : 1}
          aria-label={`Digit ${i + 1}`}
          autoFocus={i === 0}
          className={cn(
            'h-13 w-full min-w-0 rounded-xl border bg-surface text-center text-xl font-semibold tabular-nums outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20',
            invalid ? 'border-danger' : 'border-border',
          )}
          onChange={(e) => {
            const t = e.target.value;
            if (!t) onChange(value.slice(0, i) + value.slice(i + 1));
            else put(i, t.length > 1 && t.startsWith(d) ? t.slice(d.length) || t : t);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !d && i > 0) {
              onChange(value.slice(0, i - 1));
              refs.current[i - 1]?.focus();
              e.preventDefault();
            } else if (e.key === 'ArrowLeft' && i > 0) refs.current[i - 1]?.focus();
            else if (e.key === 'ArrowRight' && i < length - 1) refs.current[i + 1]?.focus();
          }}
          onPaste={(e) => {
            e.preventDefault();
            put(0, e.clipboardData.getData('text'));
          }}
        />
      ))}
    </div>
  );
}

export function phoneError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'resend_cooldown' && typeof err.details.retryAfter === 'number') return `Please wait ${err.details.retryAfter} s before requesting another code.`;
    if (err.code === 'invalid_code' && typeof err.details.attemptsLeft === 'number') {
      const n = err.details.attemptsLeft;
      return `That code is not correct. ${n} attempt${n === 1 ? '' : 's'} left.`;
    }
    if (err.code === 'otp_pending') return err.message;
    if (err.code === 'expired') return 'This code has expired. Request a new one.';
    if (err.code === 'no_code') return 'There is no active code for this number. Request a new one.';
    if (err.code === 'too_many_attempts') return 'Too many wrong codes. Request a new one.';
    if (err.code === 'not_allowed') return 'This account is not approved yet. Ask the administrator to add your email.';
    return err.message;
  }
  return 'Something went wrong. Please try again.';
}

/** What we honestly know about a requested text. */
export type DeliveryState = 'pending' | 'sent' | 'delivered' | 'failed' | 'unavailable';

export function deliveryText(state: DeliveryState | null | undefined, error?: string | null): { text: string; tone: 'muted' | 'ok' | 'bad' } {
  switch (state) {
    case 'delivered':
      return { text: 'Delivered to your phone.', tone: 'ok' };
    case 'sent':
      return { text: 'Handed to your mobile network. Waiting for delivery.', tone: 'muted' };
    case 'failed':
      return { text: `The text was not delivered${error ? ` (${error})` : ''}. Check the number, or request a new code after the timer.`, tone: 'bad' };
    case 'pending':
      return { text: 'Code requested. Waiting for the delivery report.', tone: 'muted' };
    default:
      return { text: 'Code requested. Texts usually arrive within a minute.', tone: 'muted' };
  }
}

export function DeliveryLine({ state, error }: { state?: DeliveryState | null; error?: string | null }) {
  const r = deliveryText(state, error);
  return (
    <p className={cn('mb-6 text-xs', r.tone === 'bad' ? 'text-danger' : r.tone === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : 'text-subtle')} aria-live="polite">
      {r.text}
    </p>
  );
}
