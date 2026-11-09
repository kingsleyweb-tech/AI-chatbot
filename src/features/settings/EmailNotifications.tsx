import { Laptop, Smartphone, Tablet } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Button, Spinner, Switch } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/state/toast';
import { Row, Section } from './parts';

type PrefKey = 'newLogin' | 'suspicious' | 'security' | 'support' | 'supportSms' | 'announcements';
type Prefs = Record<PrefKey, boolean>;

const PREFS: { key: PrefKey; title: string; description: string }[] = [
  {
    key: 'newLogin',
    title: 'Sign-in alerts',
    description:
      'An email each time your account is signed in to, with the device and approximate location.',
  },
  {
    key: 'suspicious',
    title: 'Suspicious activity',
    description: 'Unusual sign-ins and repeated failed password attempts.',
  },
  {
    key: 'security',
    title: 'Security updates',
    description:
      'Changes such as a new phone number, a sign-in method added or devices signed out.',
  },
  {
    key: 'support',
    title: 'Support updates by email',
    description: 'Replies and status changes on the reports you send to Atlas Support.',
  },
  {
    key: 'supportSms',
    title: 'Support updates by text message',
    description:
      'A text to your verified phone number when a report is resolved or the team needs your reply.',
  },
  { key: 'announcements', title: 'Announcements', description: 'Occasional news about Atlas AI.' },
];

/** Optional email alerts. Verification codes, password reset and password-changed emails are always sent. */
export function EmailNotifications() {
  const toast = useToast();
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [configured, setConfigured] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    api<{ prefs: Prefs; configured: boolean }>('account', { json: { action: 'emailPrefs' } })
      .then((r) => {
        if (!live) return;
        setPrefs(r.prefs);
        setConfigured(r.configured);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, []);

  const change = async (key: PrefKey, value: boolean) => {
    if (!prefs) return;
    const before = prefs;
    setPrefs({ ...prefs, [key]: value });
    try {
      const r = await api<{ prefs: Prefs }>('account', {
        json: { action: 'setEmailPrefs', prefs: { [key]: value } },
      });
      setPrefs(r.prefs);
    } catch {
      setPrefs(before);
      toast('Your notification preference could not be saved. Try again.', 'error');
    }
  };

  return (
    <Section title="Notifications">
      {failed ? (
        <div className="py-3 text-sm text-muted">Notification preferences could not be loaded.</div>
      ) : !prefs ? (
        <div className="flex items-center gap-2 py-3 text-sm text-muted">
          <Spinner className="size-4" /> Loading
        </div>
      ) : (
        <>
          {!configured && (
            <div className="py-2 text-sm text-muted">
              Email sending is not set up on this server yet, so no emails are sent for now.
            </div>
          )}
          {PREFS.map((p) => (
            <Row key={p.key} title={p.title} description={p.description}>
              <Switch
                label={p.title}
                checked={prefs[p.key]}
                onChange={(v) => void change(p.key, v)}
              />
            </Row>
          ))}
          <div className="py-2.5 text-xs text-muted">
            Verification codes, password reset and password-changed emails are always sent, because
            they protect your account.
          </div>
        </>
      )}
    </Section>
  );
}

interface Device {
  id: string;
  device: string;
  os: string;
  browser: string;
  location: string | null;
  lastSeen: number;
  firstSeen: number;
  current: boolean;
}

const DeviceIcon = ({ kind }: { kind: string }) =>
  kind === 'Phone' ? (
    <Smartphone className="size-4" />
  ) : kind === 'Tablet' ? (
    <Tablet className="size-4" />
  ) : (
    <Laptop className="size-4" />
  );

/** Devices this account has signed in from (recorded once per sign-in). */
export function RecognisedDevices() {
  const toast = useToast();
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState('');

  const load = () =>
    api<{ devices: Device[] }>('account', { json: { action: 'devices' } })
      .then((r) => setDevices(r.devices))
      .catch(() => setFailed(true));
  useEffect(() => {
    void load();
  }, []);

  const forget = async (d: Device) => {
    setBusy(d.id);
    try {
      await api('account', { json: { action: 'forgetDevice', id: d.id } });
      setDevices((list) => list?.filter((x) => x.id !== d.id) ?? null);
      toast('Device removed. Its next sign-in will send you a new-device alert.', 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'The device could not be removed.', 'error');
    } finally {
      setBusy('');
    }
  };

  return (
    <Section title="Recognised devices">
      {failed ? (
        <div className="py-3 text-sm text-muted">Devices could not be loaded.</div>
      ) : !devices ? (
        <div className="flex items-center gap-2 py-3 text-sm text-muted">
          <Spinner className="size-4" /> Loading
        </div>
      ) : devices.length === 0 ? (
        <div className="py-3 text-sm text-muted">Devices appear here after your next sign-in.</div>
      ) : (
        <>
          {devices.map((d) => (
            <div key={d.id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="flex min-w-0 items-start gap-3">
                <span className="mt-0.5 text-muted">
                  <DeviceIcon kind={d.device} />
                </span>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-[15px]">
                    <span className="truncate">
                      {d.browser} on {d.os}
                    </span>
                    {d.current && <Badge tone="accent">This device</Badge>}
                  </div>
                  <div className="truncate text-xs text-muted">
                    {[
                      d.location,
                      `Last sign-in ${new Date(d.lastSeen).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </div>
              </div>
              {!d.current && (
                <Button
                  size="sm"
                  variant="ghost"
                  loading={busy === d.id}
                  onClick={() => void forget(d)}
                >
                  Remove
                </Button>
              )}
            </div>
          ))}
          <div className="py-2.5 text-xs text-muted">
            Removing a device does not sign it out. To end every session, use Sign out everywhere
            below.
          </div>
        </>
      )}
    </Section>
  );
}
