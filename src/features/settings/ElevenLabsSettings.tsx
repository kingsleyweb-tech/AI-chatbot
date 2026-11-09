/**
 * ElevenLabs settings: the person's voice choice (Cloudflare stays the default) and, for
 * administrators, the on/off switch, credit caps, usage, request history and Voice Design.
 * No key or ElevenLabs call is ever made from the browser; everything goes through /api/speech.
 */
import { Pause, Play, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, ConfirmDialog, Input, Select, Spinner, Switch, Textarea } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { relativeTime } from '@/lib/utils';
import {
  elevenAdmin,
  elevenPreview,
  resetElevenPause,
  speechConfig,
  type DesignPreview,
  type ElevenConfig,
  type ElevenSettings,
  type ElevenStatus,
} from '@/lib/voice';
import { useSettings } from '@/state/settings';
import { useToast } from '@/state/toast';
import { Row } from './parts';

const errorText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : 'Something went wrong.');

/** One shared player for samples, so only one plays at a time. */
function useSamplePlayer() {
  const el = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const stop = useCallback(() => {
    el.current?.pause();
    setPlaying(null);
  }, []);
  const play = useCallback(
    (key: string, src: string) => {
      stop();
      const a = (el.current ??= new Audio());
      a.src = src;
      a.onended = () => setPlaying(null);
      setPlaying(key);
      void a.play().catch(() => setPlaying(null));
    },
    [stop],
  );
  useEffect(() => stop, [stop]);
  return { playing, play, stop };
}

/* ------------------------------ the person's choice ------------------------------ */

export function ElevenVoiceRows({ info }: { info: ElevenConfig | undefined }) {
  const { settings, update } = useSettings();
  const toast = useToast();
  const player = useSamplePlayer();
  const [loading, setLoading] = useState<string | null>(null);
  if (!info?.configured || !info.enabled) return null;

  const usingEleven = settings.voiceProvider === 'elevenlabs';
  const voices = info.voices ?? [];
  const voiceId = settings.elevenVoiceId && voices.some((v) => v.id === settings.elevenVoiceId) ? settings.elevenVoiceId : (info.defaultVoice ?? voices[0]?.id ?? '');
  const model = settings.elevenModel ?? info.defaultModel ?? '';
  const speed = settings.elevenSpeed ?? 1;

  const preview = async () => {
    if (player.playing === voiceId) return player.stop();
    setLoading(voiceId);
    try {
      player.play(voiceId, await elevenPreview(voiceId, model, speed));
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setLoading(null);
    }
  };

  return (
    <>
      <Row
        title="Natural voice provider"
        description={
          usingEleven
            ? `ElevenLabs voice for Read aloud and Voice Mode${info.charactersLeft != null ? `: about ${info.charactersLeft.toLocaleString()} characters left for you today` : ''}. When it is used up, the Cloudflare voice takes over.`
            : 'Cloudflare is the default. ElevenLabs offers more voices, with a smaller daily allowance.'
        }
      >
        <Select
          className="sm:w-48"
          value={settings.voiceProvider}
          onChange={(v) => {
            resetElevenPause();
            void update({ voiceProvider: v });
          }}
          options={[
            { value: 'cloudflare', label: 'Cloudflare (default)' },
            { value: 'elevenlabs', label: 'ElevenLabs' },
          ]}
        />
      </Row>
      {usingEleven && (
        <>
          <Row title="ElevenLabs voice" description={voices.find((v) => v.id === voiceId)?.description}>
            <div className="flex items-center gap-2">
              <Select className="sm:w-48" value={voiceId} onChange={(v) => void update({ elevenVoiceId: v })} options={voices.map((v) => ({ value: v.id, label: v.source === 'designed' ? `${v.name} (designed)` : v.name }))} />
              <Button
                variant="outline"
                size="md"
                loading={loading === voiceId}
                icon={player.playing === voiceId ? <Pause className="size-4" /> : <Play className="size-4" />}
                onClick={() => void preview()}
                aria-label={player.playing === voiceId ? 'Stop sample' : 'Play a sample of this voice'}
              >
                Sample
              </Button>
            </div>
          </Row>
          <Row title="Voice quality" description={info.models?.find((m) => m.id === model)?.description}>
            <Select className="sm:w-48" value={model} onChange={(v) => void update({ elevenModel: v })} options={(info.models ?? []).map((m) => ({ value: m.id, label: m.label }))} />
          </Row>
          <Row title="Speaking speed" description={`${speed.toFixed(2)}×`}>
            <input
              type="range"
              aria-label="Speaking speed"
              className="w-full accent-[var(--color-accent)] sm:w-48"
              min={info.speed?.min ?? 0.7}
              max={info.speed?.max ?? 1.2}
              step={0.05}
              value={speed}
              onChange={(e) => void update({ elevenSpeed: Number(e.target.value) })}
            />
          </Row>
        </>
      )}
    </>
  );
}

/* ------------------------------ administrators ------------------------------ */

const STATUS_LABEL: Record<string, string> = {
  available: 'Available',
  missing_permission: 'Key permission missing',
  needs_hosting: 'Needs a separate server',
  needs_plan: 'Needs a higher plan',
  not_needed: 'Not needed',
  not_built: 'In the plan, not built yet',
  unknown: 'Found out on first use',
};

export function ElevenAdminPanel() {
  const toast = useToast();
  const [status, setStatus] = useState<ElevenStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    elevenAdmin('status')
      .then((s) => {
        setStatus(s);
        setError(null);
      })
      .catch((err) => setError(errorText(err)));
  }, []);
  useEffect(load, [load]);
  const [checking, setChecking] = useState(false);
  const checkAgain = async () => {
    setChecking(true);
    try {
      setStatus(await elevenAdmin('refresh'));
      toast('Checked the ElevenLabs account again.', 'success');
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setChecking(false);
    }
  };

  const save = async (patch: Partial<ElevenSettings>) => {
    try {
      const { settings } = await elevenAdmin('settings', { settings: patch });
      setStatus((s) => (s ? { ...s, settings } : s));
      resetElevenPause();
      void speechConfig(true);
      toast('Saved.', 'success');
    } catch (err) {
      toast(errorText(err), 'error');
    }
  };

  return (
    <>
      <h3 className="bg-surface-2/50 py-2 text-xs font-medium uppercase tracking-wide text-muted">Admin: ElevenLabs voice (all users)</h3>
      {error && <p className="py-3 text-sm text-danger">{error}</p>}
      {!status && !error && (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      )}
      {status && !status.configured && <p className="py-3 text-sm text-muted">ElevenLabs is not set up on this server (ELEVENLABS_API_KEY is missing).</p>}
      {status?.configured && (
        <>
          <Row title="Offer the ElevenLabs voice" description="People can then choose it in Settings. The Cloudflare voice stays the default, and nobody is switched automatically.">
            <Switch label="Offer the ElevenLabs voice" checked={status.settings.enabled} onChange={(v) => void save({ enabled: v })} />
          </Row>
          <CapRow label="App credits per day" value={status.settings.appDailyCredits} used={status.usage?.day.credits} onSave={(n) => save({ appDailyCredits: n })} />
          <CapRow label="App credits per month" value={status.settings.appMonthlyCredits} used={status.usage?.month.credits} onSave={(n) => save({ appMonthlyCredits: n })} />
          <CapRow label="Credits per person per day" value={status.settings.userDailyCredits} onSave={(n) => save({ userDailyCredits: n })} />
          <Row title="Default quality" description="Used when a person has not chosen one.">
            <Select
              className="sm:w-48"
              value={status.settings.defaultModel}
              onChange={(v) => void save({ defaultModel: v })}
              options={[
                { value: 'eleven_flash_v2_5', label: 'Fast (Flash v2.5)' },
                { value: 'eleven_multilingual_v2', label: 'High quality (Multilingual v2)' },
              ]}
            />
          </Row>
          {status.usage && (
            <p className="py-3 text-xs text-muted">
              Today: {status.usage.day.requests} requests, {status.usage.day.characters.toLocaleString()} characters, {status.usage.day.credits.toLocaleString()} credits
              {status.usage.day.failed ? `, ${status.usage.day.failed} failed` : ''}. This month: {status.usage.month.credits.toLocaleString()} credits (as reported per
              request).{' '}
              {status.plan
                ? `ElevenLabs account: ${status.plan.tier} plan, ${status.plan.used.toLocaleString()} of ${status.plan.limit.toLocaleString()} credits used this period${
                    status.plan.resetsAt ? `, resets ${new Date(status.plan.resetsAt).toLocaleDateString()}` : ''
                  }.`
                : 'The account balance needs the User (read) key permission.'}
            </p>
          )}
          <Capabilities items={status.capabilities} checkedAt={status.checkedAt} checking={checking} onCheck={() => void checkAgain()} />
          <RecentRequests rows={status.recent} />
          <VoiceDesign status={status} onChanged={load} />
        </>
      )}
    </>
  );
}

function CapRow({ label, value, used, onSave }: { label: string; value: number; used?: number; onSave: (n: number) => Promise<void> }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Math.round(Number(draft));
    if (!Number.isFinite(n) || n < 0) return setDraft(String(value));
    if (n !== value) void onSave(n);
  };
  return (
    <Row title={label} description={used != null ? `${used.toLocaleString()} used` : undefined}>
      <Input className="sm:w-32" inputMode="numeric" aria-label={label} value={draft} onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ''))} onBlur={commit} />
    </Row>
  );
}

function Capabilities({ items, checkedAt, checking, onCheck }: { items: ElevenStatus['capabilities']; checkedAt: number | null; checking: boolean; onCheck: () => void }) {
  return (
    <div className="py-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-muted">
          What this ElevenLabs account can do in Atlas AI. Checked automatically
          {checkedAt ? ` (last ${relativeTime(new Date(checkedAt))})` : ''}; features turn on by themselves after a plan upgrade or a new key.
        </div>
        <Button variant="secondary" onClick={onCheck} disabled={checking}>
          {checking ? 'Checking…' : 'Check again'}
        </Button>
      </div>
      <ul className="space-y-2 text-sm">
        {items.map((c) => (
          <li key={c.id}>
            <div className="flex flex-col sm:flex-row sm:justify-between sm:gap-4">
              <span>{c.label}</span>
              <span className={c.status === 'available' ? 'text-accent' : 'text-muted'}>{STATUS_LABEL[c.status] ?? c.status}</span>
            </div>
            {c.note && <div className="text-xs text-muted">{c.note}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function RecentRequests({ rows }: { rows: ElevenStatus['recent'] }) {
  if (!rows.length) return <p className="py-3 text-xs text-muted">No ElevenLabs requests yet.</p>;
  return (
    <div className="overflow-x-auto py-3">
      <div className="mb-2 text-xs text-muted">Recent requests (no text is stored)</div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted">
            <th className="pb-1 font-normal">When</th>
            <th className="pb-1 font-normal">Type</th>
            <th className="pb-1 text-right font-normal">Characters</th>
            <th className="pb-1 text-right font-normal">Credits</th>
            <th className="pb-1 text-right font-normal">Result</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.at}-${i}`} className="border-t border-border">
              <td className="py-1.5 pr-3 text-muted">{relativeTime(new Date(r.at))}</td>
              <td className="py-1.5 pr-3">{r.type}</td>
              <td className="py-1.5 pl-3 text-right tabular-nums text-muted">{r.characters}</td>
              <td className="py-1.5 pl-3 text-right tabular-nums text-muted">{r.credits}</td>
              <td className={r.ok ? 'py-1.5 pl-3 text-right text-muted' : 'py-1.5 pl-3 text-right text-danger'}>{r.ok ? `ok${r.ms ? ` · ${(r.ms / 1000).toFixed(1)} s` : ''}` : (r.error ?? 'failed')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function VoiceDesign({ status, onChanged }: { status: ElevenStatus; onChanged: () => void }) {
  const toast = useToast();
  const player = useSamplePlayer();
  const [description, setDescription] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [previews, setPreviews] = useState<DesignPreview[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [consent, setConsent] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const designed = status.voices.filter((v) => v.source === 'designed');
  const textOk = text.trim().length >= 100 && text.trim().length <= 1000;
  const capability = status.capabilities.find((c) => c.id === 'voice_design');

  const design = async () => {
    setBusy(true);
    setPreviews([]);
    setChosen(null);
    try {
      const out = await elevenAdmin('design', { description: description.trim(), text: text.trim() });
      setPreviews(out.previews);
      toast(out.credits != null ? `Previews ready (${out.credits} credits).` : 'Previews ready.', 'success');
      onChanged();
    } catch (err) {
      toast(errorText(err), 'error');
      onChanged(); // a plan refusal changes what the capability list shows
    } finally {
      setBusy(false);
    }
  };

  if (capability && capability.status === 'needs_plan') {
    return (
      <div className="py-4">
        <div className="text-[15px]">Voice Design</div>
        <p className="mt-0.5 text-xs text-muted">
          Not available on the current ElevenLabs plan. {capability.note} The default voices work on the current plan.
        </p>
      </div>
    );
  }

  const saveVoice = async () => {
    if (!chosen) return;
    setBusy(true);
    try {
      await elevenAdmin('save', { generatedVoiceId: chosen, name: name.trim(), description: description.trim().slice(0, 1000), consent: true });
      toast('Voice saved. People can now choose it.', 'success');
      setPreviews([]);
      setChosen(null);
      setName('');
      setConsent(false);
      onChanged();
      void speechConfig(true);
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 py-4">
      <div>
        <div className="text-[15px]">Voice Design</div>
        <p className="mt-0.5 text-xs text-muted">
          Create a new voice from a written description. Each attempt uses credits (about one per character of sample text) and returns up to three previews. Atlas AI
          never copies a voice from a recording of a person.
        </p>
      </div>
      <Textarea aria-label="Voice description" placeholder="For example: a calm, warm woman in her forties with a light Ghanaian English accent, speaking clearly at a relaxed pace." rows={2} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} />
      <Textarea aria-label="Sample text" placeholder="Sample text the previews will read (100 to 1,000 characters)." rows={3} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted">{text.trim().length} / 1000 characters</span>
        <Button variant="primary" loading={busy && !previews.length} disabled={description.trim().length < 20 || !textOk || busy} onClick={() => void design()}>
          Create previews
        </Button>
      </div>
      {previews.length > 0 && (
        <div className="space-y-2">
          {previews.map((p, i) => (
            <label key={p.generatedVoiceId} className="flex items-center gap-3 rounded-xl border border-border p-2.5">
              <input type="radio" name="design-preview" checked={chosen === p.generatedVoiceId} onChange={() => setChosen(p.generatedVoiceId)} />
              <span className="flex-1 text-sm">
                Preview {i + 1} <span className="text-muted">· {p.durationSecs.toFixed(1)} s</span>
              </span>
              <Button
                variant="outline"
                size="sm"
                icon={player.playing === p.generatedVoiceId ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                onClick={(e) => {
                  e.preventDefault();
                  if (player.playing === p.generatedVoiceId) player.stop();
                  else player.play(p.generatedVoiceId, `data:${p.mediaType};base64,${p.audioBase64}`);
                }}
              >
                Listen
              </Button>
            </label>
          ))}
          {chosen && (
            <div className="space-y-2 rounded-xl bg-surface-2/50 p-3">
              <Input aria-label="Voice name" placeholder="Voice name" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                <span>{status.consentStatement}</span>
              </label>
              <Button variant="primary" loading={busy} disabled={!consent || name.trim().length < 2} onClick={() => void saveVoice()}>
                Save voice
              </Button>
            </div>
          )}
        </div>
      )}
      {designed.length > 0 && (
        <div>
          <div className="mb-1 text-xs text-muted">Designed voices</div>
          <ul className="divide-y divide-border text-sm">
            {designed.map((v) => (
              <li key={v.id} className="flex items-center justify-between gap-3 py-1.5">
                <span className="min-w-0 truncate">{v.name}</span>
                <Button variant="ghost" size="sm" icon={<Trash2 className="size-3.5" />} onClick={() => setRemoving(v.id)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <ConfirmDialog
        open={removing !== null}
        title="Remove this voice?"
        message="It will no longer be offered in Atlas AI. People using it switch to the default voice."
        confirmLabel="Remove"
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          const id = removing!;
          setRemoving(null);
          try {
            const r = await elevenAdmin('remove', { voiceId: id });
            toast(r.deletedAtElevenLabs ? 'Voice removed.' : 'Voice hidden in Atlas AI. Delete it in the ElevenLabs dashboard too (the key cannot delete voices).', 'success');
            onChanged();
          } catch (err) {
            toast(errorText(err), 'error');
          }
        }}
      />
    </div>
  );
}
