import { Languages, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Markdown } from '@/components/Markdown';
import { Button, Dialog, IconButton, Select, Spinner } from '@/components/ui';
import { speechConfig, translate, type SpeechConfig } from '@/lib/voice';

export interface TranslationResult {
  text: string;
  source: string;
  target: string;
}

const LAST_KEY = 'atlas:translateTarget';
function lastTarget(): string {
  try {
    return localStorage.getItem(LAST_KEY) ?? 'english';
  } catch {
    return 'english';
  }
}

/** Pick a language and translate `text` with Cloudflare (formatting kept). */
export function TranslateDialog({ open, text, onClose, onDone }: { open: boolean; text: string; onClose: () => void; onDone: (r: TranslationResult) => void }) {
  const [config, setConfig] = useState<SpeechConfig | null>(null);
  const [target, setTarget] = useState(lastTarget);
  const [source, setSource] = useState('auto');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    void speechConfig().then(setConfig);
  }, [open]);

  const languages = config?.languages ?? [];
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await translate(text, target, source === 'auto' ? undefined : source);
      try {
        localStorage.setItem(LAST_KEY, target);
      } catch {
        /* remembering the choice is optional */
      }
      onDone(r);
      onClose();
    } catch (err) {
      const e = err as { code?: string; message?: string };
      setError(e.code === 'source_unknown' ? 'Atlas AI could not tell which language this is in. Choose the original language below.' : (e.message ?? 'Translation failed. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      title="Translate"
      size="sm"
      description="Translated by Cloudflare's free translation model. Only languages that were tested are offered; formatting and code are kept."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={run} disabled={busy || !config?.configured || !languages.length}>
            {busy ? <Spinner className="size-4" /> : <Languages className="size-4" />}
            Translate
          </Button>
        </>
      }
    >
      {config && !config.configured ? (
        <p className="text-sm text-muted">Translation is not available on this server.</p>
      ) : (
        <div className="space-y-3">
          <label className="block text-sm">
            <span className="mb-1 block text-muted">Into</span>
            <Select value={target} onChange={setTarget} options={languages.map((l) => ({ value: l.code, label: l.name }))} />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-muted">From</span>
            <Select value={source} onChange={setSource} options={[{ value: 'auto', label: 'Detect automatically' }, ...languages.map((l) => ({ value: l.code, label: l.name }))]} />
          </label>
          {text.length > 12_000 && <p className="text-xs text-muted">This message is long; only the first 12,000 characters are translated.</p>}
          {error && <p className="text-sm text-danger">{error}</p>}
        </div>
      )}
    </Dialog>
  );
}

const nameOf = (code: string) => code.charAt(0).toUpperCase() + code.slice(1);

/** A translation shown under the message (not saved to the conversation). */
export function TranslationView({ result, onClose }: { result: TranslationResult; onClose: () => void }) {
  return (
    <div className="mt-3 rounded-xl border border-border bg-surface px-3.5 py-3">
      <div className="mb-1.5 flex items-center gap-2 text-xs text-muted">
        <Languages className="size-3.5" />
        <span className="flex-1">
          Translated from {nameOf(result.source)} to {nameOf(result.target)}
        </span>
        <IconButton label="Hide translation" size="sm" onClick={onClose}>
          <X className="size-3.5" />
        </IconButton>
      </div>
      <div className="text-[15px] leading-[1.65]">
        <Markdown content={result.text} />
      </div>
    </div>
  );
}
