import { AnimatePresence, motion } from 'framer-motion';
import { Library, X } from 'lucide-react';
import { lazy, Suspense, useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Source } from '@shared/types';
import { IconButton } from '@/components/ui';
import { cn, domainOf } from '@/lib/utils';

const SaveToKnowledgeDialog = lazy(() => import('../knowledge/SaveToKnowledge').then((m) => ({ default: m.SaveToKnowledgeDialog })));

/** "gna.org" -> "Gna.Org", the way a site is named in the list. */
export function siteLabel(s: Pick<Source, 'url' | 'site'>): string {
  const domain = domainOf(s.url ?? '');
  if (s.site && s.site.toLowerCase() !== domain.toLowerCase() && s.site.length <= 40) return s.site;
  return domain
    .split('.')
    .map((p) => (p ? p[0]!.toUpperCase() + p.slice(1) : p))
    .join('.');
}

/** "2024-12-09" -> "9 Dec 2024"; anything else is shown as it came. */
export function sourceDate(value: string | undefined): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return value.slice(0, 40);
  return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** The site's logo (its favicon), or its first letter when there is none. */
export function SiteLogo({ url, className }: { url: string; className?: string }) {
  const domain = domainOf(url);
  const [failed, setFailed] = useState(false);
  if (failed || !domain || domain === url) {
    return (
      <span className={cn('flex shrink-0 items-center justify-center rounded-full bg-surface-2 text-[9px] font-semibold uppercase text-muted', className)}>
        {domain.charAt(0) || '?'}
      </span>
    );
  }
  return (
    <img
      src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={cn('shrink-0 rounded-full bg-white object-contain', className)}
    />
  );
}

/** "Sources" button for the action row: up to three overlapping logos, opens the list. */
export function SourcesButton({ sources, onOpen }: { sources: Source[]; onOpen: () => void }) {
  // one logo per site
  const logos = sources.filter((s, i, all) => s.url && all.findIndex((x) => domainOf(x.url ?? '') === domainOf(s.url ?? '')) === i).slice(0, 3);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="tap ml-1 inline-flex h-7 items-center gap-1.5 rounded-full px-2 text-[12px] text-muted transition-colors hover:bg-surface-2 hover:text-fg"
      aria-label={`Sources (${sources.length})`}
    >
      <span className="flex items-center">
        {logos.map((s, i) => (
          <SiteLogo key={s.index} url={s.url!} className={cn('size-[18px] ring-2 ring-bg', i > 0 && '-ml-1.5')} />
        ))}
      </span>
      Sources
    </button>
  );
}

/** Every web source of a reply, from the bottom of the screen on a phone (a centred panel on larger screens). */
export function SourcesSheet({ open, onClose, sources }: { open: boolean; onClose: () => void; sources: Source[] }) {
  const titleId = useId();
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <>
      {createPortal(
        <AnimatePresence>
          {open && (
            <div className="vv-overlay z-50 flex items-end justify-center sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby={titleId}>
              <motion.div
                className="absolute inset-0 bg-black/30 dark:bg-black/50"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                onClick={onClose}
              />
              <motion.div
                initial={{ y: '100%' }}
                animate={{ y: 0 }}
                exit={{ y: '100%' }}
                transition={{ type: 'spring', damping: 32, stiffness: 340 }}
                // swipe down to close (phones)
                drag="y"
                dragConstraints={{ top: 0, bottom: 0 }}
                dragElastic={{ top: 0, bottom: 0.6 }}
                onDragEnd={(_, info) => {
                  if (info.offset.y > 90 || info.velocity.y > 600) onClose();
                }}
                className="relative flex max-h-[min(80%,720px)] w-full flex-col overflow-hidden rounded-t-3xl border border-border bg-elevated shadow-2xl sm:max-w-lg sm:rounded-2xl"
              >
                <div className="flex justify-center pt-2.5 sm:hidden">
                  <span className="h-1.5 w-10 rounded-full bg-border-strong" />
                </div>
                <div className="flex items-center justify-between border-b border-border px-5 pb-3 pt-3 sm:pt-4">
                  <h2 id={titleId} className="text-sm font-medium text-muted">
                    Sources
                  </h2>
                  <IconButton label="Close" size="sm" onClick={onClose} className="-mr-1.5">
                    <X className="size-4" />
                  </IconButton>
                </div>
                <ul className="scroll-thin touch-scroll min-h-0 flex-1 overflow-y-auto px-5 pb-[max(env(safe-area-inset-bottom),12px)]" onPointerDownCapture={(e) => e.stopPropagation()}>
                  {sources.map((s) => {
                    const date = sourceDate(s.publishedDate);
                    return (
                      <li key={s.index} className="border-b border-border last:border-b-0">
                        <a href={s.url} target="_blank" rel="noopener noreferrer" className="block py-3.5 transition-opacity hover:opacity-80">
                          <span className="flex items-center gap-2 text-[13px] text-muted">
                            <SiteLogo url={s.url!} className="size-5" />
                            <span className="truncate">{siteLabel(s)}</span>
                          </span>
                          <span className="mt-1 block text-[15px] font-medium leading-snug text-fg">{s.title || domainOf(s.url ?? '')}</span>
                          {date && <span className="mt-0.5 block text-[13px] text-subtle">{date}</span>}
                        </a>
                      </li>
                    );
                  })}
                  <li className="py-3">
                    <button
                      onClick={() => setSaving(true)}
                      className="flex items-center gap-1.5 rounded-lg px-1 py-1 text-[13px] text-muted hover:text-fg"
                      title="Save these pages to your knowledge base"
                    >
                      <Library className="size-4" />
                      Save to knowledge base
                    </button>
                  </li>
                </ul>
              </motion.div>
            </div>
          )}
        </AnimatePresence>,
        document.body,
      )}
      {saving && (
        <Suspense fallback={null}>
          <SaveToKnowledgeDialog open={saving} onClose={() => setSaving(false)} sources={sources} />
        </Suspense>
      )}
    </>
  );
}
