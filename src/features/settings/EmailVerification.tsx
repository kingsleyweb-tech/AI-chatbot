import { CheckCircle2, MailCheck, MailWarning } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Badge, Button, Dialog } from '@/components/ui';
import { useAuth } from '@/state/auth';
import { useToast } from '@/state/toast';
import { EmailVerifyPanel } from '../auth/EmailVerifyPanel';
import { Row } from './parts';

/** Verify the account email from Settings (a code is sent when the dialog opens). */
export function VerifyEmailDialog({
  open,
  onClose,
  reason,
}: {
  open: boolean;
  onClose: () => void;
  reason?: string | null;
}) {
  const toast = useToast();
  if (!open) return null;
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={
        <span className="inline-flex items-center gap-2">
          <MailCheck className="size-5 text-accent" /> Verify your email
        </span>
      }
    >
      {reason && <p className="mb-3 text-sm text-fg">{reason}</p>}
      <EmailVerifyPanel
        autoSend
        onVerified={() => {
          onClose();
          toast('Email verified.', 'success');
        }}
        secondary={(busy) => (
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
            Not now
          </Button>
        )}
      />
    </Dialog>
  );
}

/**
 * Actions that need a verified email (password, sign-in methods, phone
 * changes, data export). `guard(fn)` runs `fn` when the email is verified and
 * otherwise opens the verification dialog; the server enforces the same rule
 * where the action reaches it.
 */
export function useVerifiedEmailGuard() {
  const { user } = useAuth();
  const [reason, setReason] = useState<string | null>(null);
  const verified = user?.emailVerified !== false;
  const guard =
    (fn: () => void, what = 'do this') =>
    () => {
      if (verified) fn();
      else setReason(`Verify your email address to ${what}.`);
    };
  const dialog: ReactNode = (
    <VerifyEmailDialog open={reason !== null} reason={reason} onClose={() => setReason(null)} />
  );
  return { verified, guard, dialog };
}

/** Settings › Security: the account's email address and its verification state. */
export function EmailAddressRow({ google }: { google: boolean }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const verified = Boolean(user?.emailVerified);
  return (
    <>
      <Row
        title="Email address"
        description={
          <>
            <span className="block break-all text-fg/90">{user?.email}</span>
            <span className="mt-0.5 block">
              {verified
                ? google
                  ? 'Verified by Google. Used for sign-in, security alerts and support replies.'
                  : 'Used for sign-in, password recovery, security alerts and support replies.'
                : 'Not verified yet. Verify it to unlock password recovery by email, security alerts and all security settings.'}
            </span>
          </>
        }
      >
        {verified ? (
          <Badge tone="accent">
            <CheckCircle2 className="size-3.5" /> Verified
          </Badge>
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Badge tone="warn">
              <MailWarning className="size-3.5" /> Not verified
            </Badge>
            <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
              Verify email
            </Button>
          </div>
        )}
      </Row>
      <VerifyEmailDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
