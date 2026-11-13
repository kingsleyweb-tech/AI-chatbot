import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  LifeBuoy,
  Mail,
  Megaphone,
  MessageSquareText,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
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
import { READY_TEMPLATES, TEMPLATE_CATEGORIES, unfilled, type TemplateKind } from './messageTemplates';

type Audience = 'all' | 'approved' | 'pending' | 'selected' | 'me';
type Mode = 'support' | 'announcement';

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
  purpose?: Mode;
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

/** A template card: ready-made or saved by an administrator. */
interface Card {
  id: string;
  name: string;
  hint: string;
  sms: string;
  subject: string;
  body: string;
  own?: Template;
}

const AUDIENCES: { value: Exclude<Audience, 'selected'> | 'selected'; label: string }[] = [
  { value: 'all', label: 'All active users' },
  { value: 'approved', label: 'Approved users' },
  { value: 'pending', label: 'Waiting for approval' },
  { value: 'selected', label: 'Choose people…' },
  { value: 'me', label: 'Only me (send a test)' },
];
const AUDIENCE_LABEL = Object.fromEntries(AUDIENCES.map((a) => [a.value, a.label])) as Record<Audience, string>;
const OWN = 'own';

const fmt = (t: number) =>
  new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** "Atlas AI: " is added in front of texts that do not start with it (as the server does). */
const smsPreview = (t: string) => (/^atlas ai\b/i.test(t.trim()) ? t.trim() : `Atlas AI: ${t.trim()}`);
const segments = (n: number) => (n <= 160 ? 1 : Math.ceil(n / 153));
const firstName = (name: string) => name.trim().split(/\s+/)[0]?.slice(0, 40) || 'there';
const personalise = (text: string, name: string) => text.replace(/\{name\}/gi, firstName(name));

function useUsers(enabled: boolean) {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!enabled || people) return;
    api<{ users: Person[] }>('admin', { json: { action: 'list' } })
      .then((r) => setPeople(r.users.filter((u) => u.status !== 'deleted')))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Users could not be loaded.'));
  }, [enabled, people]);
  return { people, error };
}

const matches = (p: Person, q: string) => {
  const s = q.trim().toLowerCase();
  return !s || p.name.toLowerCase().includes(s) || (p.email ?? '').toLowerCase().includes(s);
};

/* ------------------------------------------------------------------ small building blocks */

function Panel({ step, title, description, children, className }: { step?: number; title: string; description?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-2xl border border-border bg-surface p-4 sm:p-5', className)}>
      <header className="mb-4 flex items-start gap-3">
        {step !== undefined && (
          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent-soft text-xs font-semibold text-accent tabular-nums">
            {step}
          </span>
        )}
        <div className="min-w-0">
          <h2 className="text-base font-semibold leading-6">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
        </div>
      </header>
      {children}
    </section>
  );
}

function Check({ checked, onChange, children, disabled }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; disabled?: boolean }) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm',
        checked ? 'border-accent bg-accent-soft' : 'border-border',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

/** Category chips and the templates in the chosen category. */
function TemplateLibrary({
  kind,
  own,
  picked,
  onPick,
  onNew,
  onEdit,
  onDelete,
}: {
  kind: TemplateKind;
  own: Template[];
  picked: string | null;
  onPick: (c: Card) => void;
  onNew: () => void;
  onEdit: (t: Template) => void;
  onDelete: (t: Template) => void;
}) {
  const categories = TEMPLATE_CATEGORIES.filter((c) => c.kind === kind);
  const [category, setCategory] = useState(categories[0].id);
  const tabs = [...categories, ...(own.length ? [{ id: OWN, kind, label: `Your templates (${own.length})` }] : [])];
  const cards: Card[] =
    category === OWN
      ? own.map((t) => ({ id: t.id, name: t.name, hint: t.sms || t.subject, sms: t.sms, subject: t.subject, body: t.body, own: t }))
      : READY_TEMPLATES.filter((t) => t.category === category);

  return (
    <div>
      <div className="-mx-1 mb-3 flex gap-1.5 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Template categories">
        {tabs.map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={category === c.id}
            onClick={() => setCategory(c.id)}
            className={cn(
              'shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
              category === c.id ? 'border-accent bg-accent text-white' : 'border-border text-muted hover:border-accent/60 hover:text-fg',
            )}
          >
            {c.label}
          </button>
        ))}
        <button type="button" onClick={onNew} className="inline-flex shrink-0 items-center gap-1 rounded-full border border-dashed border-border px-3 py-1.5 text-xs font-medium text-muted hover:border-accent/60 hover:text-fg">
          <Plus className="size-3.5" /> New template
        </button>
      </div>
      <ul className="grid gap-2 sm:grid-cols-2">
        {cards.map((t) => (
          <li key={t.id} className="relative">
            <button
              type="button"
              onClick={() => onPick(t)}
              aria-pressed={picked === t.id}
              className={cn(
                'block h-full w-full rounded-xl border p-3 text-left transition-colors',
                picked === t.id ? 'border-accent bg-accent-soft' : 'border-border hover:border-accent/60 hover:bg-surface-2',
                t.own && 'pr-16',
              )}
            >
              <span className="flex items-center gap-1.5 text-sm font-medium">
                {picked === t.id && <CheckCircle2 className="size-4 shrink-0 text-accent" />}
                <span className="truncate">{t.name}</span>
              </span>
              <span className="mt-1 line-clamp-2 block text-xs text-muted">{t.hint}</span>
              <span className="mt-2 flex flex-wrap gap-1">
                {t.sms && <Badge>SMS</Badge>}
                {t.subject && <Badge>Email</Badge>}
                {unfilled(t.sms, t.subject, t.body).length > 0 && <Badge tone="warn">Fill in details</Badge>}
              </span>
            </button>
            {t.own && (
              <div className="absolute top-2 right-2 flex">
                <button className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-fg" aria-label={`Edit ${t.name}`} onClick={() => onEdit(t.own!)}>
                  <Pencil className="size-3.5" />
                </button>
                <button className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-danger" aria-label={`Delete ${t.name}`} onClick={() => onDelete(t.own!)}>
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One person, chosen by search. */
function PersonFinder({ selected, onSelect }: { selected: Person | null; onSelect: (p: Person | null) => void }) {
  const { people, error } = useUsers(true);
  const [q, setQ] = useState('');
  const shown = useMemo(() => (people ?? []).filter((p) => matches(p, q)).slice(0, 50), [people, q]);

  if (selected)
    return (
      <div className="flex items-start gap-3 rounded-xl border border-accent bg-accent-soft p-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-surface text-accent">
          <UserRound className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{selected.name}</div>
          <div className="truncate text-xs text-muted">{selected.email ?? 'No email address'}</div>
          <div className="mt-2 flex flex-wrap gap-1">
            <Badge tone={selected.emailVerified ? 'accent' : 'neutral'}>{selected.emailVerified ? 'Email verified' : 'Email not verified'}</Badge>
            <Badge tone={selected.phoneVerified ? 'accent' : 'neutral'}>{selected.phoneVerified ? 'Phone verified' : 'No verified phone'}</Badge>
            {selected.status === 'suspended' && <Badge tone="danger">Suspended</Badge>}
            {selected.accessStatus === 'pending' && <Badge tone="warn">Waiting for approval</Badge>}
            {selected.accessStatus === 'rejected' && <Badge tone="warn">Request declined</Badge>}
          </div>
        </div>
        <Button size="sm" variant="ghost" icon={<X className="size-4" />} onClick={() => onSelect(null)}>
          Change
        </Button>
      </div>
    );

  if (error) return <p className="text-sm text-danger">{error}</p>;
  return (
    <div className="rounded-xl border border-border">
      <div className="flex items-center gap-2 border-b border-border px-3">
        <Search className="size-4 text-muted" />
        <input
          className="h-10 flex-1 bg-transparent text-sm outline-none"
          placeholder="Search by name or email"
          aria-label="Search users"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {!people ? (
        <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted">
          <Spinner className="size-4" /> Loading users
        </div>
      ) : (
        <ul className="max-h-72 divide-y divide-border overflow-y-auto">
          {shown.map((p) => (
            <li key={p.uid}>
              <button type="button" onClick={() => onSelect(p)} className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-surface-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{p.name}</span>
                  <span className="block truncate text-xs text-muted">{p.email ?? 'No email'}</span>
                </span>
                <span className="flex shrink-0 gap-1">
                  {p.status === 'suspended' && <Badge tone="danger">Suspended</Badge>}
                  {p.emailVerified && <Badge>Email</Badge>}
                  {p.phoneVerified && <Badge>SMS</Badge>}
                </span>
              </button>
            </li>
          ))}
          {!shown.length && <li className="px-3 py-4 text-sm text-muted">No matching users.</li>}
        </ul>
      )}
    </div>
  );
}

/** Several people (announcements to a chosen group). */
function PeoplePicker({ selected, onChange, max }: { selected: string[]; onChange: (uids: string[]) => void; max: number }) {
  const { people, error } = useUsers(true);
  const [q, setQ] = useState('');
  const shown = useMemo(() => (people ?? []).filter((p) => p.status === 'active' && matches(p, q)), [people, q]);
  if (error) return <p className="text-sm text-danger">{error}</p>;
  if (!people)
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted">
        <Spinner className="size-4" /> Loading users
      </div>
    );
  const set = new Set(selected);
  const toggle = (uid: string, on: boolean) => onChange(on ? [...selected, uid].slice(0, max) : selected.filter((x) => x !== uid));
  return (
    <div className="rounded-xl border border-border">
      <div className="flex items-center gap-2 border-b border-border px-3">
        <Search className="size-4 text-muted" />
        <input className="h-10 flex-1 bg-transparent text-sm outline-none" placeholder="Search by name or email" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="text-xs text-muted tabular-nums">{selected.length} chosen</span>
      </div>
      <ul className="max-h-64 divide-y divide-border overflow-y-auto">
        {shown.map((p) => (
          <li key={p.uid}>
            <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm hover:bg-surface-2">
              <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={set.has(p.uid)} onChange={(e) => toggle(p.uid, e.target.checked)} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{p.name}</span>
                <span className="block truncate text-xs text-muted">{p.email ?? 'No email'}</span>
              </span>
              <span className="flex shrink-0 gap-1">
                {p.emailVerified && <Badge>Email</Badge>}
                {p.phoneVerified && <Badge>SMS</Badge>}
              </span>
            </label>
          </li>
        ))}
        {!shown.length && <li className="px-3 py-4 text-sm text-muted">No matching users.</li>}
      </ul>
    </div>
  );
}

function TemplateDialog({ initial, smsMax, onClose, onSaved }: { initial: Partial<Template> | null; smsMax: number; onClose: () => void; onSaved: (t: Template) => void }) {
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
      const r = await api<{ template: Template }>('admin', { json: { action: 'messageTemplateSave', template: { id: initial?.id, name, sms, subject, body } } });
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
      description="Fill in the text message, the email, or both. Use {name} for the person’s first name and [square brackets] for details to fill in before sending."
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
          <Input id="t-name" value={name} maxLength={80} placeholder="e.g. Payment question" onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="t-sms" hint={`${smsPreview(sms).length} / ${smsMax} characters`}>
            Text message
          </Label>
          <Textarea id="t-sms" rows={3} maxLength={smsMax} value={sms} onChange={(e) => setSms(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="t-subject">Email subject</Label>
          <Input id="t-subject" value={subject} maxLength={150} onChange={(e) => setSubject(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="t-body" hint="Leave a blank line between paragraphs.">
            Email message
          </Label>
          <Textarea id="t-body" rows={6} maxLength={5000} value={body} onChange={(e) => setBody(e.target.value)} />
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ composer */

interface Draft {
  sms: string;
  subject: string;
  body: string;
  useSms: boolean;
  useEmail: boolean;
}
const EMPTY: Draft = { sms: '', subject: '', body: '', useSms: true, useEmail: true };

function Composer({
  draft,
  setDraft,
  limits,
  previewName,
  channelNote,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  limits: Overview['limits'];
  previewName: string;
  channelNote?: { sms?: string; email?: string };
}) {
  const smsOn = draft.useSms && limits.smsConfigured;
  const emailOn = draft.useEmail && limits.emailConfigured;
  const smsLen = smsPreview(draft.sms).length;
  const set = (p: Partial<Draft>) => setDraft({ ...draft, ...p });
  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2">
        <Check checked={smsOn} onChange={(v) => set({ useSms: v })} disabled={!limits.smsConfigured}>
          <MessageSquareText className="size-4 text-accent" /> Text message (SMS)
          {!limits.smsConfigured && <span className="text-xs text-muted">· not set up</span>}
        </Check>
        <Check checked={emailOn} onChange={(v) => set({ useEmail: v })} disabled={!limits.emailConfigured}>
          <Mail className="size-4 text-accent" /> Email
          {!limits.emailConfigured && <span className="text-xs text-muted">· not set up</span>}
        </Check>
      </div>
      {(channelNote?.sms || channelNote?.email) && (
        <ul className="space-y-1 rounded-xl bg-warn-soft px-3.5 py-2.5 text-xs text-warn">
          {channelNote.sms && smsOn && <li>Text: {channelNote.sms}</li>}
          {channelNote.email && emailOn && <li>Email: {channelNote.email}</li>}
        </ul>
      )}

      {smsOn && (
        <div>
          <Label htmlFor="m-sms" hint={`${smsLen} / ${limits.smsMax} · ${segments(smsLen)} SMS · ${limits.smsLeftToday} of ${limits.smsDailyCap} left today`}>
            Text message
          </Label>
          <Textarea
            id="m-sms"
            rows={3}
            maxLength={limits.smsMax}
            value={draft.sms}
            placeholder="Pick a template above, or write your own. {name} becomes the first name."
            onChange={(e) => set({ sms: e.target.value })}
          />
          {draft.sms.trim() && (
            <div className="mt-2 flex">
              <p className="max-w-md rounded-2xl rounded-bl-md bg-surface-2 px-3.5 py-2 text-sm leading-relaxed">
                <span className="mb-0.5 block text-[11px] font-medium text-muted">Preview</span>
                {personalise(smsPreview(draft.sms), previewName)}
              </p>
            </div>
          )}
        </div>
      )}
      {emailOn && (
        <div className="space-y-3">
          <div>
            <Label htmlFor="m-subject">Email subject</Label>
            <Input id="m-subject" value={draft.subject} maxLength={150} onChange={(e) => set({ subject: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="m-body" hint="Blank line between paragraphs.">
              Email message
            </Label>
            <Textarea id="m-body" rows={10} maxLength={5000} value={draft.body} onChange={(e) => set({ body: e.target.value })} />
          </div>
        </div>
      )}
    </div>
  );
}

/** What is wrong with the draft, or '' when it can be sent. */
function draftProblem(d: Draft, limits: Overview['limits']): string {
  const smsOn = d.useSms && limits.smsConfigured;
  const emailOn = d.useEmail && limits.emailConfigured;
  if (!smsOn && !emailOn) return 'Choose a text message, an email, or both.';
  if (smsOn && !d.sms.trim()) return 'Write the text message.';
  if (emailOn && (!d.subject.trim() || !d.body.trim())) return 'The email needs a subject and a message.';
  const open = unfilled(smsOn ? d.sms : '', emailOn ? d.subject : '', emailOn ? d.body : '');
  if (open.length) return `Fill in or remove ${open.slice(0, 3).join(', ')} before sending.`;
  return '';
}

/* ------------------------------------------------------------------ page */

export default function MessagesPage() {
  const { admin } = useAuth();
  const toast = useToast();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<Mode>('support');

  // Contact a user
  const [person, setPerson] = useState<Person | null>(null);
  const [supportDraft, setSupportDraft] = useState<Draft>(EMPTY);
  const [supportPicked, setSupportPicked] = useState<string | null>(null);
  const [personReach, setPersonReach] = useState<Reach | null>(null);

  // Announcement
  const [audience, setAudience] = useState<Audience>('me');
  const [uids, setUids] = useState<string[]>([]);
  const [newsDraft, setNewsDraft] = useState<Draft>(EMPTY);
  const [newsPicked, setNewsPicked] = useState<string | null>(null);
  const [reach, setReach] = useState<Reach | null>(null);

  const [formError, setFormError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState<Partial<Template> | null>(null);
  const [removing, setRemoving] = useState<Template | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api<Overview>('admin', { json: { action: 'messages' } }));
    } catch (err) {
      setError({ code: err instanceof ApiError ? err.code : 'failed', message: err instanceof ApiError ? err.message : 'Messages could not be loaded.' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (admin) void load();
  }, [admin, load]);

  // Which channels reach the chosen person (their support switches apply).
  useEffect(() => {
    if (!admin || !person) return setPersonReach(null);
    let live = true;
    setPersonReach(null);
    api<Reach>('admin', { json: { action: 'messageAudience', audience: 'selected', uids: [person.uid], purpose: 'support' } })
      .then((r) => live && setPersonReach(r))
      .catch(() => live && setPersonReach(null));
    return () => {
      live = false;
    };
  }, [admin, person]);

  // How many people an announcement reaches, by channel.
  useEffect(() => {
    if (!admin || mode !== 'announcement') return;
    if (audience === 'selected' && !uids.length) return setReach({ total: 0, email: 0, sms: 0, smsLeftToday: data?.limits.smsLeftToday ?? 0 });
    let live = true;
    setReach(null);
    const t = window.setTimeout(() => {
      api<Reach>('admin', { json: { action: 'messageAudience', audience, uids: audience === 'selected' ? uids : undefined } })
        .then((r) => live && setReach(r))
        .catch(() => live && setReach(null));
    }, 300);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [admin, mode, audience, uids, data?.limits.smsLeftToday]);

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
  const support = mode === 'support';
  const draft = support ? supportDraft : newsDraft;
  const smsOn = Boolean(limits && draft.useSms && limits.smsConfigured);
  const emailOn = Boolean(limits && draft.useEmail && limits.emailConfigured);
  const target = support ? personReach : reach;
  const smsCount = smsOn && target ? target.sms : 0;
  const emailCount = emailOn && target ? target.email : 0;
  const smsLen = smsPreview(draft.sms).length;

  const pick = (c: Card) => {
    const d: Draft = { sms: c.sms, subject: c.subject, body: c.body, useSms: Boolean(c.sms), useEmail: Boolean(c.subject && c.body) };
    setFormError('');
    if (support) {
      setSupportDraft(d);
      setSupportPicked(c.id);
    } else {
      setNewsDraft(d);
      setNewsPicked(c.id);
    }
    toast(`“${c.name}” loaded. Check it, then send.`, 'success');
  };

  // Why a channel will not reach the chosen person.
  const personNote = (() => {
    if (!person || !personReach) return undefined;
    return {
      sms: personReach.sms ? undefined : person.phoneVerified ? 'they turned off support texts, so no text will be sent.' : 'no verified phone number, so no text will be sent.',
      email: personReach.email ? undefined : person.emailVerified ? 'they turned off support emails, so no email will be sent.' : 'no verified email address, so no email will be sent.',
    };
  })();

  const check = (): string => {
    if (!limits) return 'Still loading.';
    if (support && !person) return 'Choose the person first.';
    const problem = draftProblem(draft, limits);
    if (problem) return problem;
    if (!support && audience === 'selected' && !uids.length) return 'Choose at least one person.';
    if (!target) return 'Still checking who can receive it. Try again in a moment.';
    if (!smsCount && !emailCount) return support ? `${person?.name ?? 'This person'} cannot receive this message on the chosen channels.` : 'Nobody in this group can receive this message.';
    return '';
  };

  const send = async () => {
    try {
      await api('admin', {
        json: support
          ? { action: 'messageSend', purpose: 'support', audience: 'selected', uids: [person!.uid], sms: smsOn ? draft.sms : null, email: emailOn ? { subject: draft.subject, body: draft.body } : null, confirm: true }
          : { action: 'messageSend', purpose: 'announcement', audience, uids: audience === 'selected' ? uids : undefined, sms: smsOn ? draft.sms : null, email: emailOn ? { subject: draft.subject, body: draft.body } : null, confirm: true },
      });
      setConfirming(false);
      if (support) {
        toast(`Message sent to ${person!.name}.`, 'success');
        setSupportDraft(EMPTY);
        setSupportPicked(null);
      } else {
        toast(audience === 'me' ? 'Test sent to you.' : 'Message is being sent.', 'success');
        if (audience !== 'me') {
          setNewsDraft(EMPTY);
          setNewsPicked(null);
        }
      }
      void load();
    } catch (err) {
      setConfirming(false);
      setFormError(err instanceof ApiError ? err.message : 'The message could not be sent.');
    }
  };

  const refresh = (
    <Button size="sm" variant="ghost" icon={<RefreshCw className={cn('size-4', loading && 'animate-spin')} />} onClick={() => void load()} disabled={loading}>
      Refresh
    </Button>
  );

  const library = (kind: TemplateKind, picked: string | null) =>
    data && (
      <TemplateLibrary
        key={kind}
        kind={kind}
        own={data.templates}
        picked={picked}
        onPick={pick}
        onNew={() => setEditing({})}
        onEdit={(t) => setEditing(t)}
        onDelete={(t) => setRemoving(t)}
      />
    );

  const sendBar = limits && (
    <div className="space-y-3 border-t border-border pt-4">
      {formError && (
        <p className="flex items-start gap-2 text-sm text-danger" role="alert">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {formError}
        </p>
      )}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
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
          {support ? (person ? `Send to ${firstName(person.name)}` : 'Send') : audience === 'me' ? 'Send test to me' : 'Review and send'}
        </Button>
        <Button variant="ghost" className="w-full sm:w-auto" icon={<FileText className="size-4" />} onClick={() => setEditing({ sms: draft.sms, subject: draft.subject, body: draft.body, name: '' })}>
          Save as template
        </Button>
      </div>
    </div>
  );

  return (
    <Page title="Messages" wide actions={refresh}>
      <div className="mx-auto w-full max-w-6xl">
        <div className="mb-5 hidden items-center justify-between lg:flex">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Messages</h1>
            <p className="text-sm text-muted">Help one person with a problem, or send news to many.</p>
          </div>
          {refresh}
        </div>
        {error?.code === 'admin_unconfigured' ? (
          <EmptyState icon={<ShieldCheck className="size-6" />} title="Not available yet">
            {error.message}
          </EmptyState>
        ) : error ? (
          <EmptyState icon={<Send className="size-6" />} title="Messages could not be loaded" action={<Button onClick={() => void load()}>Try again</Button>}>
            {error.message}
          </EmptyState>
        ) : !data || !limits ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
            <Spinner className="size-4" /> Loading messages
          </div>
        ) : (
          <div className="space-y-6">
            {/* mode switch */}
            <div className="grid grid-cols-2 gap-1 rounded-2xl border border-border bg-surface-2 p-1 sm:inline-grid sm:w-auto" role="tablist" aria-label="Message type">
              {(
                [
                  { id: 'support', label: 'Contact a user', icon: <LifeBuoy className="size-4" /> },
                  { id: 'announcement', label: 'Announcement', icon: <Megaphone className="size-4" /> },
                ] as const
              ).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="tab"
                  aria-selected={mode === m.id}
                  onClick={() => {
                    setMode(m.id);
                    setFormError('');
                  }}
                  className={cn(
                    'inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition-colors',
                    mode === m.id ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg',
                  )}
                >
                  {m.icon} {m.label}
                </button>
              ))}
            </div>

            {support ? (
              <div className="grid gap-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:items-start">
                <div className="space-y-5">
                  <Panel step={1} title="Who needs help?" description="Find their account by name or email.">
                    <PersonFinder
                      selected={person}
                      onSelect={(p) => {
                        setPerson(p);
                        setFormError('');
                      }}
                    />
                  </Panel>
                  <Panel step={2} title="What is the problem?" description="Choose the issue; the message is filled in for you.">
                    {library('support', supportPicked)}
                  </Panel>
                </div>
                <Panel
                  step={3}
                  title="Check and send"
                  description={
                    person ? (
                      <>
                        To <b className="text-fg">{person.name}</b>. Support messages follow their support notification settings, not announcements.
                      </>
                    ) : (
                      'Choose the person and a template, then adjust the wording if needed.'
                    )
                  }
                  className="lg:sticky lg:top-4"
                >
                  <Composer draft={supportDraft} setDraft={setSupportDraft} limits={limits} previewName={person?.name ?? 'Ama'} channelNote={personNote} />
                  <div className="mt-4">{sendBar}</div>
                </Panel>
              </div>
            ) : (
              <div className="space-y-5">
                <Panel step={1} title="Who should receive it?" description="Texts go only to verified phone numbers and emails only to verified addresses. People who turned off announcements are skipped.">
                  <div className="grid gap-3 sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)] sm:items-end">
                    <div>
                      <Label htmlFor="m-aud">Send to</Label>
                      <Select id="m-aud" value={audience} onChange={setAudience} options={AUDIENCES} />
                    </div>
                    <p className="text-sm text-muted sm:pb-2.5" aria-live="polite">
                      {reach ? (
                        <>
                          {reach.total} {reach.total === 1 ? 'person' : 'people'} · {reach.email} by email · {reach.sms} by text
                        </>
                      ) : (
                        <span className="inline-flex items-center gap-2">
                          <Spinner className="size-3.5" /> Counting recipients
                        </span>
                      )}
                    </p>
                  </div>
                  {audience === 'selected' && (
                    <div className="mt-3">
                      <PeoplePicker selected={uids} onChange={setUids} max={limits.maxRecipients} />
                    </div>
                  )}
                </Panel>
                <div className="grid gap-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:items-start">
                  <Panel step={2} title="Choose a message" description="Start from a template, then make it yours.">
                    {library('announcement', newsPicked)}
                  </Panel>
                  <Panel step={3} title="Check and send" className="lg:sticky lg:top-4">
                    <Composer draft={newsDraft} setDraft={setNewsDraft} limits={limits} previewName="Ama" />
                    <div className="mt-4">{sendBar}</div>
                  </Panel>
                </div>
              </div>
            )}

            {/* history */}
            <section>
              <h2 className="mb-3 text-base font-semibold">Recently sent</h2>
              {data.history.length ? (
                <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border">
                  {data.history.map((h) => (
                    <li key={h.id} className="grid gap-1 px-4 py-3 text-sm sm:grid-cols-[9rem_minmax(0,1fr)_auto] sm:gap-4">
                      <div className="text-xs text-muted tabular-nums">{fmt(h.at)}</div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          {h.purpose === 'support' ? <LifeBuoy className="size-3.5 shrink-0 text-accent" aria-label="Support" /> : <Megaphone className="size-3.5 shrink-0 text-muted" aria-label="Announcement" />}
                          <span className="truncate font-medium">{h.subject ?? h.smsText ?? 'Message'}</span>
                        </div>
                        <div className="truncate text-xs text-muted">
                          {h.purpose === 'support' ? 'Support message' : AUDIENCE_LABEL[h.audience]} · {h.recipients} {h.recipients === 1 ? 'person' : 'people'} · by {h.by}
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
        title={support ? `Send to ${person?.name ?? 'this person'}?` : audience === 'me' ? 'Send a test to yourself?' : 'Send this message?'}
        confirmLabel="Send now"
        danger={false}
        message={
          <span className="block space-y-2">
            <span className="block">
              To: <b>{support ? person?.name : AUDIENCE_LABEL[audience]}</b>
            </span>
            {emailOn && (
              <span className="block">
                {emailCount} email{emailCount === 1 ? '' : 's'}
                {draft.subject && <> · “{support && person ? personalise(draft.subject, person.name) : draft.subject}”</>}
              </span>
            )}
            {smsOn && (
              <span className="block">
                {smsCount} text message{smsCount === 1 ? '' : 's'} ({segments(smsLen)} SMS each). Texts use your SMS credit; {limits?.smsLeftToday ?? 0} are left today.
                {smsCount > (limits?.smsLeftToday ?? 0) && <span className="mt-1 block text-warn">Only {limits?.smsLeftToday ?? 0} can be sent today; the rest will be skipped.</span>}
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
