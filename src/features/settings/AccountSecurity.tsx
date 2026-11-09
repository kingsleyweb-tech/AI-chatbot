import {
  EmailAuthProvider,
  GoogleAuthProvider,
  linkWithCredential,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  updatePassword,
  type User,
} from 'firebase/auth';
import { limit, orderBy, query, type Timestamp } from 'firebase/firestore';
import { Download, KeyRound, LogOut, ShieldCheck, Smartphone } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, ConfirmDialog, Dialog, Input, Label, Spinner } from '@/components/ui';
import { AnalyticsSwitch } from '@/components/AnalyticsConsent';
import { downloadAccountExport } from '@/lib/accountExport';
import { analyticsAvailable } from '@/lib/analyticsConsent';
import { api, ApiError } from '@/lib/api';
import { authErrorMessage } from '@/lib/authProviders';
import { paths } from '@/lib/db';
import { useQuery } from '@/lib/hooks';
import { useAuth, useUid } from '@/state/auth';
import { useToast } from '@/state/toast';
import { phoneError, type DeliveryState } from '../auth/otpUi';
import { EmailNotifications, RecognisedDevices } from './EmailNotifications';
import { EmailAddressRow, useVerifiedEmailGuard } from './EmailVerification';
import { PhoneVerifyFlow, type PendingCode } from './PhoneVerifyFlow';
import { maskPhone, providerLabel, Row, Section } from './parts';

const hasPassword = (user: User | null) =>
  Boolean(user?.providerData.some((p) => p.providerId === 'password'));
const strongEnough = (p: string) => p.length >= 8 && /[A-Za-z]/.test(p) && /\d/.test(p);

/* ----------------------------------------------------------------- phone */

interface PhoneStatus {
  configured: boolean;
  required: boolean;
  pending?: boolean;
  phoneMasked?: string | null;
  phoneDisplay?: string | null;
  codeLength?: number;
  expiresIn?: number;
  resendIn?: number;
  delivery?: { state: DeliveryState; error: string | null } | null;
}

/**
 * Add, change, verify or remove the account phone number. Codes are sent and
 * checked only by the server; the verified flag comes back as a token claim
 * and a profile field written by the server, never from this component.
 * Changing the number keeps the current one until the new one is verified.
 */
export function PhoneManager() {
  const { user, profile, refreshAccess } = useAuth();
  const toast = useToast();
  const passwordAccount = hasPassword(user);
  const { guard, dialog: verifyDialog } = useVerifiedEmailGuard();
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  const [pending, setPending] = useState<PendingCode | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    let live = true;
    api<PhoneStatus>('phone', { json: { action: 'status' } })
      .then((s) => {
        if (!live) return;
        setStatus(s);
        if (s.pending && s.phoneMasked) {
          setPending({
            phoneMasked: s.phoneDisplay ?? s.phoneMasked,
            codeLength: s.codeLength ?? 6,
            expiresIn: s.expiresIn ?? 0,
            resendIn: s.resendIn ?? 0,
            delivery: s.delivery ?? null,
          });
          setEditing(true);
        }
      })
      .catch(() => live && setStatus({ configured: false, required: passwordAccount }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const remove = async () => {
    setBusy(true);
    try {
      await api('phone', { json: { action: 'remove' } });
      await refreshAccess();
      toast('Phone number removed.', 'success');
    } catch (err) {
      toast(phoneError(err), 'error');
    } finally {
      setBusy(false);
      setConfirmRemove(false);
    }
  };

  const current = profile?.phoneNumber ? maskPhone(profile.phoneNumber) : null;
  const verified = Boolean(profile?.phoneVerified && current);

  return (
    <Section title="Phone number">
      {verifyDialog}
      <div className="py-3 text-sm text-muted">
        Add your phone number to secure your account and enable SMS password recovery. This is not
        two-step sign-in: your password or Google account still signs you in.
      </div>
      <Row
        title={current ?? 'No phone number'}
        description={
          verified
            ? 'Verified by text message'
            : passwordAccount
              ? 'Required for email and password sign-in'
              : 'Optional for Google sign-in'
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          {verified ? (
            <Badge tone="accent">
              <ShieldCheck className="size-3.5" /> Verified
            </Badge>
          ) : current ? (
            <Badge tone="warn">Not verified</Badge>
          ) : null}
          {!editing && (
            <Button
              size="sm"
              variant="outline"
              icon={<Smartphone className="size-4" />}
              disabled={status?.configured === false}
              onClick={
                verified
                  ? guard(() => setEditing(true), 'change your phone number')
                  : () => setEditing(true)
              }
            >
              {current ? 'Change' : 'Add number'}
            </Button>
          )}
          {!editing && current && !passwordAccount && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={guard(() => setConfirmRemove(true), 'remove your phone number')}
            >
              Remove
            </Button>
          )}
        </div>
      </Row>
      {status === null && (
        <div className="flex items-center gap-2 py-3 text-sm text-muted">
          <Spinner className="size-4" /> Checking text message service
        </div>
      )}
      {status?.configured === false && (
        <div className="py-3 text-sm text-muted">
          Text message verification is not configured on the server yet, so numbers cannot be added
          or changed right now.
        </div>
      )}

      {editing && (
        <div className="py-4">
          {current && (
            <p className="mb-3 text-xs text-muted">
              Your current number stays on the account until the new one is verified.
            </p>
          )}
          <PhoneVerifyFlow
            pending={pending}
            onVerified={() => {
              toast('Phone number verified.', 'success');
              setPending(null);
              setEditing(false);
            }}
            secondary={(b) => (
              <Button
                type="button"
                variant="ghost"
                disabled={b}
                onClick={() => (setEditing(false), setPending(null))}
              >
                Cancel
              </Button>
            )}
          />
        </div>
      )}

      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        onConfirm={() => void remove()}
        title="Remove phone number?"
        message="You will no longer be able to reset a password by text message. You can add a number again at any time."
        confirmLabel="Remove"
        danger
      />
    </Section>
  );
}

/* -------------------------------------------------------------- password */

function PasswordDialog({
  open,
  onClose,
  mode,
}: {
  open: boolean;
  onClose: () => void;
  mode: 'change' | 'add';
}) {
  const { user } = useAuth();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setCurrent('');
    setNext('');
    setConfirm('');
    setError('');
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user?.email) return setError('This account has no email address.');
    if (!strongEnough(next))
      return setError('Use at least 8 characters with letters and at least one number.');
    if (next !== confirm) return setError('The passwords do not match.');
    setBusy(true);
    setError('');
    try {
      if (mode === 'change') {
        await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, current));
        await updatePassword(user, next);
        await api('account', { json: { action: 'passwordChanged' } }).catch(() => undefined);
        toast('Password changed. Other devices will need to sign in again.', 'success');
      } else {
        // Links a password to this same account (same uid): no second account is created.
        const credential = EmailAuthProvider.credential(user.email, next);
        try {
          await linkWithCredential(user, credential);
        } catch (err) {
          if ((err as { code?: string }).code !== 'auth/requires-recent-login') throw err;
          await reauthenticateWithPopup(user, new GoogleAuthProvider());
          await linkWithCredential(user, credential);
        }
        await api('account', { json: { action: 'providerLinked', provider: 'password' } }).catch(
          () => undefined,
        );
        toast('Password added. You can now also sign in with your email.', 'success');
      }
      reset();
      onClose();
    } catch (err) {
      const c = (err as { code?: string }).code;
      setError(
        c === 'auth/provider-already-linked'
          ? 'This account already has a password.'
          : c === 'auth/email-already-in-use' || c === 'auth/credential-already-in-use'
            ? 'Another account already uses this email with a password. Contact the administrator; no account was changed.'
            : authErrorMessage(err),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => (reset(), onClose())}
      title={mode === 'change' ? 'Change password' : 'Add a password'}
      description={
        mode === 'change'
          ? 'Enter your current password, then choose a new one. Other devices will be signed out.'
          : 'Sign in with your email as well as Google. Email and password sign-in requires a verified phone number.'
      }
    >
      <form className="space-y-3" onSubmit={submit}>
        {mode === 'change' && (
          <div>
            <Label htmlFor="pw-current">Current password</Label>
            <Input
              id="pw-current"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </div>
        )}
        <div>
          <Label htmlFor="pw-new">New password</Label>
          <Input
            id="pw-new"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="pw-confirm">Confirm new password</Label>
          <Input
            id="pw-confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={() => (reset(), onClose())}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy}>
            {mode === 'change' ? 'Change password' : 'Add password'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/* -------------------------------------------------------------- activity */

interface SecurityEvent {
  id: string;
  type: string;
  at?: Timestamp;
  device?: string | null;
  by?: string | null;
  detail?: string | null;
}

const EVENT_LABELS: Record<string, string> = {
  login: 'Signed in',
  login_failed: 'Failed sign-in attempt',
  logout: 'Signed out',
  logout_inactivity: 'Signed out after 60 minutes of inactivity',
  password_reset: 'Password reset with a code',
  email_verified: 'Email address verified',
  device_removed: 'Device removed from recognised devices',
  password_changed: 'Password changed',
  phone_verified: 'Phone number verified',
  phone_changed: 'Phone number changed',
  phone_removed: 'Phone number removed',
  provider_linked: 'Sign-in method added',
  sessions_revoked: 'Signed out of all devices',
  account_suspended: 'Account suspended',
  account_reactivated: 'Account reactivated',
  account_deletion_scheduled: 'Account scheduled for deletion',
  account_restored: 'Account restored',
  data_exported: 'Data exported',
  access_requested: 'Access requested',
  access_approved: 'Access approved',
  access_rejected: 'Access not approved',
  unauthorized_access: 'Blocked attempt to open an administrator page',
};

/** collapsed: the newest few; "View all" loads the full history (capped) */
const ACTIVITY_SHOWN = 5;
const ACTIVITY_ALL = 100;

function RecentActivity() {
  const uid = useUid();
  const [all, setAll] = useState(false);
  const {
    data: rows,
    loading,
    error,
  } = useQuery<SecurityEvent>(
    // one extra row tells us whether there is more to show
    query(
      paths.securityEvents(uid),
      orderBy('at', 'desc'),
      limit(all ? ACTIVITY_ALL : ACTIVITY_SHOWN + 1),
    ),
    [uid, all],
  );
  const more = rows.length > ACTIVITY_SHOWN;
  const data = all ? rows : rows.slice(0, ACTIVITY_SHOWN);
  return (
    <Section title="Recent activity">
      {loading && rows.length === 0 ? (
        <div className="flex items-center gap-2 py-3 text-sm text-muted">
          <Spinner className="size-4" /> Loading
        </div>
      ) : error ? (
        <div className="py-3 text-sm text-muted">Activity could not be loaded.</div>
      ) : data.length === 0 ? (
        <div className="py-3 text-sm text-muted">
          No security activity recorded yet. Sign-ins, password and phone changes appear here.
        </div>
      ) : (
        data.map((e) => (
          <div key={e.id} className="flex items-start justify-between gap-4 py-2.5">
            <div className="min-w-0">
              <div
                className={
                  e.type === 'login_failed' || e.type === 'account_suspended'
                    ? 'text-[15px] text-danger'
                    : 'text-[15px]'
                }
              >
                {EVENT_LABELS[e.type] ?? e.type}
              </div>
              <div className="truncate text-xs text-muted">
                {[e.device, e.by === 'admin' ? 'by an administrator' : null, e.detail]
                  .filter(Boolean)
                  .join(' · ') || ' '}
              </div>
            </div>
            <time className="shrink-0 text-xs text-muted tabular-nums">
              {e.at?.toDate
                ? e.at
                    .toDate()
                    .toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
                : ''}
            </time>
          </div>
        ))
      )}
      {(more || all) && !error && (
        <div className="flex justify-center pt-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setAll((v) => !v)}
            disabled={loading && all && rows.length <= ACTIVITY_SHOWN + 1}
          >
            {all ? 'Show less' : 'View all activity'}
          </Button>
        </div>
      )}
    </Section>
  );
}

/* -------------------------------------------------------------- section */

export function SecuritySection() {
  const { user, profile, signOut } = useAuth();
  const uid = useUid();
  const toast = useToast();
  const [pwDialog, setPwDialog] = useState<'change' | 'add' | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [exporting, setExporting] = useState('');
  const methods = user?.providerData.map((p) => p.providerId) ?? [];
  const passwordAccount = hasPassword(user);
  const googleLinked = methods.includes('google.com');
  const status = profile?.accountStatus ?? 'active';
  const { guard, dialog: verifyDialog } = useVerifiedEmailGuard();

  const revoke = async () => {
    setRevoking(true);
    try {
      await api('account', { json: { action: 'revokeSessions' } });
      toast('Signed out of every device. Sign in again to continue.', 'success');
      await signOut();
    } catch (err) {
      toast(
        err instanceof ApiError && err.code === 'admin_unconfigured'
          ? 'This needs the server service account, which is not configured yet.'
          : 'Could not sign out other devices. Try again.',
        'error',
      );
    } finally {
      setRevoking(false);
      setConfirmRevoke(false);
    }
  };

  const exportData = async () => {
    setExporting('Preparing');
    try {
      const data = await downloadAccountExport(uid, setExporting);
      toast(
        data.skipped.length
          ? `Export saved. Not included: ${data.skipped.join(', ')}.`
          : 'Export saved to your downloads.',
        data.skipped.length ? 'info' : 'success',
      );
    } catch {
      toast('The export could not be created. Try again.', 'error');
    } finally {
      setExporting('');
    }
  };

  return (
    <>
      {verifyDialog}
      <Section title="Sign-in">
        <Row title="Sign-in methods">
          <span className="text-sm text-muted">
            {methods.map(providerLabel).join(', ') || 'Unknown'}
          </span>
        </Row>
        <EmailAddressRow google={googleLinked} />
        <Row title="Account status">
          <Badge tone={status === 'active' ? 'accent' : 'danger'}>
            {status === 'active' ? 'Active' : status[0].toUpperCase() + status.slice(1)}
          </Badge>
        </Row>
        {passwordAccount ? (
          <Row title="Password" description="Changing it signs out your other devices.">
            <Button
              size="sm"
              variant="outline"
              icon={<KeyRound className="size-4" />}
              onClick={guard(() => setPwDialog('change'), 'change your password')}
            >
              Change password
            </Button>
          </Row>
        ) : (
          <Row
            title="Password"
            description={
              googleLinked
                ? 'You sign in with Google, so Google manages your password. Change it in your Google Account. You can also add a separate password for email sign-in.'
                : 'No password is set for this account.'
            }
          >
            <Button
              size="sm"
              variant="outline"
              icon={<KeyRound className="size-4" />}
              onClick={guard(() => setPwDialog('add'), 'add a password')}
            >
              Add a password
            </Button>
          </Row>
        )}
      </Section>

      <Section title="Phone number">
        <Row
          title={profile?.phoneNumber ? maskPhone(profile.phoneNumber) : 'Not added'}
          description={
            profile?.phoneVerified
              ? 'Verified by text message. Used for password recovery.'
              : 'Add a number to enable password recovery by text message.'
          }
        >
          <Link to="/settings/account" className="text-sm text-accent hover:underline">
            Manage
          </Link>
        </Row>
      </Section>

      <RecognisedDevices />

      <EmailNotifications />

      <RecentActivity />

      <Section title="Sessions and data">
        <Row
          title="Usage analytics"
          description={
            analyticsAvailable
              ? 'Lets Google Analytics record how the app is used, in this browser only. Off unless you allow it; turning it off removes its cookies.'
              : 'Analytics is not used on this site.'
          }
        >
          <AnalyticsSwitch />
        </Row>
        <Row
          title="Sign out of all devices"
          description="Ends every session, including this one. You will need to sign in again everywhere."
        >
          <Button
            size="sm"
            variant="outline"
            icon={<LogOut className="size-4" />}
            loading={revoking}
            onClick={() => setConfirmRevoke(true)}
          >
            Sign out everywhere
          </Button>
        </Row>
        <Row
          title="Export your data"
          description={
            exporting
              ? `Collecting: ${exporting}`
              : 'Download your profile, conversations, memories, projects and activity as a JSON file.'
          }
        >
          <Button
            size="sm"
            variant="outline"
            icon={<Download className="size-4" />}
            loading={Boolean(exporting)}
            onClick={guard(() => void exportData(), 'export your data')}
          >
            Export
          </Button>
        </Row>
      </Section>

      {pwDialog && <PasswordDialog open mode={pwDialog} onClose={() => setPwDialog(null)} />}
      <ConfirmDialog
        open={confirmRevoke}
        onClose={() => setConfirmRevoke(false)}
        onConfirm={() => void revoke()}
        title="Sign out everywhere?"
        message="Every device signed in to your account, including this one, will be signed out."
        confirmLabel="Sign out everywhere"
        danger
      />
    </>
  );
}
