import {
  FileText,
  Mail,
  MessageSquareText,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Input,
  Label,
  Select,
  Spinner,
  Textarea,
} from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useAuth } from '@/state/auth';
import { useToast } from '@/state/toast';
import { Page } from '../shell/Page';

type Audience = 'all' | 'approved' | 'pending' | 'selected' | 'me';

interface Template {
  id: string;
  name: string;
  subject: string;
  body: string;
  sms: string;
  updatedAt: number;
  updatedBy: string;
}

interface Sent {
  id: string;
  at: number;
  by: string;
  audience: Audience;
  subject: string | null;
  smsText: string | null;
  bodyPreview: string | null;
  recipients: number;
  status: 'sending' | 'done';
  email: { sent: number; skipped: number; failed: number };
  sms: { sent: number; skipped: number; failed: number; limited: number };
}

interface Overview {
  templates: Template[];
  history: Sent[];
  limits: {
    smsLeftToday: number;
    smsDailyCap: number;
    maxRecipients: number;
    smsMax: number;
    smsConfigured: boolean;
    emailConfigured: boolean;
  };
}

interface Reach {
  total: number;
  email: number;
  sms: number;
  smsLeftToday: number;
}

interface Person {
  uid: string;
  name: string;
  email: string | null;
  status: 'active' | 'suspended' | 'deleted';
  accessStatus: 'pending' | 'approved' | 'rejected';
  phoneVerified: boolean;
  emailVerified: boolean;
}

const AUDIENCES: { value: Audience; label: string }[] = [
  { value: 'all', label: 'All active users' },
  { value: 'approved', label: 'Approved users' },
  { value: 'pending', label: 'Waiting for approval' },
  { value: 'selected', label: 'Choose people…' },
  { value: 'me', label: 'Only me (send a test)' },
];
const AUDIENCE_LABEL = Object.fromEntries(AUDIENCES.map((a) => [a.value, a.label])) as Record<
  Audience,
  string
>;

const fmt = (t: number) =>
  new Date(t).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

/** "Atlas AI: " is added in front of texts that do not start with it (as the server does). */
const smsPreview = (t: string) => (/^atlas ai\b/i.test(t.trim()) ? t.trim() : `Atlas AI: ${t.trim()}`);
const segments = (n: number) => (n <= 160 ? 1 : Math.ceil(n / 153));

type Starter = Pick<Template, 'id' | 'name' | 'sms' | 'subject' | 'body'>;

/** Ready-made messages (not stored; pick one, adjust it, send or save your own copy). */
const STARTERS: Starter[] = [
  {
    id: 'starter-welcome',
    name: 'Welcome',
    sms: 'Hi {name}, welcome to Atlas AI! Sign in any time at chatatlasai.vercel.app and ask anything.',
    subject: 'Welcome to Atlas AI, {name}',
    body: 'Hi {name},\n\nWelcome to Atlas AI. You can ask questions, get help with writing and studies, search the web for current news, and talk to Atlas with your voice.\n\nSign in any time with your email or phone number. If you need help, open Settings › Help & support in the app.\n\nThe Atlas AI team',
  },
  {
    id: 'starter-approved',
    name: 'Account approved',
    sms: 'Hi {name}, your Atlas AI account has been verified and approved. Log in now at chatatlasai.vercel.app with your email or phone number.',
    subject: 'Your Atlas AI account is verified and approved',
    body: 'Hi {name},\n\nGood news: your Atlas AI account has been verified and approved by the administrator.\n\nYou can log in now at chatatlasai.vercel.app with your email address or phone number and your password, and start using Atlas AI right away.\n\nWelcome aboard,\nThe Atlas AI team',
  },
  {
    id: 'starter-maintenance',
    name: 'Scheduled maintenance',
    sms: 'Hi {name}, Atlas AI will be briefly unavailable tonight from 10 pm to 11 pm for maintenance. Thank you for your patience.',
    subject: 'Scheduled maintenance tonight',
    body: 'Hi {name},\n\nAtlas AI will be briefly unavailable tonight from 10 pm to 11 pm while we carry out maintenance and improvements.\n\nYour chats and settings are safe, and everything will be back to normal afterwards. Thank you for your patience.\n\nThe Atlas AI team',
  },
  {
    id: 'starter-restored',
    name: 'Service restored',
    sms: 'Hi {name}, Atlas AI is working normally again. Sorry for the interruption and thank you for your patience.',
    subject: 'Atlas AI is working normally again',
    body: 'Hi {name},\n\nThe problem that affected Atlas AI earlier has been fixed, and everything is working normally again.\n\nWe are sorry for the interruption. If anything still does not work as expected, please report it from Settings › Help & support.\n\nThe Atlas AI team',
  },
  {
    id: 'starter-feature',
    name: 'New feature',
    sms: 'Hi {name}, something new is live on Atlas AI. Sign in at chatatlasai.vercel.app to try it.',
    subject: 'New on Atlas AI',
    body: 'Hi {name},\n\nWe have just added something new to Atlas AI, and we think you will like it.\n\nSign in to try it out, and tell us what you think from Settings › Help & support.\n\nThe Atlas AI team',
  },
  {
    id: 'starter-reviewing',
    name: 'Request under review',
    sms: 'Hi {name}, thank you for signing up for Atlas AI. Your account is being reviewed and we will text you as soon as it is approved.',
    subject: 'Your Atlas AI request is being reviewed',
    body: 'Hi {name},\n\nThank you for signing up for Atlas AI. Your account is being reviewed by the administrator.\n\nAs soon as it is approved, you will get a text message and an email, and you can start using Atlas AI right away.\n\nThe Atlas AI team',
  },
  {
    id: 'starter-verify',
    name: 'Verify your email',
    sms: 'Hi {name}, please verify your email in Atlas AI (Settings › Security) so you can recover your account and get security alerts.',
    subject: 'Please verify your email address',
    body: 'Hi {name},\n\nYour email address is not verified yet. Verifying it lets you recover your account if you forget your password, and makes sure security alerts reach you.\n\nSign in to Atlas AI and open Settings › Security › Email address to get a code.\n\nThe Atlas AI team',
  },
  {
    id: 'starter-security',
    name: 'Security reminder',
    sms: 'Atlas AI will never ask for your password or verification codes. Do not share them with anyone, even someone claiming to be from us.',
    subject: 'Keep your Atlas AI account safe',
    body: 'Hi {name},\n\nA quick reminder: Atlas AI will never ask for your password or your verification codes by phone, text or email.\n\nIf someone asks for them, even if they claim to be from Atlas AI, do not share them. You can review your signed-in devices any time in Settings › Security.\n\nThe Atlas AI team',
  },
  {
    id: 'starter-feedback',
    name: 'Ask for feedback',
    sms: 'Hi {name}, how is Atlas AI working for you? Share your thoughts in the app under Settings › Help & support. Thank you!',
    subject: 'How is Atlas AI working for you?',
    body: 'Hi {name},\n\nWe would love to hear how Atlas AI is working for you: what you like, what is missing, and what we could do better.\n\nYou can send your thoughts any time from Settings › Help & support in the app. Every message is read.\n\nThank you,\nThe Atlas AI team',
  },
];

function Check({
  checked,
  onChange,
  children,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm',
        checked ? 'border-accent bg-accent-soft' : 'border-border',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <input
        type="checkbox"
        className="size-4 accent-[var(--accent)]"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {children}
    </label>
  );
}

function TemplateDialog({
  initial,
  smsMax,
  onClose,
  onSaved,
}: {
  initial: Partial<Template> | null;
  smsMax: number;
  onClose: () => void;
  onSaved: (t: Template) => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(initial?.name ?? '');
  const [sms, setSms] = useState(initial?.sms ?? '');
  const [subject, setSubject] = useState(initial?.subject ?? '');
  const [body, setBody] = useState(initial?.body ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setError('');
    setBusy(true);
    try {
      const r = await api<{ template: Template }>('admin', {
        json: { action: 'messageTemplateSave', template: { id: initial?.id, name, sms, subject, body } },
      });
      toast('Template saved.', 'success');
      onSaved(r.template);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The template could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={initial?.id ? 'Edit template' : 'New template'}
      description="Fill in the text message, the email, or both. Use {name} for the person’s first name."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>
            Save template
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <Label htmlFor="t-name">Template name</Label>
          <Input
            id="t-name"
            value={name}
            maxLength={80}
            placeholder="e.g. Scheduled maintenance"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="t-sms" hint={`${smsPreview(sms).length} / ${smsMax} characters`}>
            Text message
          </Label>
          <Textarea
            id="t-sms"
            rows={3}
            maxLength={smsMax}
            value={sms}
            onChange={(e) => setSms(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="t-subject">Email subject</Label>
          <Input
            id="t-subject"
            value={subject}
            maxLength={150}
            onChange={(e) => setSubject(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="t-body" hint="Leave a blank line between paragraphs.">
            Email message
          </Label>
          <Textarea
            id="t-body"
            rows={6}
            maxLength={5000}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
    </Dialog>
  );
}

function PeoplePicker({
  selected,
  onChange,
  max,
}: {
  selected: string[];
  onChange: (uids: string[]) => void;
  max: number;
}) {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ users: Person[] }>('admin', { json: { action: 'list' } })
      .then((r) => setPeople(r.users.filter((u) => u.status === 'active')))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Users could not be loaded.'));
  }, []);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (people ?? []).filter(
      (p) => !s || p.name.toLowerCase().includes(s) || (p.email ?? '').toLowerCase().includes(s),
    );
  }, [people, q]);

  if (error) return <p className="text-sm text-danger">{error}</p>;
  if (!people)
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted">
        <Spinner className="size-4" /> Loading users
      </div>
    );
  const set = new Set(selected);
  const toggle = (uid: string, on: boolean) =>
    onChange(on ? [...selected, uid].slice(0, max) : selected.filter((x) => x !== uid));

  return (
    <div className="rounded-xl border border-border">
      <div className="flex items-center gap-2 border-b border-border px-3">
        <Search className="size-4 text-muted" />
        <input
          className="h-10 flex-1 bg-transparent text-sm outline-none"
          placeholder="Search by name or email"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <span className="text-xs text-muted tabular-nums">{selected.length} chosen</span>
      </div>
      <ul className="max-h-64 divide-y divide-border overflow-y-auto">
        {shown.map((p) => (
          <li key={p.uid}>
            <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm hover:bg-surface-2">
              <input
                type="checkbox"
                className="size-4 accent-[var(--accent)]"
                checked={set.has(p.uid)}
                onChange={(e) => toggle(p.uid, e.target.checked)}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{p.name}</span>
                <span className="block truncate text-xs text-muted">{p.email ?? 'No email'}</span>
              </span>
              <span className="flex shrink-0 gap-1">
                {p.emailVerified && <Badge tone="neutral">Email</Badge>}
                {p.phoneVerified && <Badge tone="neutral">SMS</Badge>}
              </span>
            </label>
          </li>
        ))}
        {!shown.length && <li className="px-3 py-4 text-sm text-muted">No matching users.</li>}
      </ul>
    </div>
  );
}

export default function MessagesPage() {
  const { admin } = useAuth();
  const toast = useToast();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [loading, setLoading] = useState(false);

  const [audience, setAudience] = useState<Audience>('me');
  const [uids, setUids] = useState<string[]>([]);
  const [useSms, setUseSms] = useState(true);
  const [useEmail, setUseEmail] = useState(true);
  const [sms, setSms] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [reach, setReach] = useState<Reach | null>(null);
  const [formError, setFormError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState<Partial<Template> | null>(null);
  const [removing, setRemoving] = useState<Template | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api<Overview>('admin', { json: { action: 'messages' } }));
    } catch (err) {
      setError({
        code: err instanceof ApiError ? err.code : 'failed',
        message: err instanceof ApiError ? err.message : 'Messages could not be loaded.',
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (admin) void load();
  }, [admin, load]);

  // How many people the chosen group reaches, by channel.
  useEffect(() => {
    if (!admin) return;
    if (audience === 'selected' && !uids.length) return setReach({ total: 0, email: 0, sms: 0, smsLeftToday: data?.limits.smsLeftToday ?? 0 });
    let live = true;
    setReach(null);
    const t = window.setTimeout(() => {
      api<Reach>('admin', {
        json: { action: 'messageAudience', audience, uids: audience === 'selected' ? uids : undefined },
      })
        .then((r) => live && setReach(r))
        .catch(() => live && setReach(null));
    }, 300);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [admin, audience, uids, data?.limits.smsLeftToday]);

  // While a send is in progress, refresh the history a few times.
  const sending = data?.history.some((h) => h.status === 'sending');
  useEffect(() => {
    if (!sending) return;
    let n = 0;
    const t = window.setInterval(() => {
      if (++n > 10) return window.clearInterval(t);
      void api<Overview>('admin', { json: { action: 'messages' } }).then(setData).catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(t);
  }, [sending]);

  if (!admin) return <Navigate to="/settings" replace />;

  const limits = data?.limits;
  const smsOn = useSms && Boolean(limits?.smsConfigured);
  const emailOn = useEmail && Boolean(limits?.emailConfigured);
  const smsCount = smsOn && reach ? reach.sms : 0;
  const emailCount = emailOn && reach ? reach.email : 0;
  const smsLen = smsPreview(sms).length;

  const applyTemplate = (t: Starter) => {
    setPicked(t.id);
    setFormError('');
    setSms(t.sms);
    setSubject(t.subject);
    setBody(t.body);
    setUseSms(Boolean(t.sms));
    setUseEmail(Boolean(t.subject && t.body));
    toast(`“${t.name}” loaded. Edit it if you like, then send.`, 'success');
  };

  const check = (): string => {
    if (!smsOn && !emailOn) return 'Choose a text message, an email, or both.';
    if (smsOn && !sms.trim()) return 'Write the text message.';
    if (emailOn && (!subject.trim() || !body.trim())) return 'The email needs a subject and a message.';
    if (audience === 'selected' && !uids.length) return 'Choose at least one person.';
    if (!reach) return 'Still counting recipients. Try again in a moment.';
    if (!smsCount && !emailCount) return 'Nobody in this group can receive this message.';
    return '';
  };

  const send = async () => {
    try {
      await api('admin', {
        json: {
          action: 'messageSend',
          audience,
          uids: audience === 'selected' ? uids : undefined,
          sms: smsOn ? sms : null,
          email: emailOn ? { subject, body } : null,
          confirm: true,
        },
      });
      setConfirming(false);
      toast(audience === 'me' ? 'Test sent to you.' : 'Message is being sent.', 'success');
      if (audience !== 'me') {
        setSms('');
        setSubject('');
        setBody('');
      }
      void load();
    } catch (err) {
      setConfirming(false);
      setFormError(err instanceof ApiError ? err.message : 'The message could not be sent.');
    }
  };

  const refresh = (
    <Button
      size="sm"
      variant="ghost"
      icon={<RefreshCw className={cn('size-4', loading && 'animate-spin')} />}
      onClick={() => void load()}
      disabled={loading}
    >
      Refresh
    </Button>
  );

  return (
    <Page title="Messages" back="/settings" wide actions={refresh}>
      <div className="mx-auto w-full max-w-5xl">
        <div className="mb-5 hidden items-center justify-between lg:flex">
          <h1 className="text-xl font-semibold tracking-tight">Messages</h1>
          {refresh}
        </div>
        {error?.code === 'admin_unconfigured' ? (
          <EmptyState icon={<ShieldCheck className="size-6" />} title="Not available yet">
            {error.message}
          </EmptyState>
        ) : error ? (
          <EmptyState
            icon={<Send className="size-6" />}
            title="Messages could not be loaded"
            action={<Button onClick={() => void load()}>Try again</Button>}
          >
            {error.message}
          </EmptyState>
        ) : !data || !limits ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
            <Spinner className="size-4" /> Loading messages
          </div>
        ) : (
          <div className="space-y-6">
            {/* templates */}
            <section>
              <div className="mb-2.5 flex items-center justify-between gap-2">
                <div>
                  <h2 className="text-base font-semibold">Templates</h2>
                  <p className="text-xs text-muted">Pick one to fill in the message, then adjust it.</p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Plus className="size-4" />}
                  onClick={() => setEditing({})}
                >
                  New
                </Button>
              </div>
              <div className="-mx-4 flex snap-x gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 lg:grid-cols-4">
                {[...data.templates.map((t) => ({ t, own: true })), ...STARTERS.map((t) => ({ t, own: false }))].map(
                  ({ t, own }) => (
                    <div
                      key={t.id}
                      className={cn(
                        'group relative w-60 shrink-0 snap-start rounded-xl border p-3 transition-colors sm:w-auto',
                        picked === t.id
                          ? 'border-accent bg-accent-soft'
                          : 'border-border hover:border-accent/60 hover:bg-surface-2',
                      )}
                    >
                      <button
                        type="button"
                        className="block w-full text-left"
                        onClick={() => applyTemplate(t)}
                      >
                        <span className={cn('flex items-center gap-1.5', own && 'pr-14')}>
                          <span className="truncate text-sm font-medium">{t.name}</span>
                        </span>
                        <span className="mt-1 line-clamp-2 block text-xs text-muted">
                          {t.sms || t.subject}
                        </span>
                        <span className="mt-2 flex flex-wrap gap-1">
                          {own ? <Badge tone="accent">Yours</Badge> : <Badge tone="neutral">Ready-made</Badge>}
                          {t.sms && <Badge tone="neutral">SMS</Badge>}
                          {t.subject && <Badge tone="neutral">Email</Badge>}
                        </span>
                      </button>
                      {own && (
                        <div className="absolute top-2 right-2 flex">
                          <button
                            className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-fg"
                            aria-label={`Edit ${t.name}`}
                            onClick={() => setEditing(t as Template)}
                          >
                            <Pencil className="size-3.5" />
                          </button>
                          <button
                            className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-danger"
                            aria-label={`Delete ${t.name}`}
                            onClick={() => setRemoving(t as Template)}
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                  ),
                )}
              </div>
            </section>

            {/* composer */}
            <section className="space-y-4 rounded-2xl border border-border p-4 sm:p-5">
              <div>
                <h2 className="text-base font-semibold">Send a message</h2>
                <p className="mt-1 text-sm text-muted">
                  Texts go only to verified phone numbers and emails only to verified addresses.
                  People who turned off announcements are skipped. Use {'{name}'} for the person’s
                  first name.
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)] sm:items-end">
                <div>
                  <Label htmlFor="m-aud">Send to</Label>
                  <Select id="m-aud" value={audience} onChange={setAudience} options={AUDIENCES} />
                </div>
                <p className="text-sm text-muted sm:pb-2.5" aria-live="polite">
                  {reach ? (
                    <>
                      {reach.total} {reach.total === 1 ? 'person' : 'people'} · {reach.email} by
                      email · {reach.sms} by text
                    </>
                  ) : (
                    <span className="inline-flex items-center gap-2">
                      <Spinner className="size-3.5" /> Counting recipients
                    </span>
                  )}
                </p>
              </div>
              {audience === 'selected' && (
                <PeoplePicker selected={uids} onChange={setUids} max={limits.maxRecipients} />
              )}

              <div className="grid gap-2 sm:grid-cols-2">
                <Check checked={smsOn} onChange={setUseSms} disabled={!limits.smsConfigured}>
                  <MessageSquareText className="size-4 text-accent" /> Text message (SMS)
                  {!limits.smsConfigured && <span className="text-xs text-muted">· not set up</span>}
                </Check>
                <Check checked={emailOn} onChange={setUseEmail} disabled={!limits.emailConfigured}>
                  <Mail className="size-4 text-accent" /> Email
                  {!limits.emailConfigured && <span className="text-xs text-muted">· not set up</span>}
                </Check>
              </div>

              <div className={cn('grid gap-4', smsOn && emailOn && 'lg:grid-cols-2')}>
                {smsOn && (
                  <div>
                    <Label
                      htmlFor="m-sms"
                      hint={`${smsLen} / ${limits.smsMax} · ${segments(smsLen)} SMS each · ${limits.smsLeftToday} of ${limits.smsDailyCap} left today`}
                    >
                      Text message
                    </Label>
                    <Textarea
                      id="m-sms"
                      rows={emailOn ? 9 : 4}
                      maxLength={limits.smsMax}
                      value={sms}
                      placeholder="e.g. Hi {name}, Atlas AI will be offline for maintenance tonight from 10 pm to 11 pm."
                      onChange={(e) => setSms(e.target.value)}
                    />
                  </div>
                )}
                {emailOn && (
                  <div className="space-y-3">
                    <div>
                      <Label htmlFor="m-subject">Email subject</Label>
                      <Input
                        id="m-subject"
                        value={subject}
                        maxLength={150}
                        onChange={(e) => setSubject(e.target.value)}
                      />
                    </div>
                    <div>
                      <Label htmlFor="m-body" hint="Blank line between paragraphs.">
                        Email message
                      </Label>
                      <Textarea
                        id="m-body"
                        rows={5}
                        maxLength={5000}
                        value={body}
                        onChange={(e) => setBody(e.target.value)}
                      />
                    </div>
                  </div>
                )}
              </div>

              {formError && <p className="text-sm text-danger">{formError}</p>}
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button
                  variant="primary"
                  className="w-full sm:w-auto"
                  icon={<Send className="size-4" />}
                  onClick={() => {
                    const problem = check();
                    setFormError(problem);
                    if (!problem) setConfirming(true);
                  }}
                >
                  {audience === 'me' ? 'Send test to me' : 'Review and send'}
                </Button>
                <Button
                  variant="ghost"
                  className="w-full sm:w-auto"
                  icon={<FileText className="size-4" />}
                  onClick={() => setEditing({ sms, subject, body, name: '' })}
                >
                  Save as template
                </Button>
              </div>
            </section>

            {/* history */}
            <section>
              <h2 className="mb-3 text-base font-semibold">Recently sent</h2>
              {data.history.length ? (
                <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border">
                  {data.history.map((h) => (
                    <li key={h.id} className="grid gap-1 px-4 py-3 text-sm sm:grid-cols-[9rem_minmax(0,1fr)_auto] sm:gap-4">
                      <div className="text-xs text-muted tabular-nums">{fmt(h.at)}</div>
                      <div className="min-w-0">
                        <div className="truncate font-medium">
                          {h.subject ?? h.smsText ?? 'Message'}
                        </div>
                        <div className="truncate text-xs text-muted">
                          {AUDIENCE_LABEL[h.audience]} · {h.recipients}{' '}
                          {h.recipients === 1 ? 'person' : 'people'} · by {h.by}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-start gap-1 sm:justify-end">
                        {h.status === 'sending' ? (
                          <Badge tone="warn">Sending</Badge>
                        ) : (
                          <>
                            {h.subject && (
                              <Badge tone={h.email.failed ? 'warn' : 'accent'}>
                                {h.email.sent} emailed
                                {h.email.failed ? ` · ${h.email.failed} failed` : ''}
                              </Badge>
                            )}
                            {h.smsText && (
                              <Badge tone={h.sms.failed || h.sms.limited ? 'warn' : 'accent'}>
                                {h.sms.sent} texted
                                {h.sms.failed ? ` · ${h.sms.failed} failed` : ''}
                                {h.sms.limited ? ` · ${h.sms.limited} over today’s limit` : ''}
                              </Badge>
                            )}
                          </>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted">Nothing sent yet.</p>
              )}
            </section>
          </div>
        )}
      </div>

      {editing && limits && (
        <TemplateDialog
          initial={editing}
          smsMax={limits.smsMax}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
      <ConfirmDialog
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        title="Delete template?"
        message={`“${removing?.name ?? ''}” will be removed. Messages already sent are not affected.`}
        onConfirm={async () => {
          if (!removing) return;
          try {
            await api('admin', { json: { action: 'messageTemplateDelete', id: removing.id } });
            toast('Template deleted.', 'success');
          } catch (err) {
            toast(err instanceof ApiError ? err.message : 'The template could not be deleted.', 'error');
          }
          setRemoving(null);
          void load();
        }}
      />
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={audience === 'me' ? 'Send a test to yourself?' : 'Send this message?'}
        confirmLabel="Send now"
        danger={false}
        message={
          <span className="block space-y-2">
            <span className="block">
              To: <b>{AUDIENCE_LABEL[audience]}</b>
            </span>
            {emailOn && <span className="block">{emailCount} email{emailCount === 1 ? '' : 's'}</span>}
            {smsOn && (
              <span className="block">
                {smsCount} text message{smsCount === 1 ? '' : 's'} ({segments(smsLen)} SMS each). Texts
                use your SMS credit; {limits?.smsLeftToday ?? 0} are left today.
                {smsCount > (limits?.smsLeftToday ?? 0) && (
                  <span className="mt-1 block text-warn">
                    Only {limits?.smsLeftToday ?? 0} can be sent today; the rest will be skipped.
                  </span>
                )}
              </span>
            )}
            <span className="block text-muted">This cannot be undone.</span>
          </span>
        }
        onConfirm={send}
      />
    </Page>
  );
}
