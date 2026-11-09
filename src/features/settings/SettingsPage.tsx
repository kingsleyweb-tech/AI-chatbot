import { updateProfile } from 'firebase/auth';
import { doc, limit, orderBy, query, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import {
  ArrowLeft,
  AtSign,
  BarChart3,
  Brain,
  CircleHelp,
  FileText,
  Inbox,
  LifeBuoy,
  ChevronRight,
  Cpu,
  Globe,
  Info,
  KeyRound,
  Library,
  LogOut,
  MailCheck,
  Megaphone,
  MessageSquareText,
  Palette,
  Phone,
  Plus,
  Settings2,
  ShieldCheck,
  Smartphone,
  Sparkles,
  SunMoon,
  UserPlus,
  Users,
  X,
  type LucideIcon,
  Newspaper,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Button,
  ConfirmDialog,
  Input,
  Label,
  Select,
  Spinner,
  Switch,
  Textarea,
} from '@/components/ui';
import { api } from '@/lib/api';
import { paths } from '@/lib/db';
import { db } from '@/lib/firebase';
import { useDocument, useQuery } from '@/lib/hooks';
import { ttsSupported } from '@/lib/speech';
import { speechConfig, type SpeechConfig } from '@/lib/voice';
import type { Accent, Theme, UsageDay, UserSettings } from '@/lib/types';
import type { AiConfig } from '@shared/types';
import { cn, formatTokens, isIOS, isStandalone, modelShortName } from '@/lib/utils';
import { BOOTSTRAP_ADMINS, useAuth, useUid } from '@/state/auth';
import { useCatalog } from '@/state/catalog';
import { useSettings } from '@/state/settings';
import { useToast } from '@/state/toast';
import { ModelPicker } from '../chat/ModelPicker';
import { Page } from '../shell/Page';
import { PhoneManager, SecuritySection } from './AccountSecurity';
import { ElevenAdminPanel, ElevenVoiceRows } from './ElevenLabsSettings';
import { maskPhone, PageTitle, providerLabel, Row, Section } from './parts';

type SectionId =
  | 'account'
  | 'security'
  | 'appearance'
  | 'personalization'
  | 'general'
  | 'models'
  | 'memory'
  | 'usage'
  | 'access'
  | 'about';
const SECTIONS: { id: SectionId; label: string; admin?: boolean }[] = [
  { id: 'account', label: 'Account' },
  { id: 'security', label: 'Security' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'personalization', label: 'Personalization' },
  { id: 'general', label: 'General' },
  { id: 'models', label: 'Models and search' },
  { id: 'memory', label: 'Memory' },
  { id: 'usage', label: 'Usage' },
  { id: 'access', label: 'Access', admin: true },
  { id: 'about', label: 'About' },
];

/** A tappable row in the main list: icon, label, value and chevron. */
function NavRow({
  to,
  icon: Icon,
  label,
  value,
}: {
  to?: string;
  icon: LucideIcon;
  label: string;
  value?: ReactNode;
}) {
  const inner = (
    <>
      <Icon className="size-5 shrink-0 text-fg/80" strokeWidth={1.75} />
      <span className="min-w-0 flex-1 truncate text-[15px]">{label}</span>
      {value !== undefined && (
        <span className="max-w-[55%] truncate text-right text-[15px] text-muted">{value}</span>
      )}
      {to && <ChevronRight className="size-4 shrink-0 text-subtle" />}
    </>
  );
  const cls = 'flex min-h-12 w-full items-center gap-3 px-4 py-2.5 text-left transition-colors';
  if (!to) return <div className={cls}>{inner}</div>;
  return (
    <Link to={to} className={cn(cls, 'hover:bg-surface-2 active:bg-surface-2')}>
      {inner}
    </Link>
  );
}

function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="mb-7">
      {title && <h2 className="mb-1.5 px-4 text-[13px] font-medium text-muted">{title}</h2>}
      <div className="divide-y divide-border overflow-hidden rounded-2xl bg-elevated">
        {children}
      </div>
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
    if (user)
      await updateProfile(user, { displayName: v.trim().slice(0, 80) }).catch(() => undefined);
    toast('Name updated.', 'success');
  });
  return (
    <>
      <Section title="Account">
        <Row title="Email" description={admin ? 'Administrator' : 'Approved user'}>
          <span className="break-all text-sm text-muted">{user?.email}</span>
        </Row>
        <Row title="Display name" description="Used to greet you.">
          <div className="flex gap-2">
            <Input
              value={name.draft}
              maxLength={80}
              onChange={(e) => name.setDraft(e.target.value)}
              onBlur={name.commit}
              className="sm:w-60"
            />
          </div>
        </Row>
        <Row title="Sign-in method">
          <span className="text-sm text-muted">
            {user?.providerData.map((p) => providerLabel(p.providerId)).join(', ')}
          </span>
        </Row>
        <Row
          title="Sign out"
          description="Signs out on this device. Cached chats remain until the browser storage is cleared."
        >
          <Button
            variant="outline"
            icon={<LogOut className="size-4" />}
            onClick={() => void signOut()}
          >
            Sign out
          </Button>
        </Row>
      </Section>
      <PhoneManager />
    </>
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
    </Section>
  );
}

function GeneralSection() {
  const { settings, update } = useSettings();
  const { admin } = useAuth();
  const lang = useDraft(settings.language === 'auto' ? '' : settings.language, async (v) => {
    await update({ language: v.trim() || 'auto' });
  });
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceInfo, setVoiceInfo] = useState<SpeechConfig | null>(null);
  useEffect(() => {
    void speechConfig(true).then(setVoiceInfo);
  }, []);
  useEffect(() => {
    if (!ttsSupported()) return;
    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener('voiceschanged', load);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', load);
  }, []);
  return (
    <Section title="General">
      <Row
        title="App language"
        description="Atlas AI replies in this language. Leave empty to reply in the language you write in."
      >
        <Input
          className="sm:w-48"
          placeholder="Automatic"
          value={lang.draft}
          maxLength={40}
          onChange={(e) => lang.setDraft(e.target.value)}
          onBlur={lang.commit}
        />
      </Row>
      <Row
        title="Send with Enter"
        description="On a keyboard, Enter sends and Shift+Enter adds a line. On touch screens, use the send button."
      >
        <Switch
          label="Send with Enter"
          checked={settings.sendOnEnter}
          onChange={(v) => update({ sendOnEnter: v })}
        />
      </Row>
      {ttsSupported() && voices.length > 0 && (
        <Row title="Read-aloud voice">
          <Select
            className="sm:w-60"
            value={settings.voiceName ?? ''}
            onChange={(v) => update({ voiceName: v || null })}
            options={[
              { value: '', label: 'System default' },
              ...voices.map((v) => ({ value: v.name, label: `${v.name} (${v.lang})` })),
            ]}
          />
        </Row>
      )}
      <Row
        title="Natural voice"
        description={
          voiceInfo?.configured === false
            ? 'Not available on this server.'
            : `A more natural voice for Read aloud and Voice Mode, from Cloudflare (free, with a small daily share${voiceInfo?.naturalVoice ? `: about ${voiceInfo.naturalVoice.charactersLeft.toLocaleString()} characters left for you today` : ''}). When it is used up, your device voice takes over.`
        }
      >
        <Switch
          label="Natural voice"
          checked={settings.naturalVoice}
          disabled={voiceInfo?.configured === false}
          onChange={(v) => update({ naturalVoice: v })}
        />
      </Row>
      <ElevenVoiceRows info={voiceInfo?.elevenlabs} />
      {admin && <ElevenAdminPanel />}
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
  const set =
    <K extends keyof UserSettings>(k: K) =>
    (v: UserSettings[K]) =>
      void update({ [k]: v } as Partial<UserSettings>);

  return (
    <Section title="Personalization">
      <div className="py-4">
        <Label
          htmlFor="about"
          hint="Role, background, location, anything that helps answers fit you."
        >
          About you
        </Label>
        <Textarea
          id="about"
          rows={4}
          maxLength={4000}
          value={about.draft}
          onChange={(e) => about.setDraft(e.target.value)}
          onBlur={about.commit}
        />
      </div>
      <div className="py-4">
        <Label
          htmlFor="custom"
          hint="How Atlas AI should respond: format, things to always or never do."
        >
          Custom instructions
        </Label>
        <Textarea
          id="custom"
          rows={5}
          maxLength={8000}
          value={custom.draft}
          onChange={(e) => custom.setDraft(e.target.value)}
          onBlur={custom.commit}
        />
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
    </Section>
  );
}

function ModelsSection() {
  const { settings, update } = useSettings();
  const { catalog, caps, getModel, reload, loading } = useCatalog();
  const def = settings.defaultModel ?? catalog?.defaultModel ?? '';
  return (
    <Section title="Models and search">
      <Row
        title="Default model"
        description="Used for new chats. You can switch per chat from the header."
      >
        <div className="-mx-2.5">
          <ModelPicker value={def} onChange={(id) => update({ defaultModel: id })} align="end" />
        </div>
      </Row>
      <Row
        title="Fallbacks"
        description="If the chosen model is busy or unavailable, Atlas AI tries these in order and tells you which one answered."
      >
        <ol className="space-y-0.5 text-sm text-muted">
          {(catalog?.fallbackModels ?? []).map((id, i) => (
            <li key={id}>
              {i + 1}. {getModel(id)?.name ?? modelShortName(id)}
            </li>
          ))}
        </ol>
      </Row>
      <Row
        title="Provider"
        description="Model access is proxied through the server. The API key is never sent to this device."
      >
        <span className="text-sm text-muted">
          {caps?.providers.length
            ? [...caps.providers]
                .sort(
                  (a, b) =>
                    Number(a !== (catalog?.preferredProvider ?? 'gemini')) -
                    Number(b !== (catalog?.preferredProvider ?? 'gemini')),
                )
                .map(
                  (p, i) =>
                    `${p === 'openrouter' ? 'OpenRouter' : p === 'gemini' ? 'Google Gemini' : p}${caps.providers.length > 1 ? (i === 0 ? ' (primary)' : ' (secondary)') : ''}`,
                )
                .join(', ')
            : 'Not configured'}
          {catalog && ' · Free models only'}
        </span>
      </Row>
      <Row
        title="Web search"
        description="SerpAPI handles general and news searches; Tavily handles research and page reading. Keys stay on the server."
      >
        <span className="text-sm text-muted">
          {caps?.searchProviders?.length
            ? caps.searchProviders
                .map((p) => `${p.label}: ${p.configured ? 'on' : 'not configured'}`)
                .join(' · ')
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
          onChange={(v) =>
            update({ searchMode: v as UserSettings['searchMode'], autoSearch: v !== 'manual' })
          }
          options={[
            { value: 'auto', label: 'Automatic (recommended)' },
            { value: 'manual', label: 'Only when I ask' },
            { value: 'eager', label: 'Whenever it may help' },
          ]}
        />
      </Row>
      <Row
        title="Search toggle on by default"
        description="Turns the Search toggle on for new chats. Each informational message then uses a search unless cached (greetings and similar never do)."
      >
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
      <AdminAiRows />
    </Section>
  );
}

/** App-wide AI routing settings (Firestore config/ai). Admins only. */
function AdminAiRows() {
  const { admin } = useAuth();
  const toast = useToast();
  const { catalog } = useCatalog();
  const cfg = useDocument<Partial<AiConfig>>(doc(db, 'config', 'ai'), []);
  if (!admin) return null;
  const current: AiConfig = {
    preferredProvider: cfg.data?.preferredProvider ?? 'gemini',
    defaultModel: cfg.data?.defaultModel ?? null,
    fallback: cfg.data?.fallback ?? 'any',
  };
  const save = async (patch: Partial<AiConfig>) => {
    try {
      await setDoc(doc(db, 'config', 'ai'), { ...current, ...patch, updatedAt: serverTimestamp() });
      toast('Saved. The server picks this up within 5 minutes.');
    } catch {
      toast('Could not save. Deploy the latest Firestore rules first.', 'error');
    }
  };
  return (
    <>
      <h3 className="bg-surface-2/50 py-2 text-xs font-medium uppercase tracking-wide text-muted">
        Admin: AI routing (all users)
      </h3>
      <Row
        title="Preferred provider"
        description="Tried first whenever Atlas AI picks a model automatically. A model a user chose is always kept when it can answer."
      >
        <Select
          className="sm:w-48"
          value={current.preferredProvider}
          onChange={(v) => {
            const provider = v as AiConfig['preferredProvider'];
            const patch: Partial<AiConfig> = { preferredProvider: provider };
            // Choosing Cloudflare also makes a Cloudflare model the app default; otherwise users
            // would keep the old default (a chosen model is always kept when it can answer).
            if (provider === 'cloudflare') {
              const currentDefault = catalog?.models.find(
                (m) => m.id === (current.defaultModel ?? catalog?.defaultModel),
              );
              const cf =
                catalog?.models.filter((m) => m.provider === 'cloudflare' && m.available) ?? [];
              const pick = cf.find((m) => m.id === '@cf/google/gemma-4-26b-a4b-it') ?? cf[0];
              if (currentDefault?.provider !== 'cloudflare' && pick) patch.defaultModel = pick.id;
            }
            void save(patch);
          }}
          options={[
            { value: 'gemini', label: 'Google Gemini' },
            { value: 'openrouter', label: 'OpenRouter' },
            { value: 'cloudflare', label: 'Cloudflare Workers AI' },
          ]}
        />
      </Row>
      {current.preferredProvider === 'cloudflare' && (
        <p className="pb-3 text-xs text-muted">
          Cloudflare uses the free daily allowance (10,000 Neurons, shared with image creation;
          Atlas AI stops at 9,000). When it is used up, replies continue on Gemini or OpenRouter
          until 00:00 UTC (unless automatic fallback is off or limited to the same provider).
          Titles, summaries and memory still use Gemini.
        </p>
      )}
      <Row
        title="App default model"
        description="For users who have not chosen a default model themselves."
      >
        <div className="-mx-2.5">
          <ModelPicker
            value={current.defaultModel ?? catalog?.defaultModel ?? ''}
            onChange={(id) => void save({ defaultModel: id })}
            align="end"
          />
        </div>
      </Row>
      <Row
        title="Automatic fallback"
        description="When a model fails with a recoverable error (busy, quota, outage). Only free models are ever used; paid models are never a fallback."
      >
        <Select
          className="sm:w-56"
          value={current.fallback}
          onChange={(v) => void save({ fallback: v as AiConfig['fallback'] })}
          options={[
            { value: 'any', label: 'Any free model, any provider' },
            { value: 'same_provider', label: 'Same provider only' },
            { value: 'off', label: 'Off (show the error)' },
          ]}
        />
      </Row>
      <FreeModelsPolicy />
    </>
  );
}

const AI_PROVIDER_LABEL: Record<string, string> = {
  gemini: 'Google Gemini',
  openrouter: 'OpenRouter',
  cloudflare: 'Cloudflare Workers AI',
};

interface FreeCandidate {
  id: string;
  name: string;
  provider: string;
}
interface BillingView {
  billing: { approvedModels: string[] | null; updatedAt?: number | null; updatedBy?: string | null };
  candidates: FreeCandidate[];
}

/**
 * Free Models Only (server-enforced, api/admin billingGet/billingSet). Only models the server
 * confirms are free are listed, so a paid model can never be approved here.
 */
function FreeModelsPolicy() {
  const toast = useToast();
  const [view, setView] = useState<BillingView | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    api<BillingView>('admin', { json: { action: 'billingGet' } })
      .then((r) => live && setView(r))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, []);
  const save = async (approvedModels: string[] | null) => {
    setBusy(true);
    try {
      setView(await api<BillingView>('admin', { json: { action: 'billingSet', approvedModels } }));
      toast('Saved. Applies to every request within a minute.');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save.', 'error');
    } finally {
      setBusy(false);
    }
  };
  const all = view?.billing.approvedModels === null;
  const approved = new Set(view?.billing.approvedModels ?? view?.candidates.map((c) => c.id) ?? []);
  const toggle = (id: string, on: boolean) => {
    if (!view) return;
    const next = view.candidates.map((c) => c.id).filter((m) => (m === id ? on : approved.has(m)));
    if (!next.length) {
      toast('Keep at least one free model approved.', 'error');
      return;
    }
    void save(next);
  };
  return (
    <>
      <h3 className="bg-surface-2/50 py-2 text-xs font-medium uppercase tracking-wide text-muted">
        Admin: Free models only
      </h3>
      <p className="py-3 text-xs text-muted">
        Atlas AI uses free models only and never switches to paid usage, buys credits or upgrades a
        plan. Gemini: Free Tier models only. OpenRouter: :free models only. Cloudflare: the free
        daily allowance only. ElevenLabs: the credits already included in the subscription only.
        When every free model is at its limit, people are told to try again later.
      </p>
      {failed ? (
        <p className="pb-3 text-xs text-danger">Could not load the approved model list.</p>
      ) : !view ? (
        <div className="py-3">
          <Spinner />
        </div>
      ) : (
        <>
          <Row
            title="Use every free model"
            description="On: any model the server confirms is free. Off: only the models ticked below. Paid models can never be added."
          >
            <Switch
              label="Use every free model"
              checked={all}
              disabled={busy}
              onChange={(v) => void save(v ? null : view.candidates.map((c) => c.id))}
            />
          </Row>
          {!all &&
            view.candidates.map((c) => (
              <Row key={c.id} title={c.name} description={`${AI_PROVIDER_LABEL[c.provider] ?? c.provider} · ${c.id}`}>
                <Switch
                  label={`Approve ${c.name}`}
                  checked={approved.has(c.id)}
                  disabled={busy}
                  onChange={(v) => toggle(c.id, v)}
                />
              </Row>
            ))}
        </>
      )}
    </>
  );
}

function MemorySection() {
  const { settings, update } = useSettings();
  return (
    <Section title="Memory">
      <Row
        title="Use memory"
        description="Save lasting details from chats and recall them later. Turning this off stops both saving and recall."
      >
        <Switch
          label="Use memory"
          checked={settings.memoryEnabled}
          onChange={(v) => update({ memoryEnabled: v })}
        />
      </Row>
      <Row title="Manage memories" description="Review, edit or delete what Atlas AI remembers.">
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
  const { data, loading } = useQuery<UsageDay>(
    query(paths.usage(uid), orderBy('date', 'desc'), limit(30)),
    [uid],
  );
  const totals = useMemo(() => {
    const t = {
      requests: 0,
      prompt: 0,
      completion: 0,
      cost: 0,
      models: {} as Record<string, number>,
    };
    for (const d of data) {
      t.requests += d.requests ?? 0;
      t.prompt += d.promptTokens ?? 0;
      t.completion += d.completionTokens ?? 0;
      t.cost += d.cost ?? 0;
      for (const [k, v] of Object.entries(d.models ?? {}))
        t.models[k] = (t.models[k] ?? 0) + (v.requests ?? 0);
    }
    return t;
  }, [data]);
  const max = Math.max(1, ...data.map((d) => d.requests ?? 0));
  const modelLabel = (key: string) => {
    const m = getModel(key.replace(/_/g, '/'));
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
                  <div
                    key={d.id}
                    className="flex-1"
                    title={`${d.date}: ${d.requests ?? 0} requests`}
                  >
                    <div
                      className="w-full rounded-t-sm bg-accent"
                      style={{ height: `${Math.max(4, ((d.requests ?? 0) / max) * 96)}px` }}
                    />
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
          <UsageBreakdown data={data} />
          <p className="py-4 text-xs text-subtle">
            Token counts and cost are as reported by the provider. Free models (including Gemini on
            the free tier) report zero cost. Counts cover the last 30 active days and are recorded
            on the server; they never include message text.
          </p>
        </>
      )}
    </Section>
  );
}

const PROVIDER_LABEL: Record<string, string> = {
  gemini: 'Google Gemini',
  openrouter: 'OpenRouter',
  serpapi: 'SerpAPI',
  tavily: 'Tavily',
};
const REASON_LABEL: Record<string, string> = {
  smalltalk: 'Greeting or small talk',
  math: 'Arithmetic',
  writing: 'Writing task',
  memory: 'About earlier chats',
  document: 'About attached documents',
  model_knowledge: 'Answered from model knowledge',
  mode_manual: 'Search set to "only when I ask"',
  empty: 'Empty message',
  toggle: 'Search toggle on',
  explicit_request: 'Asked to search',
  url: 'Contained a link',
  current_info: 'Needed current information',
  eager: '"Whenever it may help" mode',
  research_toggle: 'Deep Research toggle',
  research_request: 'Asked for in-depth research',
};

function sumInto(
  target: Record<string, Record<string, number>>,
  src: Record<string, Record<string, number | undefined>> | undefined,
) {
  for (const [k, v] of Object.entries(src ?? {})) {
    const t = (target[k] ??= {});
    for (const [f, n] of Object.entries(v ?? {})) if (typeof n === 'number') t[f] = (t[f] ?? 0) + n;
  }
}

/** Providers, routing, web search and search decisions over the loaded days. */
function UsageBreakdown({ data }: { data: UsageDay[] }) {
  const t = useMemo(() => {
    const providers: Record<string, Record<string, number>> = {};
    const search: Record<string, Record<string, number>> = {};
    const routing: Record<string, number> = {};
    const decisions: Record<string, number> = {};
    const reasons: Record<string, number> = {};
    for (const d of data) {
      sumInto(providers, d.providers);
      sumInto(search, d.search);
      for (const [k, n] of Object.entries(d.routing ?? {}))
        routing[k] = (routing[k] ?? 0) + (n ?? 0);
      for (const [k, n] of Object.entries(d.searchDecisions ?? {}))
        if (typeof n === 'number') decisions[k] = (decisions[k] ?? 0) + n;
      for (const [k, n] of Object.entries(d.searchDecisions?.reasons ?? {}))
        reasons[k] = (reasons[k] ?? 0) + n;
    }
    return { providers, search, routing, decisions, reasons };
  }, [data]);

  const decided = Object.values(t.decisions).reduce((a, b) => a + b, 0);
  const searchedFresh = Object.values(t.search).reduce((a, s) => a + (s.requests ?? 0), 0);
  const cached = Object.values(t.search).reduce((a, s) => a + (s.cached ?? 0), 0);
  const credits = Object.values(t.search).reduce((a, s) => a + (s.credits ?? 0), 0);
  const lookups = searchedFresh + cached;
  const table = (rows: [string, ...(string | number)[]][], head: string[]) => (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted">
            {head.map((h, i) => (
              <th key={h} className={cn('pb-1 font-normal', i > 0 && 'text-right')}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, ...cells]) => (
            <tr key={name} className="border-t border-border">
              <td className="py-1.5 pr-3">{name}</td>
              {cells.map((c, i) => (
                <td key={i} className="py-1.5 pl-3 text-right tabular-nums text-muted">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      {Object.keys(t.providers).length > 0 && (
        <div className="py-4">
          <div className="mb-2 text-xs text-muted">AI providers</div>
          {table(
            Object.entries(t.providers)
              .sort((a, b) => Number(b[0] === 'gemini') - Number(a[0] === 'gemini'))
              .map(([id, p]) => [
                PROVIDER_LABEL[id] ?? id,
                p.requests ?? 0,
                formatTokens(p.tokens ?? 0),
                p.failed ?? 0,
                p.rateLimited ?? 0,
              ]),
            ['Provider', 'Replies', 'Tokens', 'Failed', 'Rate limited'],
          )}
          <p className="mt-2 text-xs text-subtle">
            {t.routing.fallbacks ?? 0} fallbacks, {t.routing.providerSwitches ?? 0} switched
            provider, {t.routing.switched ?? 0} replies routed to a different model than the one
            selected.
          </p>
        </div>
      )}
      {(decided > 0 || lookups > 0) && (
        <div className="py-4">
          <div className="mb-2 text-xs text-muted">Web search</div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 pb-3 sm:grid-cols-4">
            {[
              ['Messages checked', decided.toLocaleString()],
              ['Searches avoided', (t.decisions.none ?? 0).toLocaleString()],
              ['Cache hit rate', lookups ? `${Math.round((cached / lookups) * 100)}%` : '–'],
              ['Credits used', credits.toLocaleString()],
            ].map(([k, v]) => (
              <div key={k}>
                <div className="text-xs text-muted">{k}</div>
                <div className="mt-0.5 font-semibold tabular-nums">{v}</div>
              </div>
            ))}
          </div>
          {Object.keys(t.search).length > 0 &&
            table(
              Object.entries(t.search).map(([id, s]) => [
                PROVIDER_LABEL[id] ?? id,
                s.requests ?? 0,
                s.cached ?? 0,
                s.failed ?? 0,
                s.credits ?? 0,
              ]),
              ['Provider', 'Searches', 'From cache', 'Failed', 'Credits'],
            )}
          {Object.keys(t.reasons).length > 0 && (
            <>
              <div className="mb-1 mt-4 text-xs text-muted">Why (decisions)</div>
              <ul className="space-y-1 text-sm">
                {Object.entries(t.reasons)
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, v]) => (
                    <li key={k} className="flex justify-between gap-4">
                      <span className="truncate">{REASON_LABEL[k] ?? k}</span>
                      <span className="tabular-nums text-muted">{v}</span>
                    </li>
                  ))}
              </ul>
            </>
          )}
          <p className="mt-2 text-xs text-subtle">
            Deep Research runs: {t.decisions.research ?? 0}. Credits are counted by Atlas AI; the
            provider dashboards show the account totals.
          </p>
        </div>
      )}
    </>
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
          <li
            key={e}
            className="flex items-center justify-between rounded-lg bg-surface px-3 py-2 text-sm"
          >
            <span className="truncate">{e}</span>
            <span className="text-xs text-subtle">Owner</span>
          </li>
        ))}
        {emails
          .filter((e) => !locked.includes(e))
          .map((e) => (
            <li
              key={e}
              className="flex items-center justify-between rounded-lg bg-surface px-3 py-2 text-sm"
            >
              <span className="truncate">{e}</span>
              <button
                onClick={() =>
                  onChange(emails.filter((x) => x !== e)).catch(() =>
                    toast('Could not update the list.', 'error'),
                  )
                }
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
        <Input
          type="email"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="name@example.com"
        />
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
  const access = useDocument<{ allowedEmails?: string[]; adminEmails?: string[] }>(
    doc(db, 'config', 'access'),
    [],
  );
  const pub = useDocument<{ registrationOpen?: boolean }>(doc(db, 'config', 'public'), []);
  const [confirmOpen, setConfirmOpen] = useState(false);
  if (!admin)
    return (
      <Section title="Access">
        <p className="py-4 text-sm text-muted">Only administrators can manage access.</p>
      </Section>
    );

  const allowed = access.data?.allowedEmails ?? [];
  const admins = access.data?.adminEmails ?? [];
  const write = (patch: { allowedEmails?: string[]; adminEmails?: string[] }) =>
    setDoc(doc(db, 'config', 'access'), {
      allowedEmails: allowed,
      adminEmails: admins,
      ...patch,
      updatedAt: serverTimestamp(),
    });
  const setRegistration = async (open: boolean) => {
    try {
      await setDoc(doc(db, 'config', 'public'), {
        registrationOpen: open,
        updatedAt: serverTimestamp(),
      });
    } catch {
      toast('Could not update registration.', 'error');
    }
  };

  return (
    <Section title="Access">
      <p className="py-4 text-sm text-muted">
        Atlas AI is private. Only verified emails on these lists can sign in and use it. Changes
        apply within a few minutes.
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
            onChange={(next) =>
              write({ adminEmails: next.filter((e) => !BOOTSTRAP_ADMINS.includes(e)) })
            }
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
    <>
      <Group title="Support">
        <NavRow to="/help" icon={CircleHelp} label="Help Centre" />
        <NavRow to="/support/new" icon={LifeBuoy} label="Contact support" />
        <NavRow to="/support" icon={Inbox} label="My reports" />
      </Group>
      <Group title="Legal">
        <NavRow to="/terms" icon={FileText} label="Terms of use" />
        <NavRow to="/privacy" icon={ShieldCheck} label="Privacy policy" />
      </Group>
      <Group title="App">
        <NavRow icon={Info} label="Atlas AI" value={`Version ${__APP_VERSION__}`} />
        <NavRow icon={Smartphone} label="Installed as app" value={installed ? 'Yes' : 'No'} />
      </Group>
      {!installed && (
        <p className="-mt-4 mb-7 px-4 text-xs text-muted">
          {isIOS()
            ? 'To install: in Safari, tap Share, then “Add to Home Screen”.'
            : 'To install: use your browser’s Install option.'}
        </p>
      )}
    </>
  );
}

function SettingsHome() {
  const { user, profile, admin, provider, signOut } = useAuth();
  const { settings, update } = useSettings();
  const { catalog, getModel, caps } = useCatalog();
  const name = profile?.displayName || user?.displayName || user?.email?.split('@')[0] || 'You';
  const photo = profile?.photoURL ?? user?.photoURL;
  const accent = ACCENTS.find((a) => a.id === settings.accent) ?? ACCENTS[0];
  const model = settings.defaultModel ?? catalog?.defaultModel ?? '';
  const autoSearch =
    (settings.searchMode ?? (settings.autoSearch === false ? 'manual' : 'auto')) !== 'manual';
  const [confirmOut, setConfirmOut] = useState(false);

  return (
    <div className="mx-auto max-w-xl">
      <div className="mb-8 flex flex-col items-center text-center">
        {photo ? (
          <img
            src={photo}
            alt=""
            referrerPolicy="no-referrer"
            className="size-20 rounded-full object-cover"
          />
        ) : (
          <div className="flex size-20 items-center justify-center rounded-full bg-accent text-3xl font-semibold text-white">
            {name.slice(0, 1).toUpperCase()}
          </div>
        )}
        <div className="mt-3 text-xl font-semibold tracking-tight">{name}</div>
        <div className="mt-0.5 text-sm text-muted">{user?.email}</div>
      </div>

      <Group title="Customize">
        <NavRow to="/settings/personalization" icon={Sparkles} label="Personalization" />
        <NavRow
          to="/settings/memory"
          icon={Brain}
          label="Memory"
          value={settings.memoryEnabled ? 'On' : 'Off'}
        />
        <NavRow to="/knowledge" icon={Library} label="Knowledge base" />
      </Group>

      <Group title="Account">
        <NavRow to="/settings/account" icon={AtSign} label="Email" value={user?.email ?? ''} />
        <NavRow
          to="/settings/account"
          icon={Phone}
          label="Phone number"
          value={
            profile?.phoneNumber
              ? maskPhone(profile.phoneNumber)
              : provider === 'password'
                ? 'Not added'
                : 'Not required'
          }
        />
        <NavRow
          to="/settings/account"
          icon={KeyRound}
          label="Sign-in method"
          value={provider ? providerLabel(provider) : ''}
        />
        <NavRow to="/settings/security" icon={ShieldCheck} label="Security and activity" />
        <NavRow to="/settings/usage" icon={BarChart3} label="Usage" />
        {admin && <NavRow to="/admin/users" icon={Users} label="Users" value="Admin" />}
        {admin && (
          <NavRow to="/admin/requests" icon={UserPlus} label="Access requests" value="Admin" />
        )}
        {admin && (
          <NavRow
            to="/settings/access"
            icon={ShieldCheck}
            label="Access and registration"
            value="Admin"
          />
        )}
      </Group>

      <Group title="Theme">
        <NavRow
          to="/settings/appearance"
          icon={SunMoon}
          label="Appearance"
          value={settings.theme[0].toUpperCase() + settings.theme.slice(1)}
        />
        <NavRow
          to="/settings/appearance"
          icon={Palette}
          label="Accent color"
          value={
            <span className="inline-flex items-center gap-1.5">
              <span className="size-3 rounded-full" style={{ backgroundColor: accent.swatch }} />
              {accent.label}
            </span>
          }
        />
      </Group>

      <Group>
        <NavRow to="/settings/general" icon={Settings2} label="General" />
      </Group>

      <Group title="Intelligence">
        <NavRow
          to="/settings/models"
          icon={Cpu}
          label="Default model"
          value={model ? (getModel(model)?.name ?? modelShortName(model)) : 'Automatic'}
        />
      </Group>

      <Group title="Automatically use">
        <div className="flex min-h-12 items-center gap-3 px-4 py-2.5">
          <Globe className="size-5 shrink-0 text-fg/80" strokeWidth={1.75} />
          <div className="min-w-0 flex-1">
            <div className="text-[15px]">Web search</div>
            {!caps?.searchAvailable && (
              <div className="text-xs text-muted">Not configured on the server</div>
            )}
          </div>
          <Switch
            label="Search the web automatically"
            checked={autoSearch}
            disabled={!caps?.searchAvailable}
            onChange={(v) => update({ searchMode: v ? 'auto' : 'manual', autoSearch: v })}
          />
        </div>
      </Group>

      <Group title="Help and support">
        <NavRow to="/help" icon={CircleHelp} label="Help Centre" />
        <NavRow to="/support/new" icon={LifeBuoy} label="Report an issue" />
        <NavRow to="/support" icon={Inbox} label="My reports" />
        {admin && (
          <NavRow
            to="/admin/support"
            icon={LifeBuoy}
            label="Support & issue reports"
            value="Admin"
          />
        )}
        {admin && (
          <NavRow
            to="/admin/sms"
            icon={MessageSquareText}
            label="SMS & verification"
            value="Admin"
          />
        )}
        {admin && (
          <NavRow to="/admin/email" icon={MailCheck} label="Email delivery" value="Admin" />
        )}
        {admin && (
          <NavRow to="/admin/messages" icon={Megaphone} label="Messages to users" value="Admin" />
        )}
        {admin && <NavRow to="/admin/news" icon={Newspaper} label="News sources" value="Admin" />}
        <KnowledgeCenterLink admin={admin} />
      </Group>

      <Group>
        <NavRow
          to="/settings/about"
          icon={Info}
          label="About"
          value={`Version ${__APP_VERSION__}`}
        />
        <button
          onClick={() => setConfirmOut(true)}
          className="flex min-h-12 w-full items-center gap-3 px-4 py-2.5 text-left text-danger transition-colors hover:bg-surface-2"
        >
          <LogOut className="size-5 shrink-0" strokeWidth={1.75} />
          <span className="text-[15px]">Sign out</span>
        </button>
      </Group>

      <ConfirmDialog
        open={confirmOut}
        onClose={() => setConfirmOut(false)}
        title="Sign out?"
        message="You will need to sign in again on this device."
        confirmLabel="Sign out"
        onConfirm={() => void signOut()}
      />
    </div>
  );
}

export default function SettingsPage() {
  const { section } = useParams();
  const navigate = useNavigate();
  const { admin } = useAuth();
  const visible = SECTIONS.filter((s) => !s.admin || admin);
  const current = visible.find((s) => s.id === section);

  useEffect(() => {
    if (section && !current) navigate('/settings', { replace: true });
  }, [section, current, navigate]);

  if (!current) {
    return (
      <Page title="Settings" className="bg-surface-2/60">
        <h1 className="mb-6 hidden text-center text-xl font-semibold tracking-tight lg:block">
          Settings
        </h1>
        <SettingsHome />
      </Page>
    );
  }

  return (
    <Page title={current.label} back="/settings" className="bg-surface-2/60">
      <div className="mx-auto max-w-2xl">
        <div className="mb-5 hidden items-center gap-2 lg:flex">
          <Link
            to="/settings"
            className="flex size-8 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-fg"
            aria-label="Back to settings"
          >
            <ArrowLeft className="size-5" />
          </Link>
          <h1 className="text-xl font-semibold tracking-tight">{current.label}</h1>
        </div>
        <PageTitle.Provider value={current.label}>
          {current.id === 'account' && <AccountSection />}
          {current.id === 'security' && <SecuritySection />}
          {current.id === 'appearance' && <AppearanceSection />}
          {current.id === 'personalization' && <PersonalizationSection />}
          {current.id === 'general' && <GeneralSection />}
          {current.id === 'models' && <ModelsSection />}
          {current.id === 'memory' && <MemorySection />}
          {current.id === 'usage' && <UsageSection />}
          {current.id === 'access' && <AccessSection />}
          {current.id === 'about' && <AboutSection />}
        </PageTitle.Provider>
      </div>
    </Page>
  );
}

/** Shown to platform admins and to knowledge administrators (the role lives in config/knowledge, checked by the server). */
function KnowledgeCenterLink({ admin }: { admin: boolean }) {
  const [allowed, setAllowed] = useState(admin);
  useEffect(() => {
    if (admin) return setAllowed(true);
    let live = true;
    api<{ role: string }>('knowledge', { json: { action: 'kcRole' } })
      .then((r) => live && setAllowed(r.role !== 'none'))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [admin]);
  if (!allowed) return null;
  return (
    <NavRow
      to="/admin/knowledge-center"
      icon={ShieldCheck}
      label="Knowledge management"
      value={admin ? 'Admin' : 'Reviewer'}
    />
  );
}
