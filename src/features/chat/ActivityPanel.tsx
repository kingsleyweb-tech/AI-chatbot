import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Check, ChevronDown, Circle, Loader2, X } from 'lucide-react';
import { useId, useState } from 'react';
import { cn } from '@/lib/utils';
import { activitySummary, type ActivityStep } from './activity';

function StepIcon({ state }: { state: ActivityStep['state'] }) {
  if (state === 'active') return <Loader2 className="size-3.5 animate-spin text-accent" aria-hidden="true" />;
  if (state === 'done') return <Check className="size-3.5 text-accent" aria-hidden="true" />;
  if (state === 'failed') return <X className="size-3.5 text-warn" aria-hidden="true" />;
  return <Circle className="size-3 text-subtle" aria-hidden="true" />;
}

const STATE_TEXT: Record<ActivityStep['state'], string> = { pending: 'waiting', active: 'in progress', done: 'completed', failed: 'did not complete' };

/**
 * What Atlas AI did for a reply (searches, pages read, documents, image stages), compact by
 * default and expandable into the list of steps. Built only from real events (see activity.ts).
 */
export function ActivityPanel({ steps, live }: { steps: ActivityStep[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const reduce = useReducedMotion();
  const listId = useId();
  // memories and earlier chats alone are shown by the "used N memories" line, not as steps
  if (!steps.some((s) => s.kind !== 'memory' && s.kind !== 'history' && s.kind !== 'write')) return null;
  const active = steps.some((s) => s.state === 'active');
  const failed = steps.some((s) => s.state === 'failed' && s.kind !== 'skip');
  return (
    <div className="mb-2.5 max-w-full text-xs">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={listId}
        className="group inline-flex max-w-full items-center gap-1 text-left text-subtle transition-colors hover:text-muted"
      >
        {active ? (
          <Loader2 className="size-3 shrink-0 animate-spin text-accent" aria-hidden="true" />
        ) : failed ? (
          <X className="size-3 shrink-0 text-warn" aria-hidden="true" />
        ) : (
          <Check className="size-3 shrink-0 text-accent" aria-hidden="true" />
        )}
        <span className="min-w-0 truncate" aria-live={live ? 'polite' : undefined}>
          {activitySummary(steps)}
        </span>
        <ChevronDown className={cn('size-3 shrink-0 transition-transform', open && 'rotate-180')} aria-hidden="true" />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.ol
            id={listId}
            key="steps"
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="mt-1 overflow-hidden pl-0.5"
          >
            {steps.map((s, i) => (
              <li key={s.id} className="relative flex gap-2.5 py-1.5">
                {/* the line joining the steps */}
                {i < steps.length - 1 && <span className="absolute top-6 bottom-[-6px] left-[7px] w-px bg-border" aria-hidden="true" />}
                <span className="relative z-[1] mt-px flex size-[15px] shrink-0 items-center justify-center rounded-full bg-bg">
                  <StepIcon state={s.state} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cn('block', s.state === 'pending' ? 'text-subtle' : 'text-fg')}>
                    {s.label}
                    {s.state === 'active' && '…'}
                    <span className="sr-only"> ({STATE_TEXT[s.state]})</span>
                  </span>
                  {s.detail && <span className="block break-words text-[11.5px] leading-snug text-muted">{s.detail}</span>}
                </span>
              </li>
            ))}
          </motion.ol>
        )}
      </AnimatePresence>
    </div>
  );
}
