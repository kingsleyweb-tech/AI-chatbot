import { getDocs, limit, orderBy, query } from 'firebase/firestore';
import { MessageSquare, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { Spinner } from '@/components/ui';
import { fromSnap, paths } from '@/lib/db';
import type { Conversation } from '@/lib/types';
import { cn, relativeTime } from '@/lib/utils';
import { useUid } from '@/state/auth';

function score(c: Conversation, terms: string[]): number {
  const title = (c.title ?? '').toLowerCase();
  const summary = (c.summary ?? '').toLowerCase();
  let s = 0;
  for (const t of terms) {
    if (title.includes(t)) s += 3;
    else if (summary.includes(t)) s += 1;
    else return 0;
  }
  return s;
}

function highlight(text: string, terms: string[]) {
  if (!terms.length) return text;
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return text.split(re).map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="rounded bg-accent-soft px-0.5 text-accent">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

/** Searches conversation titles and AI-generated summaries. */
export function SearchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const uid = useUid();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [all, setAll] = useState<Conversation[] | null>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setActive(0);
    getDocs(query(paths.conversations(uid), orderBy('updatedAt', 'desc'), limit(500)))
      .then((s) => setAll(s.docs.map((d) => fromSnap<Conversation>(d))))
      .catch(() => setAll([]));
  }, [open, uid]);

  const terms = useMemo(() => q.toLowerCase().split(/\s+/).filter(Boolean), [q]);
  const results = useMemo(() => {
    if (!all) return [];
    if (!terms.length) return all.slice(0, 12);
    return all
      .map((c) => ({ c, s: score(c, terms) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 30)
      .map((x) => x.c);
  }, [all, terms]);

  const go = (c: Conversation) => {
    onClose();
    navigate(`/c/${c.id}`);
  };

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center px-3 pt-[max(env(safe-area-inset-top),12px)] sm:pt-[12vh]">
          <motion.div
            className="absolute inset-0 bg-black/30 dark:bg-black/50"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.15 }}
            className="relative w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-elevated shadow-2xl"
          >
            <div className="flex items-center gap-2.5 border-b border-border px-4">
              <Search className="size-[18px] text-subtle" />
              <input
                autoFocus
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setActive(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setActive((a) => Math.min(a + 1, results.length - 1));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setActive((a) => Math.max(a - 1, 0));
                  } else if (e.key === 'Enter' && results[active]) go(results[active]);
                  else if (e.key === 'Escape') onClose();
                }}
                placeholder="Search conversations"
                className="h-13 min-w-0 flex-1 bg-transparent py-4 text-[15px] outline-none placeholder:text-subtle"
              />
              <button onClick={onClose} className="text-xs text-muted hover:text-fg">
                Esc
              </button>
            </div>
            <div className="scroll-thin max-h-[60dvh] overflow-y-auto p-1.5">
              {!all ? (
                <div className="flex justify-center py-8">
                  <Spinner />
                </div>
              ) : !results.length ? (
                <p className="px-3 py-8 text-center text-sm text-muted">{terms.length ? 'No matching conversations.' : 'No conversations yet.'}</p>
              ) : (
                <>
                  {!terms.length && <div className="px-3 pb-1 pt-2 text-[11px] font-medium text-subtle">Recent</div>}
                  {results.map((c, i) => (
                    <button
                      key={c.id}
                      onClick={() => go(c)}
                      onMouseEnter={() => setActive(i)}
                      className={cn('flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left', i === active && 'bg-surface-2')}
                    >
                      <MessageSquare className="mt-0.5 size-4 shrink-0 text-subtle" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{highlight(c.title || 'New chat', terms)}</span>
                        {c.summary && <span className="mt-0.5 line-clamp-2 block text-xs text-muted">{highlight(c.summary, terms)}</span>}
                      </span>
                      <span className="shrink-0 text-[11px] text-subtle">{relativeTime(c.updatedAt)}</span>
                    </button>
                  ))}
                </>
              )}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
