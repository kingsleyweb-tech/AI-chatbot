import { serverTimestamp, updateDoc } from 'firebase/firestore';
import { ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Button, Dialog } from '@/components/ui';
import { paths } from '@/lib/db';
import { useAuth } from '@/state/auth';
import { useToast } from '@/state/toast';
import { PhoneVerifyFlow } from '../settings/PhoneVerifyFlow';
import { reminderDue, REMIND_AGAIN_MS } from './phoneReminderRules';

const SHOWN_KEY = 'atlas.phoneReminderShown';
/** let the first screen settle (and other prompts open) before deciding */
const SETTLE_MS = 2500;

function shownThisSession(): boolean {
  try {
    return sessionStorage.getItem(SHOWN_KEY) === '1';
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
 * "Secure your account": asks people without a verified phone number to add
 * one. At most once per browser session, never over another dialog, never on
 * the phone settings page, and not again for 14 days after "Skip for now".
 * Once a number is verified it stops (and becomes due again only if the
 * number is removed). Phone verification is a recovery and security
 * measure; it is not two-step sign-in.
 */
export function PhoneReminder() {
  const { user, profile, access } = useAuth();
  const toast = useToast();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const onPhoneSettings = pathname.startsWith('/settings/account');
  const due = access === 'allowed' && Boolean(user) && reminderDue(profile, Date.now());

  useEffect(() => {
    if (!due || open || onPhoneSettings || shownThisSession()) return;
    const t = window.setTimeout(() => {
      // another dialog (search, a confirmation, the inactivity warning) is open: try on a later page
      if (document.querySelector('[role="dialog"]') || shownThisSession()) return;
      markShown();
      setOpen(true);
    }, SETTLE_MS);
    return () => window.clearTimeout(t);
  }, [due, open, onPhoneSettings]);

  // verified in another tab or in Settings meanwhile
  useEffect(() => {
    if (open && !due) setOpen(false);
  }, [open, due]);

  const skip = async () => {
    setOpen(false);
    if (!user) return;
    // Persistent: the reminder may come back after 14 days.
    await updateDoc(paths.user(user.uid), {
      phoneReminderDismissedAt: serverTimestamp(),
      phoneReminderNextAt: Date.now() + REMIND_AGAIN_MS,
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
          <ShieldCheck className="size-5 text-accent" /> Secure your account
        </span>
      }
    >
      <p className="mb-4 text-sm text-muted">Add your phone number to strengthen your account security and make account recovery easier.</p>
      <PhoneVerifyFlow
        submitLabel="Continue"
        onVerified={() => {
          setOpen(false);
          toast('Phone number verified.', 'success');
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
