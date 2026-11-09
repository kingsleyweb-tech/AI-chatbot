import { updateDoc } from 'firebase/firestore';
import { MailCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Button, Dialog } from '@/components/ui';
import { paths } from '@/lib/db';
import { useAuth } from '@/state/auth';
import { useToast } from '@/state/toast';
import { EmailVerifyPanel } from '../auth/EmailVerifyPanel';
import { emailReminderDue, emailRemindAgainMs } from './emailReminderRules';

const SHOWN_KEY = 'atlas.emailReminderShown';
const PHONE_SHOWN_KEY = 'atlas.phoneReminderShown';
/** let the first screen settle (and other prompts open) before deciding */
const SETTLE_MS = 2500;

function shownThisSession(): boolean {
  try {
    // one reminder per session: not after the phone reminder either
    return (
      sessionStorage.getItem(SHOWN_KEY) === '1' || sessionStorage.getItem(PHONE_SHOWN_KEY) === '1'
    );
  } catch {
    return false;
  }
}
function markShown() {
  try {
    sessionStorage.setItem(SHOWN_KEY, '1');
  } catch {
    /* storage unavailable: at worst it shows once more on the next load */
  }
}

/**
 * "Verify your email": for accounts that skipped the email step at sign-up.
 * At most once per browser session, never over another dialog, never on the
 * security settings page, and after "Skip for now" not again for 3 days
 * (a week once it has been skipped twice). Stops once the email is verified.
 */
export function EmailReminder() {
  const { user, profile, access } = useAuth();
  const toast = useToast();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const onSecurity = pathname.startsWith('/settings/security');
  const due =
    access === 'allowed' &&
    Boolean(user) &&
    emailReminderDue(user?.emailVerified, profile, Date.now());

  useEffect(() => {
    if (!due || open || onSecurity || shownThisSession()) return;
    const t = window.setTimeout(() => {
      if (document.querySelector('[role="dialog"]') || shownThisSession()) return;
      markShown();
      setOpen(true);
    }, SETTLE_MS);
    return () => window.clearTimeout(t);
  }, [due, open, onSecurity]);

  // verified in another tab or in Settings meanwhile
  useEffect(() => {
    if (open && !due) setOpen(false);
  }, [open, due]);

  const skip = async () => {
    setOpen(false);
    if (!user) return;
    const skips = (profile?.emailReminderSkips ?? 0) + 1;
    await updateDoc(paths.user(user.uid), {
      emailReminderNextAt: Date.now() + emailRemindAgainMs(skips - 1),
      emailReminderSkips: skips,
    }).catch(() => undefined);
  };

  if (!open) return null;
  return (
    <Dialog
      open
      onClose={() => setOpen(false)}
      size="sm"
      title={
        <span className="inline-flex items-center gap-2">
          <MailCheck className="size-5 text-accent" /> Verify your email
        </span>
      }
    >
      <p className="mb-3 text-sm text-muted">
        Password recovery, sign-in alerts and replies to your support reports are sent to this
        address. Verify it to keep your account secure.
      </p>
      <EmailVerifyPanel
        onVerified={() => {
          setOpen(false);
          toast('Email verified.', 'success');
        }}
        secondary={(busy) => (
          <Button type="button" variant="ghost" disabled={busy} onClick={() => void skip()}>
            Skip for now
          </Button>
        )}
      />
    </Dialog>
  );
}
