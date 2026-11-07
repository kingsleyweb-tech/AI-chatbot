import { AnimatePresence, motion } from 'framer-motion';
import { Brain, Check, ChevronDown, Code2, Eye, Mic, RefreshCw, Search, Wrench } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ModelInfo } from '@shared/types';
import { Badge, Spinner } from '@/components/ui';
import { cn, formatTokens, modelShortName } from '@/lib/utils';
import { useIsDesktop } from '@/lib/viewport';
import { useCatalog } from '@/state/catalog';

type Filter = 'featured' | 'free' | 'vision' | 'gemini' | 'all';

export function CapabilityBadges({ m, compact }: { m: ModelInfo; compact?: boolean }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {m.free ? <Badge tone="accent">Free</Badge> : <Badge>Paid</Badge>}
      {m.capabilities.vision && (
        <Badge>
          <Eye className="size-3" />
          {!compact && 'Vision'}
        </Badge>
      )}
      {m.capabilities.audioInput && !compact && (
        <Badge>
          <Mic className="size-3" />
          Audio
        </Badge>
      )}
      {m.capabilities.code && !compact && (
        <Badge>
          <Code2 className="size-3" />
          Code
        </Badge>
      )}
      {m.capabilities.reasoning && (
        <Badge>
          <Brain className="size-3" />
          {!compact && 'Reasoning'}
        </Badge>
      )}
      {m.capabilities.tools && !compact && (
        <Badge>
          <Wrench className="size-3" />
          Tools
        </Badge>
      )}
      {m.contextLength > 0 && <Badge>{formatTokens(m.contextLength)} ctx</Badge>}
      {m.capabilities.imageOutput && !compact && <Badge>Image output (not used in app)</Badge>}
    </span>
  );
}

function ModelRow({
  m,
  selected,
  onSelect,
  needsCredits,
}: {
  m: ModelInfo;
  selected: boolean;
  onSelect: () => void;
  needsCredits: boolean;
}) {
  return (
    <button
      onClick={onSelect}
      className={cn(
        'flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-surface-2',
        selected && 'bg-accent-soft hover:bg-accent-soft',
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{m.name}</span>
          {needsCredits && <Badge tone="warn">Needs credits</Badge>}
        </span>
        <span className="mt-0.5 block truncate text-xs text-muted">
          {m.vendor} · via {m.provider === 'openrouter' ? 'OpenRouter' : m.provider === 'gemini' ? 'Google AI Studio' : m.provider}
          {m.pricing && !m.free ? ` · $${m.pricing.prompt}/$${m.pricing.completion} per 1M tokens` : ''}
        </span>
        {m.description && <span className="mt-1 line-clamp-2 block text-xs text-subtle">{m.description}</span>}
        <span className="mt-1.5 block">
          <CapabilityBadges m={m} />
        </span>
      </span>
      {selected && <Check className="mt-0.5 size-4 shrink-0 text-accent" />}
    </button>
  );
}

export function ModelPicker({
  value,
  onChange,
  align = 'start',
}: {
  value: string;
  onChange: (id: string) => void;
  align?: 'start' | 'end';
}) {
  const { catalog, loading, error, reload, getModel } = useCatalog();
  const isDesktop = useIsDesktop();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('featured');
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number }>({ top: 0 });
  const current = getModel(value);

  useLayoutEffect(() => {
    if (!open || !btn.current || !isDesktop) return;
    const r = btn.current.getBoundingClientRect();
    setPos(align === 'start' ? { top: r.bottom + 6, left: Math.max(8, r.left) } : { top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
  }, [open, isDesktop, align]);

  useEffect(() => {
    if (!open) return;
    setQ('');
    const close = (e: Event) => {
      if (panel.current?.contains(e.target as Node) || btn.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const models = useMemo(() => {
    const all = catalog?.models ?? [];
    const term = q.trim().toLowerCase();
    let list = all;
    if (term) list = all.filter((m) => `${m.name} ${m.id} ${m.vendor}`.toLowerCase().includes(term));
    else if (filter === 'featured') list = all.filter((m) => m.featured);
    else if (filter === 'free') list = all.filter((m) => m.free);
    else if (filter === 'vision') list = all.filter((m) => m.capabilities.vision);
    else if (filter === 'gemini') list = all.filter((m) => m.provider === 'gemini');
    const featuredOrder = (catalog?.models ?? []).filter((m) => m.featured).map((m) => m.id);
    return [...list].sort((a, b) => {
      if (a.featured !== b.featured) return a.featured ? -1 : 1;
      if (a.featured && b.featured) return featuredOrder.indexOf(a.id) - featuredOrder.indexOf(b.id);
      if (a.free !== b.free) return a.free ? -1 : 1;
      return a.name.localeCompare(b.name);
    }).slice(0, 150);
  }, [catalog, q, filter]);

  const paidOk = catalog?.paidAvailable !== false;

  const content = (
    <div className="flex max-h-full min-h-0 flex-col">
      <div className="space-y-2 border-b border-border p-3">
        <div className="flex h-9 items-center gap-2 rounded-lg bg-surface-2 px-2.5">
          <Search className="size-4 text-subtle" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search models"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-subtle"
          />
        </div>
        {!q && (
          <div className="flex gap-1">
            {(['featured', 'free', 'vision', 'gemini', 'all'] as Filter[]).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors',
                  filter === f ? 'bg-fg text-bg' : 'text-muted hover:bg-surface-2',
                )}
              >
                {f}
              </button>
            ))}
          </div>
        )}
      </div>
      {!paidOk && (
        <p className="border-b border-border bg-warn-soft px-4 py-2 text-xs text-warn">
          The OpenRouter account has no credits, so only free models will respond. Paid models ask for your approval first.
        </p>
      )}
      <div className="scroll-thin touch-scroll min-h-0 flex-1 overflow-y-auto p-1.5">
        {!catalog && loading ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : !catalog && error ? (
          <div className="px-4 py-8 text-center text-sm text-muted">
            <p>{error}</p>
            <button onClick={reload} className="mt-3 inline-flex items-center gap-1.5 text-accent">
              <RefreshCw className="size-3.5" /> Retry
            </button>
          </div>
        ) : !models.length ? (
          <p className="px-4 py-8 text-center text-sm text-muted">No models match.</p>
        ) : (
          models.map((m) => (
            <ModelRow
              key={m.id}
              m={m}
              selected={m.id === value}
              needsCredits={!m.free && !paidOk}
              onSelect={() => {
                onChange(m.id);
                setOpen(false);
              }}
            />
          ))
        )}
      </div>
    </div>
  );

  return (
    <>
      <button
        ref={btn}
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 min-w-0 items-center gap-1.5 rounded-lg px-2.5 text-[15px] font-medium transition-colors hover:bg-surface-2"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className="truncate">{current?.name ?? modelShortName(value) ?? 'Choose model'}</span>
        <ChevronDown className="size-4 shrink-0 text-subtle" />
      </button>
      {createPortal(
        <AnimatePresence>
          {open &&
            (isDesktop ? (
              <motion.div
                ref={panel}
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.13 }}
                style={{ position: 'fixed', ...pos }}
                className="z-[60] flex max-h-[min(70vh,620px)] w-[420px] flex-col overflow-hidden rounded-2xl border border-border bg-elevated shadow-2xl"
              >
                {content}
              </motion.div>
            ) : (
              <div className="fixed inset-0 z-[60] flex items-end">
                <motion.div
                  className="absolute inset-0 bg-black/30 dark:bg-black/50"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                />
                <motion.div
                  ref={panel}
                  initial={{ y: '100%' }}
                  animate={{ y: 0 }}
                  exit={{ y: '100%' }}
                  transition={{ type: 'spring', damping: 32, stiffness: 340 }}
                  className="relative flex h-[78dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-border bg-elevated pb-safe shadow-2xl"
                >
                  <div className="mx-auto mt-2 h-1 w-9 rounded-full bg-border-strong" />
                  <div className="px-4 pt-3 text-base font-semibold">Choose a model</div>
                  {content}
                </motion.div>
              </div>
            ))}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}
