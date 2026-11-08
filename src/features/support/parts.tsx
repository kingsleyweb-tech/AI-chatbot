import { ImagePlus, Paperclip, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { Badge, Dialog, Spinner } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useToast } from '@/state/toast';
import { priorityLabel, statusLabel, SUPPORT_LIMITS, type SupportAttachmentRef, type SupportMessageView, type SupportPriority, type SupportStatus } from '@shared/support';
import { prepareScreenshot, supportApi, type NewAttachment } from './api';

export const fmtDate = (ms: number | null | undefined, withTime = true) =>
  ms ? new Date(ms).toLocaleString(undefined, withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' }) : '';

export function errorText(err: unknown, fallback = 'Something went wrong. Please try again.') {
  if (err instanceof ApiError) return err.code === 'admin_unconfigured' ? 'Support is not available on this server yet.' : err.message;
  return err instanceof Error ? err.message : fallback;
}

export function StatusBadge({ status, admin = false }: { status: SupportStatus; admin?: boolean }) {
  const tone = status === 'awaiting_user' ? 'warn' : status === 'new' || status === 'resolved' ? 'accent' : 'neutral';
  return <Badge tone={tone}>{statusLabel(status, admin)}</Badge>;
}

export function PriorityBadge({ priority }: { priority: SupportPriority }) {
  const tone = priority === 'critical' ? 'danger' : priority === 'high' ? 'warn' : 'neutral';
  return <Badge tone={tone}>{priorityLabel(priority)}</Badge>;
}

/** Choose up to 3 screenshots; each is compressed before it is attached. */
export function ScreenshotPicker({ value, onChange, disabled, compact }: { value: NewAttachment[]; onChange: (v: NewAttachment[]) => void; disabled?: boolean; compact?: boolean }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const room = SUPPORT_LIMITS.attachments - value.length;

  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    const list = Array.from(files);
    if (list.length > room) toast(`You can attach up to ${SUPPORT_LIMITS.attachments} screenshots.`, 'error');
    setBusy(true);
    const next = [...value];
    for (const f of list.slice(0, room)) {
      try {
        next.push(await prepareScreenshot(f));
      } catch (err) {
        toast(errorText(err), 'error');
      }
    }
    onChange(next);
    setBusy(false);
    if (input.current) input.current.value = '';
  };

  return (
    <div className={cn('flex flex-wrap items-center gap-2', compact && 'gap-1.5')}>
      {value.map((a, i) => (
        <div key={i} className="relative">
          <img src={a.dataUrl} alt={a.name} className={cn('rounded-lg border border-border object-cover', compact ? 'size-12' : 'size-16')} />
          <button
            type="button"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
            className="tap tap-sm absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-fg text-bg"
            aria-label={`Remove ${a.name}`}
            disabled={disabled}
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
      {room > 0 && (
        <button
          type="button"
          onClick={() => input.current?.click()}
          disabled={disabled || busy}
          className={cn(
            'tap flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-border-strong text-sm text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-50',
            compact ? 'size-12' : value.length ? 'size-16' : 'h-11 px-3',
          )}
          aria-label="Attach a screenshot"
        >
          {busy ? <Spinner className="size-4" /> : <ImagePlus className="size-4" />}
          {!compact && !value.length && !busy && <span>Add screenshot</span>}
        </button>
      )}
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif" multiple hidden onChange={(e) => void add(e.target.files)} />
    </div>
  );
}

/** A stored screenshot. The image is fetched through the server, which checks that the caller may see it. */
export function AttachmentChip({ reportRef, a }: { reportRef: string; a: SupportAttachmentRef }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const show = async () => {
    setOpen(true);
    if (src) return;
    setLoading(true);
    try {
      setSrc((await supportApi.attachment(reportRef, a.id)).dataUrl);
    } catch (err) {
      toast(errorText(err), 'error');
      setOpen(false);
    } finally {
      setLoading(false);
    }
  };
  return (
    <>
      <button type="button" onClick={() => void show()} className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-lg border border-border bg-bg px-2.5 py-1.5 text-xs hover:bg-surface-2">
        <Paperclip className="size-3.5 shrink-0" />
        <span className="truncate">{a.name}</span>
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={a.name} size="lg">
        {loading || !src ? (
          <div className="flex justify-center py-16">
            <Spinner className="size-5" />
          </div>
        ) : (
          <img src={src} alt={a.name} className="mx-auto max-h-[70dvh] rounded-lg object-contain" />
        )}
      </Dialog>
    </>
  );
}

/** Conversation between the user and Atlas Support, including status changes. */
export function ThreadView({ reportRef, messages, viewer }: { reportRef: string; messages: SupportMessageView[]; viewer: 'user' | 'admin' }) {
  if (!messages.length) return <p className="py-6 text-center text-sm text-muted">No replies yet. Atlas Support will answer here.</p>;
  return (
    <ol className="space-y-3">
      {messages.map((m) => {
        if (m.author === 'system') {
          return (
            <li key={m.id} className="flex items-center gap-3 py-1 text-xs text-muted">
              <span className="h-px flex-1 bg-border" />
              <span className="text-center">
                {m.text} · {fmtDate(m.at)}
              </span>
              <span className="h-px flex-1 bg-border" />
            </li>
          );
        }
        const mine = (viewer === 'user' && m.author === 'user') || (viewer === 'admin' && m.author === 'admin');
        const name = viewer === 'admin' ? (m.author === 'admin' ? 'Atlas Support' : 'User') : m.authorName;
        return (
          <li key={m.id} className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
            <div className={cn('max-w-[88%] min-w-0 rounded-2xl px-3.5 py-2.5 sm:max-w-[75%]', mine ? 'bg-accent-soft' : 'border border-border bg-elevated')}>
              <div className="mb-0.5 flex flex-wrap items-baseline gap-x-2 text-xs text-muted">
                <span className="font-medium text-fg">{name}</span>
                {m.kind === 'info_request' && <span className="text-warn">More information requested</span>}
                <span>{fmtDate(m.at)}</span>
              </div>
              {m.text && <p className="text-sm break-words whitespace-pre-wrap">{m.text}</p>}
              {m.attachments.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {m.attachments.map((a) => (
                    <AttachmentChip key={a.id} reportRef={reportRef} a={a} />
                  ))}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Counter shown under a text area, e.g. 120/2000. */
export function Counter({ n, max }: { n: number; max: number }) {
  return <span className={cn('text-xs tabular-nums', n > max ? 'text-danger' : 'text-subtle')}>{`${n}/${max}`}</span>;
}
