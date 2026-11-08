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
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  Input,
  Label,
  Select,
  Spinner,
} from '@/components/ui';
import { downloadAccountExport } from '@/lib/accountExport';
import { api, ApiError } from '@/lib/api';
import { authErrorMessage } from '@/lib/authProviders';
import { paths } from '@/lib/db';
import { useQuery } from '@/lib/hooks';
import { useAuth, useUid } from '@/state/auth';
import { useToast } from '@/state/toast';
import { CodeBoxes, mmss, phoneError, useCountdown } from '../auth/otpUi';
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
  expiresIn?: number;
  resendIn?: number;
}

/**
 * Add, change, verify or remove the account phone number. Codes are sent and
 * checked only by the server; the verified flag comes back as a token claim
 * and a profile field written by the server, never from this component.
 */
export function PhoneManager() {
  const { user, profile, refreshAccess } = useAuth();
  const toast = useToast();
  const passwordAccount = hasPassword(user);
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  const [mode, setMode] = useState<'view' | 'number' | 'code'>('view');
  const [phone, setPhone] = useState('');
  const [masked, setMasked] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const resend = useCountdown();
  const expiry = useCountdown();

  useEffect(() => {
    let live = true;
    api<PhoneStatus>('phone', { json: { action: 'status' } })
      .then((s) => {
        if (!live) return;
        setStatus(s);
        if (s.pending && s.phoneMasked) {
          setMasked(s.phoneMasked);
          expiry.start(s.expiresIn ?? 0);
          setMode('code');
        }
        if (s.resendIn) resend.start(s.resendIn);
      })
      .catch(() => live && setStatus({ configured: false, required: passwordAccount }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    setError('');
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 9) return setError('Enter your mobile number, for example 024 123 4567.');
    setBusy(true);
    try {
      const r = await api<{ phoneMasked: string; expiresIn: number; resendIn: number }>('phone', {
        json: { action: 'send', phone: digits },
      });
      setMasked(r.phoneMasked);
      setCode('');
      expiry.start(r.expiresIn);
      resend.start(r.resendIn);
      setMode('code');
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.code === 'resend_cooldown' &&
        typeof err.details.retryAfter === 'number'
      )
        resend.start(err.details.retryAfter);
      setError(phoneError(err));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (e?: FormEvent) => {
    e?.preventDefault();
    if (code.length !== 6) return setError('Enter the 6-digit code.');
    setError('');
    setBusy(true);
    try {
      await api('phone', { json: { action: 'verify', code } });
      await refreshAccess();
      toast('Phone number verified.', 'success');
      setMode('view');
      setPhone('');
      setCode('');
    } catch (err) {
      setCode('');
      if (err instanceof ApiError && ['too_many_attempts', 'expired', 'no_code'].includes(err.code))
        expiry.start(0);
      setError(phoneError(err));
    } finally {
      setBusy(false);
    }
  };

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
      <div className="py-3 text-sm text-muted">
        Add your phone number to secure your account and enable SMS password recovery.
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
          {mode === 'view' && (
            <Button
              size="sm"
              variant="outline"
              icon={<Smartphone className="size-4" />}
              disabled={status?.configured === false}
              onClick={() => setMode('number')}
            >
              {current ? 'Change' : 'Add number'}
            </Button>
          )}
          {mode === 'view' && current && !passwordAccount && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setConfirmRemove(true)}
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

      {mode === 'number' && (
        <form className="space-y-3 py-4" onSubmit={send} noValidate>
          <div className="grid gap-2 sm:grid-cols-[10rem_1fr]">
            <div>
              <Label htmlFor="phone-country">Country</Label>
              <Select
                id="phone-country"
                value="GH"
                onChange={() => undefined}
                options={[{ value: 'GH', label: 'Ghana (+233)' }]}
              />
            </div>
            <div>
              <Label htmlFor="phone-number">Mobile number</Label>
              <Input
                id="phone-number"
                type="tel"
                inputMode="tel"
                autoComplete="tel-national"
                placeholder="024 123 4567"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>
          </div>
          <p id="phone-country-note" className="text-xs text-muted">
            Only Ghana numbers are supported at the moment. We send one 6-digit code; it expires
            after 5 minutes.
          </p>
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex gap-2">
            <Button type="submit" variant="primary" loading={busy} disabled={resend.left > 0}>
              {resend.left > 0 ? `Send code in ${resend.left} s` : 'Send code'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => (setMode('view'), setError(''))}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {mode === 'code' && (
        <form className="space-y-3 py-4" onSubmit={verify}>
          <p className="text-sm">
            Enter the code sent to <b className="font-medium">{masked}</b>.{' '}
            <span className="text-muted">
              {expiry.left > 0
                ? `Expires in ${mmss(expiry.left)}.`
                : 'The code has expired; request a new one.'}
            </span>
          </p>
          <div className="max-w-xs">
            <CodeBoxes value={code} onChange={setCode} disabled={busy} invalid={Boolean(error)} />
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" loading={busy}>
              Verify
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy || resend.left > 0}
              onClick={() => setMode('number')}
            >
              {resend.left > 0 ? `Resend in ${resend.left} s` : 'Use another number or resend'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => (setMode('view'), setError(''))}>
              Cancel
            </Button>
          </div>
        </form>
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
  password_reset: 'Password reset by text message',
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
};

function RecentActivity() {
  const uid = useUid();
  const { data, loading, error } = useQuery<SecurityEvent>(
    query(paths.securityEvents(uid), orderBy('at', 'desc'), limit(15)),
    [uid],
  );
  return (
    <Section title="Recent activity">
      {loading ? (
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
      <Section title="Sign-in">
        <Row title="Sign-in methods">
          <span className="text-sm text-muted">
            {methods.map(providerLabel).join(', ') || 'Unknown'}
          </span>
        </Row>
        <Row title="Email" description={user?.emailVerified ? 'Verified' : 'Not verified'}>
          <span className="break-all text-sm text-muted">{user?.email}</span>
        </Row>
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
              onClick={() => setPwDialog('change')}
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
              onClick={() => setPwDialog('add')}
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

      <RecentActivity />

      <Section title="Sessions and data">
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
            onClick={() => void exportData()}
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
