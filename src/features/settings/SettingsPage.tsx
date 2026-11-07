import { updateProfile } from 'firebase/auth';
import { doc, limit, orderBy, query, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { BarChart3, Brain, Info, KeyRound, LogOut, Palette, Plus, Sparkles, User, Users, X, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, NavLink, useNavigate, useParams } from 'react-router-dom';
import { Button, ConfirmDialog, Input, Label, Select, Spinner, Switch, Textarea } from '@/components/ui';
import { paths } from '@/lib/db';
import { db } from '@/lib/firebase';
import { useDocument, useQuery } from '@/lib/hooks';
import { ttsSupported } from '@/lib/speech';
import type { Accent, Theme, UsageDay, UserSettings } from '@/lib/types';
import { cn, formatTokens, isIOS, isStandalone, modelShortName } from '@/lib/utils';
import { BOOTSTRAP_ADMINS, useAuth, useUid } from '@/state/auth';
import { useCatalog } from '@/state/catalog';
import { useSettings } from '@/state/settings';
import { useToast } from '@/state/toast';
import { ModelPicker } from '../chat/ModelPicker';
import { Page } from '../shell/Page';

type SectionId = 'account' | 'appearance' | 'personalization' | 'models' | 'memory' | 'usage' | 'access' | 'about';
const SECTIONS: { id: SectionId; label: string; icon: LucideIcon; admin?: boolean }[] = [
  { id: 'account', label: 'Account', icon: User },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'personalization', label: 'Personalization', icon: Sparkles },
  { id: 'models', label: 'Models', icon: KeyRound },
  { id: 'memory', label: 'Memory', icon: Brain },
  { id: 'usage', label: 'Usage', icon: BarChart3 },
  { id: 'access', label: 'Access', icon: Users, admin: true },
  { id: 'about', label: 'About', icon: Info },
];

function Row({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        {description && <div className="mt-0.5 text-xs text-muted">{description}</div>}
      </div>
      <div className="shrink-0 sm:max-w-[60%]">{children}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-1 text-lg font-semibold tracking-tight">{title}</h2>
      <div className="divide-y divide-border">{children}</div>
    </section>
  );
}

/** Text setting that saves on blur, so typing doesn't write on every keystroke. */
function useDraft(value: string, save: (v: string) => Promise<void>) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(value), [value]);
  const commit = async () => {
    if (draft === value) return;
    setSaving(true);
    try {
      await save(draft);
    } finally {
      setSaving(false);
    }
  };
  return { draft, setDraft, commit, dirty: draft !== value, saving };
}

function AccountSection() {
  const { user, profile, admin, signOut } = useAuth();
  const uid = useUid();
  const toast = useToast();
  const name = useDraft(profile?.displayName ?? user?.displayName ?? '', async (v) => {
    await updateDoc(paths.user(uid), { displayName: v.trim().slice(0, 80) });
    if (user) await updateProfile(user, { displayName: v.trim().slice(0, 80) }).catch(() => undefined);
    toast('Name updated.', 'success');
  });
  return (
    <Section title="Account">
      <Row title="Email" description={admin ? 'Administrator' : 'Approved user'}>
        <span className="text-sm text-muted">{user?.email}</span>
      </Row>
      <Row title="Display name" description="Used to greet you.">
        <div className="flex gap-2">
          <Input value={name.draft} maxLength={80} onChange={(e) => name.setDraft(e.target.value)} onBlur={name.commit} className="sm:w-60" />
        </div>
      </Row>
      <Row title="Sign-in method">
        <span className="text-sm text-muted">
          {user?.providerData.map((p) => (p.providerId === 'google.com' ? 'Google' : p.providerId === 'password' ? 'Email and password' : p.providerId)).join(', ')}
        </span>
      </Row>
      <Row title="Sign out" description="Signs out on this device. Cached chats remain until the browser storage is cleared.">
        <Button variant="outline" icon={<LogOut className="size-4" />} onClick={() => void signOut()}>
          Sign out
        </Button>
      </Row>
    </Section>
  );
}

const ACCENTS: { id: Accent; label: string; swatch: string }[] = [
  { id: 'teal', label: 'Teal', swatch: '#0f766e' },
  { id: 'cyan', label: 'Cyan', swatch: '#0e7490' },
  { id: 'emerald', label: 'Emerald', swatch: '#047857' },
  { id: 'blue', label: 'Blue', swatch: '#1d4ed8' },
  { id: 'amber', label: 'Amber', swatch: '#b45309' },
  { id: 'graphite', label: 'Graphite', swatch: '#3f3f46' },
];

function AppearanceSection() {
  const { settings, update } = useSettings();
  return (
    <Section title="Appearance">
      <Row title="Theme">
        <div className="inline-flex rounded-lg bg-surface-2 p-0.5">
          {(['light', 'dark', 'system'] as Theme[]).map((t) => (
            <button
              key={t}
              onClick={() => update({ theme: t })}
              className={cn(
                'rounded-md px-3 py-1.5 text-[13px] font-medium capitalize transition-colors',
                settings.theme === t ? 'bg-elevated text-fg shadow-sm' : 'text-muted hover:text-fg',
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </Row>
      <Row title="Accent color">
        <div className="flex flex-wrap gap-2">
          {ACCENTS.map((a) => (
            <button
              key={a.id}
              onClick={() => update({ accent: a.id })}
              title={a.label}
              aria-label={a.label}
              aria-pressed={settings.accent === a.id}
              className={cn(
                'size-8 rounded-full border-2 transition-transform hover:scale-105',
                settings.accent === a.id ? 'border-fg' : 'border-transparent',
              )}
              style={{ backgroundColor: a.swatch }}
            />
          ))}
        </div>
      </Row>
      <Row title="Send with Enter" description="On a keyboard, Enter sends and Shift+Enter adds a line. On touch screens, use the send button.">
        <Switch label="Send with Enter" checked={settings.sendOnEnter} onChange={(v) => update({ sendOnEnter: v })} />
      </Row>
    </Section>
  );
}

function PersonalizationSection() {
  const { settings, update } = useSettings();
  const toast = useToast();
  const about = useDraft(settings.aboutMe, async (v) => {
    await update({ aboutMe: v.slice(0, 4000) });
    toast('Saved.', 'success');
  });
  const custom = useDraft(settings.customInstructions, async (v) => {
    await update({ customInstructions: v.slice(0, 8000) });
    toast('Saved.', 'success');
  });
  const lang = useDraft(settings.language === 'auto' ? '' : settings.language, async (v) => {
    await update({ language: v.trim() || 'auto' });
  });
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    if (!ttsSupported()) return;
    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener('voiceschanged', load);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', load);
  }, []);
  const set = <K extends keyof UserSettings>(k: K) => (v: UserSettings[K]) => void update({ [k]: v } as Partial<UserSettings>);

  return (
    <Section title="Personalization">
      <div className="py-4">
        <Label htmlFor="about" hint="Role, background, location, anything that helps answers fit you.">
          About you
        </Label>
        <Textarea id="about" rows={4} maxLength={4000} value={about.draft} onChange={(e) => about.setDraft(e.target.value)} onBlur={about.commit} />
      </div>
      <div className="py-4">
        <Label htmlFor="custom" hint="How Tessera should respond: format, things to always or never do.">
          Custom instructions
        </Label>
        <Textarea id="custom" rows={5} maxLength={8000} value={custom.draft} onChange={(e) => custom.setDraft(e.target.value)} onBlur={custom.commit} />
      </div>
      <Row title="Response length">
        <Select
          className="sm:w-48"
          value={settings.responseStyle}
          onChange={set('responseStyle')}
          options={[
            { value: 'concise', label: 'Concise' },
            { value: 'balanced', label: 'Balanced' },
            { value: 'detailed', label: 'Detailed' },
          ]}
        />
      </Row>
      <Row title="Tone">
        <Select
          className="sm:w-48"
          value={settings.tone}
          onChange={set('tone')}
          options={[
            { value: 'professional', label: 'Professional' },
            { value: 'friendly', label: 'Friendly' },
            { value: 'casual', label: 'Casual' },
          ]}
        />
      </Row>
      <Row title="Technical level">
        <Select
          className="sm:w-48"
          value={settings.technicalLevel}
          onChange={set('technicalLevel')}
          options={[
            { value: 'beginner', label: 'Beginner' },
            { value: 'intermediate', label: 'Intermediate' },
            { value: 'expert', label: 'Expert' },
          ]}
        />
      </Row>
      <Row title="Preferred language" description="Leave empty to reply in the language you write in.">
        <Input
          className="sm:w-48"
          placeholder="Automatic"
          value={lang.draft}
          maxLength={40}
          onChange={(e) => lang.setDraft(e.target.value)}
          onBlur={lang.commit}
        />
      </Row>
      {ttsSupported() && voices.length > 0 && (
        <Row title="Read-aloud voice">
          <Select
            className="sm:w-60"
            value={settings.voiceName ?? ''}
            onChange={(v) => update({ voiceName: v || null })}
            options={[{ value: '', label: 'System default' }, ...voices.map((v) => ({ value: v.name, label: `${v.name} (${v.lang})` }))]}
          />
        </Row>
      )}
    </Section>
  );
}

function ModelsSection() {
  const { settings, update } = useSettings();
  const { catalog, caps, getModel, reload, loading } = useCatalog();
  const def = settings.defaultModel ?? catalog?.defaultModel ?? '';
  return (
    <Section title="Models">
      <Row title="Default model" description="Used for new chats. You can switch per chat from the header.">
        <div className="-mx-2.5">
          <ModelPicker value={def} onChange={(id) => update({ defaultModel: id })} align="end" />
        </div>
      </Row>
      <Row title="Fallbacks" description="If the chosen model is busy or unavailable, Tessera tries these in order and tells you which one answered.">
        <ol className="space-y-0.5 text-sm text-muted">
          {(catalog?.fallbackModels ?? []).map((id, i) => (
            <li key={id}>
              {i + 1}. {getModel(id)?.name ?? modelShortName(id)}
            </li>
          ))}
        </ol>
      </Row>
      <Row title="Provider" description="Model access is proxied through the server. The API key is never sent to this device.">
        <span className="text-sm text-muted">
          {caps?.providers.length ? caps.providers.map((p) => (p === 'openrouter' ? 'OpenRouter' : p)).join(', ') : 'Not configured'}
          {catalog && (catalog.paidAvailable ? ' · paid models enabled' : ' · free models only (no credits)')}
        </span>
      </Row>
      <Row title="Web search" description="SerpAPI handles general and news searches; Tavily handles research and page reading. Keys stay on the server.">
        <span className="text-sm text-muted">
          {caps?.searchProviders?.length
            ? caps.searchProviders.map((p) => `${p.label}: ${p.configured ? 'on' : 'not configured'}`).join(' · ')
            : caps?.searchAvailable
              ? `Enabled (${caps.searchProvider})`
              : 'Not configured'}
        </span>
      </Row>
      <Row
        title="When to search the web"
        description="Automatic searches only when a message needs current information (news, prices, current office holders, latest versions, a link). Greetings, writing, maths and questions about your documents or earlier chats never search."
      >
        <Select
          className="sm:w-56"
          value={settings.searchMode ?? (settings.autoSearch === false ? 'manual' : 'auto')}
          onChange={(v) => update({ searchMode: v as UserSettings['searchMode'], autoSearch: v !== 'manual' })}
          options={[
            { value: 'auto', label: 'Automatic (recommended)' },
            { value: 'manual', label: 'Only when I ask' },
            { value: 'eager', label: 'Whenever it may help' },
          ]}
        />
      </Row>
      <Row title="Search toggle on by default" description="Turns the Search toggle on for new chats. Each informational message then uses a search unless cached (greetings and similar never do).">
        <Switch
          label="Search by default"
          checked={settings.webSearchDefault}
          disabled={!caps?.searchAvailable}
          onChange={(v) => update({ webSearchDefault: v })}
        />
      </Row>
      <Row title="Model list">
        <Button variant="outline" size="sm" loading={loading} onClick={reload}>
          Refresh
        </Button>
      </Row>
    </Section>
  );
}

function MemorySection() {
  const { settings, update } = useSettings();
  return (
    <Section title="Memory">
      <Row title="Use memory" description="Save lasting details from chats and recall them later. Turning this off stops both saving and recall.">
        <Switch label="Use memory" checked={settings.memoryEnabled} onChange={(v) => update({ memoryEnabled: v })} />
      </Row>
      <Row title="Manage memories" description="Review, edit or delete what Tessera remembers.">
        <Link to="/memory" className="text-sm font-medium text-accent hover:underline">
          Open Memory
        </Link>
      </Row>
    </Section>
  );
}

function UsageSection() {
  const uid = useUid();
  const { getModel } = useCatalog();
  const { data, loading } = useQuery<UsageDay>(query(paths.usage(uid), orderBy('date', 'desc'), limit(30)), [uid]);
  const totals = useMemo(() => {
    const t = { requests: 0, prompt: 0, completion: 0, cost: 0, models: {} as Record<string, number> };
    for (const d of data) {
      t.requests += d.requests ?? 0;
      t.prompt += d.promptTokens ?? 0;
      t.completion += d.completionTokens ?? 0;
      t.cost += d.cost ?? 0;
      for (const [k, v] of Object.entries(d.models ?? {})) t.models[k] = (t.models[k] ?? 0) + (v.requests ?? 0);
    }
    return t;
  }, [data]);
  const max = Math.max(1, ...data.map((d) => d.requests ?? 0));
  const modelLabel = (key: string) => {
    const m = getModel(key.replace(/_/g, '/')) ;
    return m?.name ?? key;
  };

  return (
    <Section title="Usage">
      {loading ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 py-4 sm:grid-cols-4">
            {[
              ['Requests', totals.requests.toLocaleString()],
              ['Input tokens', formatTokens(totals.prompt)],
              ['Output tokens', formatTokens(totals.completion)],
              ['Cost', totals.cost ? `$${totals.cost.toFixed(4)}` : '$0'],
            ].map(([k, v]) => (
              <div key={k}>
                <div className="text-xs text-muted">{k}</div>
                <div className="mt-0.5 text-lg font-semibold tabular-nums">{v}</div>
              </div>
            ))}
          </div>
          <div className="py-4">
            <div className="mb-2 text-xs text-muted">Requests per day, last 30 active days</div>
            {data.length ? (
              <div className="flex h-24 items-end gap-1" role="img" aria-label="Requests per day">
                {[...data].reverse().map((d) => (
                  <div key={d.id} className="flex-1" title={`${d.date}: ${d.requests ?? 0} requests`}>
                    <div className="w-full rounded-t-sm bg-accent" style={{ height: `${Math.max(4, ((d.requests ?? 0) / max) * 96)}px` }} />
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted">No usage recorded yet.</p>
            )}
          </div>
          {Object.keys(totals.models).length > 0 && (
            <div className="py-4">
              <div className="mb-2 text-xs text-muted">By model</div>
              <ul className="space-y-1 text-sm">
                {Object.entries(totals.models)
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, v]) => (
                    <li key={k} className="flex justify-between gap-4">
                      <span className="truncate">{modelLabel(k)}</span>
                      <span className="tabular-nums text-muted">{v}</span>
                    </li>
                  ))}
              </ul>
            </div>
          )}
          <p className="py-4 text-xs text-subtle">Token counts are reported by the provider. Free models report zero cost.</p>
        </>
      )}
    </Section>
  );
}

function EmailList({
  title,
  description,
  emails,
  locked,
  onChange,
}: {
  title: string;
  description: string;
  emails: string[];
  locked: string[];
  onChange: (next: string[]) => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const add = async () => {
    const e = value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      toast('Enter a valid email address.', 'error');
      return;
    }
    if (emails.includes(e)) return setValue('');
    setBusy(true);
    try {
      await onChange([...emails, e]);
      setValue('');
    } catch {
      toast('Could not update the list.', 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="py-4">
      <div className="text-sm font-medium">{title}</div>
      <div className="mt-0.5 text-xs text-muted">{description}</div>
      <ul className="mt-3 space-y-1">
        {locked.map((e) => (
          <li key={e} className="flex items-center justify-between rounded-lg bg-surface px-3 py-2 text-sm">
            <span className="truncate">{e}</span>
            <span className="text-xs text-subtle">Owner</span>
          </li>
        ))}
        {emails
          .filter((e) => !locked.includes(e))
          .map((e) => (
            <li key={e} className="flex items-center justify-between rounded-lg bg-surface px-3 py-2 text-sm">
              <span className="truncate">{e}</span>
              <button
                onClick={() => onChange(emails.filter((x) => x !== e)).catch(() => toast('Could not update the list.', 'error'))}
                className="rounded p-0.5 text-subtle hover:text-danger"
                aria-label={`Remove ${e}`}
              >
                <X className="size-4" />
              </button>
            </li>
          ))}
      </ul>
      <form
        className="mt-2 flex gap-2"
        onSubmit={(ev) => {
          ev.preventDefault();
          void add();
        }}
      >
        <Input type="email" value={value} onChange={(e) => setValue(e.target.value)} placeholder="name@example.com" />
        <Button type="submit" variant="outline" loading={busy} icon={<Plus className="size-4" />}>
          Add
        </Button>
      </form>
    </div>
  );
}

function AccessSection() {
  const { admin } = useAuth();
  const toast = useToast();
  const access = useDocument<{ allowedEmails?: string[]; adminEmails?: string[] }>(doc(db, 'config', 'access'), []);
  const pub = useDocument<{ registrationOpen?: boolean }>(doc(db, 'config', 'public'), []);
  const [confirmOpen, setConfirmOpen] = useState(false);
  if (!admin) return <Section title="Access"><p className="py-4 text-sm text-muted">Only administrators can manage access.</p></Section>;

  const allowed = access.data?.allowedEmails ?? [];
  const admins = access.data?.adminEmails ?? [];
  const write = (patch: { allowedEmails?: string[]; adminEmails?: string[] }) =>
    setDoc(doc(db, 'config', 'access'), { allowedEmails: allowed, adminEmails: admins, ...patch, updatedAt: serverTimestamp() });
  const setRegistration = async (open: boolean) => {
    try {
      await setDoc(doc(db, 'config', 'public'), { registrationOpen: open, updatedAt: serverTimestamp() });
    } catch {
      toast('Could not update registration.', 'error');
    }
  };

  return (
    <Section title="Access">
      <p className="py-4 text-sm text-muted">
        Tessera is private. Only verified emails on these lists can sign in and use it. Changes apply within a few minutes.
      </p>
      <Row
        title="Show the registration page"
        description="Lets people create an account. They still cannot use the app until their email is on the allowed list."
      >
        <Switch
          label="Registration open"
          checked={Boolean(pub.data?.registrationOpen)}
          onChange={(v) => (v ? setConfirmOpen(true) : void setRegistration(false))}
        />
      </Row>
      {access.loading ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : (
        <>
          <EmailList
            title="Allowed users"
            description="Can sign in and use all features. Each user's data is private to them."
            emails={allowed}
            locked={[]}
            onChange={(next) => write({ allowedEmails: next })}
          />
          <EmailList
            title="Administrators"
            description="Can manage these lists. Administrators cannot read other users' chats."
            emails={[...BOOTSTRAP_ADMINS, ...admins.filter((e) => !BOOTSTRAP_ADMINS.includes(e))]}
            locked={BOOTSTRAP_ADMINS}
            onChange={(next) => write({ adminEmails: next.filter((e) => !BOOTSTRAP_ADMINS.includes(e)) })}
          />
        </>
      )}
      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Open registration?"
        message="Anyone with the link will be able to create an account. They will see an access-denied screen until you add their email to the allowed list."
        confirmLabel="Open registration"
        danger={false}
        onConfirm={() => setRegistration(true)}
      />
    </Section>
  );
}

function AboutSection() {
  const installed = isStandalone();
  return (
    <Section title="About">
      <Row title="Tessera" description="A private AI assistant.">
        <span className="text-sm text-muted">Version {__APP_VERSION__}</span>
      </Row>
      <Row title="Installed as app" description={installed ? 'Running from the Home Screen.' : isIOS() ? 'In Safari, tap Share, then “Add to Home Screen”.' : 'Use your browser’s Install option.'}>
        <span className="text-sm text-muted">{installed ? 'Yes' : 'No'}</span>
      </Row>
      <Row title="Privacy" description="Your chats, memories and documents are stored in your own Firebase project and are only readable by your account. Messages are sent to the selected model provider through the server.">
        <span />
      </Row>
    </Section>
  );
}

export default function SettingsPage() {
  const { section } = useParams();
  const navigate = useNavigate();
  const { admin } = useAuth();
  const visible = SECTIONS.filter((s) => !s.admin || admin);
  const current = (visible.find((s) => s.id === section)?.id ?? 'account') as SectionId;

  useEffect(() => {
    if (section && !visible.some((s) => s.id === section)) navigate('/settings', { replace: true });
  }, [section, visible, navigate]);

  return (
    <Page title="Settings" wide>
      <h1 className="mb-5 hidden text-xl font-semibold tracking-tight lg:block">Settings</h1>
      <div className="flex flex-col gap-6 md:flex-row md:gap-10">
        <nav className="-mx-4 flex shrink-0 gap-1 overflow-x-auto px-4 scroll-thin md:mx-0 md:w-48 md:flex-col md:px-0" aria-label="Settings sections">
          {visible.map((s) => (
            <NavLink
              key={s.id}
              to={`/settings/${s.id}`}
              replace
              className={() =>
                cn(
                  'flex h-9 shrink-0 items-center gap-2.5 rounded-lg px-3 text-sm transition-colors',
                  current === s.id ? 'bg-surface-2 font-medium text-fg' : 'text-muted hover:bg-surface-2 hover:text-fg',
                )
              }
            >
              <s.icon className="size-4" />
              {s.label}
            </NavLink>
          ))}
        </nav>
        <div className="min-w-0 flex-1">
          {current === 'account' && <AccountSection />}
          {current === 'appearance' && <AppearanceSection />}
          {current === 'personalization' && <PersonalizationSection />}
          {current === 'models' && <ModelsSection />}
          {current === 'memory' && <MemorySection />}
          {current === 'usage' && <UsageSection />}
          {current === 'access' && <AccessSection />}
          {current === 'about' && <AboutSection />}
        </div>
      </div>
    </Page>
  );
}
