import { CheckCircle2, LifeBuoy, RotateCcw, Send } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { Button, ConfirmDialog, EmptyState, Spinner } from '@/components/ui';
import { useToast } from '@/state/toast';
import { categoryLabel, SUPPORT_LIMITS } from '@shared/support';
import { useMarkRead } from '../notifications/useNotifications';
import { Page } from '../shell/Page';
import { supportApi, type NewAttachment, type Thread } from './api';
import { AttachmentChip, Counter, errorText, fmtDate, ScreenshotPicker, StatusBadge, ThreadView } from './parts';

export default function ReportThreadPage() {
  const { ref = '' } = useParams();
  const toast = useToast();
  const [data, setData] = useState<Thread | null>(null);
  const [error, setError] = useState<{ status: number; text: string } | null>(null);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<NewAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<'confirm' | 'reopen' | null>(null);
  useMarkRead(ref);

  const load = useCallback(async () => {
    try {
      setData(await supportApi.get(ref));
      setError(null);
    } catch (err) {
      setError({ status: (err as { status?: number }).status ?? 0, text: errorText(err, 'This report could not be loaded.') });
    }
  }, [ref]);

  useEffect(() => {
    void load();
    const onVisible = () => document.visibilityState === 'visible' && void load();
    document.addEventListener('visibilitychange', onVisible);
    // a new notification for this report (reply or status change) arrived
    const onNotified = (e: Event) => (e as CustomEvent<string[]>).detail?.includes(ref) && void load();
    window.addEventListener('atlas:notified', onNotified);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('atlas:notified', onNotified);
    };
  }, [load, ref]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || (!text.trim() && !files.length)) return;
    setBusy(true);
    try {
      setData(await supportApi.message(ref, text.trim(), files));
      setText('');
      setFiles([]);
    } catch (err) {
      toast(errorText(err, 'Your message could not be sent.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const act = async () => {
    const kind = confirm;
    if (!kind) return;
    try {
      setData(kind === 'confirm' ? await supportApi.confirm(ref) : await supportApi.reopen(ref));
      toast(kind === 'confirm' ? 'Thanks for confirming. The report is closed.' : 'Report reopened. Atlas Support will take another look.', 'success');
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setConfirm(null);
    }
  };

  if (error) {
    return (
      <Page title="Report" back="/support">
        <EmptyState icon={<LifeBuoy className="size-6" />} title={error.status === 404 ? 'Report not found' : 'Report could not be loaded'} action={error.status === 404 ? undefined : <Button onClick={() => void load()}>Try again</Button>}>
          {error.status === 404 ? 'This report doesn’t exist or belongs to another account.' : error.text}
        </EmptyState>
      </Page>
    );
  }
  if (!data) {
    return (
      <Page title="Report" back="/support">
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
          <Spinner className="size-4" /> Loading report
        </div>
      </Page>
    );
  }

  const r = data.report;
  const closed = r.status === 'closed';
  return (
    <Page title={r.ref} back="/support">
      <div className="mx-auto max-w-2xl">
        <div className="mb-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-muted">{r.ref}</span>
            <StatusBadge status={r.status} />
          </div>
          <h1 className="mt-1.5 text-xl font-semibold tracking-tight break-words">{r.title}</h1>
          <p className="mt-1 text-xs text-muted">
            {categoryLabel(r.category)} · Sent {fmtDate(r.createdAt)} · Updated {fmtDate(r.updatedAt)}
          </p>
        </div>

        {r.status === 'resolved' && (
          <div className="mb-5 rounded-2xl border border-accent/30 bg-accent-soft px-4 py-3.5">
            <p className="text-sm font-medium">Atlas Support marked this report as resolved.</p>
            <p className="mt-0.5 text-sm text-muted">Is the problem fixed for you?</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" icon={<CheckCircle2 className="size-4" />} onClick={() => setConfirm('confirm')}>
                Yes, it’s resolved
              </Button>
              <Button size="sm" variant="outline" icon={<RotateCcw className="size-4" />} onClick={() => setConfirm('reopen')}>
                No, reopen
              </Button>
            </div>
          </div>
        )}
        {r.status === 'awaiting_user' && (
          <div className="mb-5 rounded-2xl bg-warn-soft px-4 py-3 text-sm">Atlas Support needs more information from you. Reply below.</div>
        )}

        <section className="mb-6 rounded-2xl border border-border bg-elevated px-4 py-3.5">
          <h2 className="mb-1 text-[13px] font-medium text-muted">Your report</h2>
          <p className="text-sm break-words whitespace-pre-wrap">{r.description}</p>
          {r.attachments.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {r.attachments.map((a) => (
                <AttachmentChip key={a.id} reportRef={r.ref} a={a} />
              ))}
            </div>
          )}
        </section>

        <h2 className="mb-3 text-[13px] font-medium text-muted">Conversation</h2>
        <ThreadView reportRef={r.ref} messages={data.messages} viewer="user" />

        <div className="mt-6">
          {closed ? (
            <div className="flex flex-col items-center gap-3 rounded-2xl bg-surface-2 px-4 py-4 text-center text-sm text-muted">
              This report is closed{r.userConfirmedAt ? ' — you confirmed it was resolved' : ''}.
              <Button size="sm" variant="outline" icon={<RotateCcw className="size-4" />} onClick={() => setConfirm('reopen')}>
                Reopen report
              </Button>
            </div>
          ) : (
            <form onSubmit={(e) => void send(e)} className="rounded-2xl border border-border bg-bg p-3 transition-colors focus-within:border-accent">
              <label htmlFor="reply" className="sr-only">
                Add more information
              </label>
              <textarea
                id="reply"
                rows={3}
                value={text}
                maxLength={SUPPORT_LIMITS.message}
                onChange={(e) => setText(e.target.value)}
                placeholder="Add more information for Atlas Support"
                className="block w-full resize-none bg-transparent text-sm placeholder:text-subtle focus:outline-none"
              />
              <div className="mt-2 flex items-end justify-between gap-3">
                <ScreenshotPicker value={files} onChange={setFiles} disabled={busy} compact />
                <div className="flex items-center gap-3">
                  <Counter n={text.length} max={SUPPORT_LIMITS.message} />
                  <Button type="submit" size="sm" icon={<Send className="size-4" />} loading={busy} disabled={busy || (!text.trim() && !files.length)}>
                    Send
                  </Button>
                </div>
              </div>
            </form>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        onConfirm={act}
        title={confirm === 'confirm' ? 'Confirm the issue is resolved?' : 'Reopen this report?'}
        message={confirm === 'confirm' ? 'The report will be closed. You can reopen it later if the problem comes back.' : 'Atlas Support will be notified and will look at it again.'}
        confirmLabel={confirm === 'confirm' ? 'Confirm' : 'Reopen'}
      />
    </Page>
  );
}
