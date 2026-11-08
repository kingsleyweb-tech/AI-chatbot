import { CheckCircle2, CircleSlash, LifeBuoy, Lock, RotateCcw, Send, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { Button, Dialog, EmptyState, Input, Label, Select, Spinner, Switch } from '@/components/ui';
import { cn } from '@/lib/utils';
import { useAuth } from '@/state/auth';
import { useToast } from '@/state/toast';
import { categoryLabel, priorityLabel, statusLabel, SUPPORT_LIMITS, SUPPORT_PRIORITIES, SUPPORT_STATUSES, type SupportPriority, type SupportStatus } from '@shared/support';
import { useMarkRead } from '../notifications/useNotifications';
import { Page } from '../shell/Page';
import { supportApi, type AdminThread, type NewAttachment } from '../support/api';
import { AttachmentChip, Counter, errorText, fmtDate, PriorityBadge, ScreenshotPicker, StatusBadge, ThreadView } from '../support/parts';

const ACTIVITY: Record<string, string> = {
  created: 'Report submitted',
  status: 'Status changed',
  priority: 'Priority changed',
  assigned: 'Assignment changed',
  note: 'Internal note added',
  reply: 'Replied to the user',
  info_requested: 'Asked the user for more information',
};

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3 py-1.5 text-sm">
      <span className="text-muted">{label}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

export default function SupportReportAdminPage() {
  const { ref = '' } = useParams();
  const { admin, user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState<AdminThread | null>(null);
  const [admins, setAdmins] = useState<string[]>([]);
  const [error, setError] = useState<{ status: number; text: string } | null>(null);
  const [tab, setTab] = useState<'conversation' | 'notes' | 'activity'>('conversation');
  const [reply, setReply] = useState('');
  const [files, setFiles] = useState<NewAttachment[]>([]);
  const [requestInfo, setRequestInfo] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmRef, setConfirmRef] = useState('');
  useMarkRead(ref, 'admin');

  const load = useCallback(async () => {
    try {
      const r = await supportApi.adminGet(ref);
      setData(r);
      setAdmins(r.admins);
      setError(null);
    } catch (err) {
      setError({ status: (err as { status?: number }).status ?? 0, text: errorText(err, 'This report could not be loaded.') });
    }
  }, [ref]);

  useEffect(() => {
    if (!admin) return;
    void load();
    const onNotified = (e: Event) => (e as CustomEvent<string[]>).detail?.includes(ref) && void load();
    window.addEventListener('atlas:notified', onNotified);
    return () => window.removeEventListener('atlas:notified', onNotified);
  }, [admin, load, ref]);

  /** Run an action that returns the updated report. */
  const run = async (key: string, fn: () => Promise<AdminThread>, done?: string) => {
    if (busy) return false;
    setBusy(key);
    try {
      setData(await fn());
      if (done) toast(done, 'success');
      return true;
    } catch (err) {
      toast(errorText(err), 'error');
      return false;
    } finally {
      setBusy(null);
    }
  };

  if (!admin) return <Navigate to="/settings" replace />;
  if (error) {
    return (
      <Page title="Report" back="/admin/support" wide>
        <EmptyState icon={<LifeBuoy className="size-6" />} title={error.status === 404 ? 'Report not found' : 'Report could not be loaded'} action={<Button onClick={() => navigate('/admin/support')}>Back to reports</Button>}>
          {error.status === 404 ? 'It may have been deleted.' : error.text}
        </EmptyState>
      </Page>
    );
  }
  if (!data) {
    return (
      <Page title="Report" back="/admin/support" wide>
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
          <Spinner className="size-4" /> Loading report
        </div>
      </Page>
    );
  }

  const r = data.report;
  const sendReply = async (e: FormEvent) => {
    e.preventDefault();
    if (!reply.trim() && !files.length) return;
    if (await run('reply', () => supportApi.adminReply(ref, reply.trim(), files, requestInfo), requestInfo ? 'Asked the user for more information.' : 'Reply sent.')) {
      setReply('');
      setFiles([]);
      setRequestInfo(false);
    }
  };
  const addNote = async (e: FormEvent) => {
    e.preventDefault();
    if (!note.trim()) return;
    if (await run('note', () => supportApi.adminNote(ref, note.trim()), 'Note added.')) setNote('');
  };
  const setStatus = (s: SupportStatus, msg?: string) => void run('status', () => supportApi.adminStatus(ref, s), msg ?? `Status set to ${statusLabel(s, true)}.`);
  const me = user?.email?.toLowerCase() ?? '';

  return (
    <Page title={r.ref} back="/admin/support" wide>
      <div className="mx-auto w-full max-w-5xl">
        <div className="mb-5">
          <div className="flex flex-wrap items-center gap-2">
            <Link to="/admin/support" className="hidden text-xs text-muted hover:text-fg lg:inline">
              Support
            </Link>
            <span className="hidden text-xs text-subtle lg:inline">/</span>
            <span className="font-mono text-xs text-muted select-all">{r.ref}</span>
            <StatusBadge status={r.status} admin />
            <PriorityBadge priority={r.priority} />
          </div>
          <h1 className="mt-1.5 text-xl font-semibold tracking-tight break-words">{r.title}</h1>
          <p className="mt-1 text-xs text-muted">
            {categoryLabel(r.category)} · Sent {fmtDate(r.createdAt)} · Updated {fmtDate(r.updatedAt)}
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="min-w-0 space-y-6">
            <section className="rounded-2xl border border-border bg-elevated px-4 py-3.5">
              <h2 className="mb-1 text-[13px] font-medium text-muted">Description</h2>
              <p className="text-sm break-words whitespace-pre-wrap">{r.description}</p>
              {r.attachments.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {r.attachments.map((a) => (
                    <AttachmentChip key={a.id} reportRef={r.ref} a={a} />
                  ))}
                </div>
              )}
            </section>

            <div>
              <div role="tablist" className="mb-4 flex gap-1 border-b border-border">
                {(
                  [
                    ['conversation', `Conversation (${data.messages.filter((m) => m.author !== 'system').length})`],
                    ['notes', `Internal notes (${data.notes.length})`],
                    ['activity', 'Activity'],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    role="tab"
                    aria-selected={tab === id}
                    onClick={() => setTab(id)}
                    className={cn('-mb-px border-b-2 px-3 py-2 text-sm transition-colors', tab === id ? 'border-accent font-medium text-fg' : 'border-transparent text-muted hover:text-fg')}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {tab === 'conversation' && (
                <>
                  <ThreadView reportRef={r.ref} messages={data.messages} viewer="admin" />
                  <form onSubmit={(e) => void sendReply(e)} className="mt-5 rounded-2xl border border-border bg-bg p-3 transition-colors focus-within:border-accent">
                    <label htmlFor="admin-reply" className="sr-only">
                      Reply to the user
                    </label>
                    <textarea
                      id="admin-reply"
                      rows={4}
                      value={reply}
                      maxLength={SUPPORT_LIMITS.message}
                      onChange={(e) => setReply(e.target.value)}
                      placeholder={`Reply to ${r.userName} as Atlas Support`}
                      className="block w-full resize-none bg-transparent text-sm placeholder:text-subtle focus:outline-none"
                    />
                    <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
                      <ScreenshotPicker value={files} onChange={setFiles} disabled={busy !== null} compact />
                      <div className="flex flex-wrap items-center gap-3">
                        <label className="flex items-center gap-2 text-xs text-muted">
                          <Switch label="Request more information" checked={requestInfo} onChange={setRequestInfo} />
                          Request more info
                        </label>
                        <Counter n={reply.length} max={SUPPORT_LIMITS.message} />
                        <Button type="submit" size="sm" icon={<Send className="size-4" />} loading={busy === 'reply'} disabled={busy !== null || (!reply.trim() && !files.length)}>
                          Send reply
                        </Button>
                      </div>
                    </div>
                    <p className="mt-2 text-xs text-subtle">The user sees replies from “Atlas Support” and gets a notification.</p>
                  </form>
                </>
              )}

              {tab === 'notes' && (
                <>
                  <p className="mb-3 flex items-center gap-1.5 text-xs text-muted">
                    <Lock className="size-3.5" /> Visible to administrators only. Never shown to the user.
                  </p>
                  {data.notes.length ? (
                    <ul className="space-y-2.5">
                      {data.notes.map((n) => (
                        <li key={n.id} className="rounded-xl bg-warn-soft px-3.5 py-2.5">
                          <div className="mb-0.5 text-xs text-muted">
                            {n.adminEmail ?? 'Administrator'} · {fmtDate(n.at)}
                          </div>
                          <p className="text-sm break-words whitespace-pre-wrap">{n.text}</p>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="py-4 text-sm text-muted">No notes yet.</p>
                  )}
                  <form onSubmit={(e) => void addNote(e)} className="mt-4 space-y-2">
                    <label htmlFor="admin-note" className="sr-only">
                      Internal note
                    </label>
                    <textarea
                      id="admin-note"
                      rows={3}
                      value={note}
                      maxLength={SUPPORT_LIMITS.note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="Add an internal note"
                      className="block w-full resize-none rounded-xl border border-border bg-bg px-3 py-2.5 text-sm placeholder:text-subtle focus:border-accent focus:outline-none"
                    />
                    <div className="flex justify-end">
                      <Button type="submit" size="sm" variant="secondary" loading={busy === 'note'} disabled={busy !== null || !note.trim()}>
                        Add note
                      </Button>
                    </div>
                  </form>
                </>
              )}

              {tab === 'activity' && (
                <ol className="relative space-y-3 border-l border-border pl-4">
                  {data.activity.map((a) => (
                    <li key={a.id} className="text-sm">
                      <span className="absolute -left-[4.5px] mt-1.5 size-2 rounded-full bg-border-strong" />
                      <div>
                        {ACTIVITY[a.type] ?? a.type}
                        {a.detail && <span className="text-muted"> · {a.detail}</span>}
                      </div>
                      <div className="text-xs text-muted">
                        {a.byEmail ?? 'System'} · {fmtDate(a.at)}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>

          <aside className="min-w-0 space-y-5 lg:sticky lg:top-4 lg:self-start">
            <section className="rounded-2xl border border-border bg-elevated px-4 py-3">
              <h2 className="mb-1 text-[13px] font-medium text-muted">User</h2>
              <Field label="Name">{r.userName}</Field>
              <Field label="Email">{r.userEmail}</Field>
              <Field label="User ID">
                <span className="font-mono text-xs select-all">{r.uid}</span>
              </Field>
              <Link to={`/admin/users?uid=${encodeURIComponent(r.uid)}`} className="mt-1 inline-block text-sm text-accent hover:underline">
                View account
              </Link>
            </section>

            <section className="space-y-3 rounded-2xl border border-border bg-elevated px-4 py-3.5">
              <div>
                <Label htmlFor="r-status">Status</Label>
                <Select<SupportStatus> id="r-status" value={r.status} onChange={(s) => setStatus(s)} options={SUPPORT_STATUSES.map((s) => ({ value: s.id as SupportStatus, label: statusLabel(s.id, true) }))} />
              </div>
              <div>
                <Label htmlFor="r-priority">Priority</Label>
                <Select<SupportPriority>
                  id="r-priority"
                  value={r.priority}
                  onChange={(p) => void run('priority', () => supportApi.adminPriority(ref, p), `Priority set to ${priorityLabel(p)}.`)}
                  options={SUPPORT_PRIORITIES.map((p) => ({ value: p, label: priorityLabel(p) }))}
                />
              </div>
              <div>
                <Label htmlFor="r-assignee">Assigned to</Label>
                <Select
                  id="r-assignee"
                  value={r.assignedTo ?? ''}
                  onChange={(v) => void run('assign', () => supportApi.adminAssign(ref, v || null), v ? `Assigned to ${v}.` : 'Unassigned.')}
                  options={[{ value: '', label: 'Unassigned' }, ...[...new Set([...admins, ...(r.assignedTo ? [r.assignedTo] : [])])].map((e) => ({ value: e, label: e === me ? `${e} (you)` : e }))]}
                />
              </div>
              <div className="flex flex-wrap gap-2 border-t border-border pt-3">
                {r.status !== 'resolved' && r.status !== 'closed' && (
                  <Button size="sm" icon={<CheckCircle2 className="size-4" />} onClick={() => setStatus('resolved', 'Marked resolved. The user can confirm or reopen it.')} disabled={busy !== null}>
                    Resolve
                  </Button>
                )}
                {r.status !== 'closed' && (
                  <Button size="sm" variant="outline" icon={<CircleSlash className="size-4" />} onClick={() => setStatus('closed', 'Report closed.')} disabled={busy !== null}>
                    Close
                  </Button>
                )}
                {(r.status === 'resolved' || r.status === 'closed') && (
                  <Button size="sm" variant="outline" icon={<RotateCcw className="size-4" />} onClick={() => setStatus('pending', 'Report reopened.')} disabled={busy !== null}>
                    Reopen
                  </Button>
                )}
              </div>
              {r.userConfirmedAt && <p className="text-xs text-muted">The user confirmed the fix on {fmtDate(r.userConfirmedAt)}.</p>}
            </section>

            <Button variant="ghost" size="sm" className="text-danger" icon={<Trash2 className="size-4" />} onClick={() => setDeleting(true)}>
              Delete report (spam)
            </Button>
          </aside>
        </div>
      </div>

      <Dialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title="Delete this report permanently?"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={busy === 'delete'}
              disabled={confirmRef.trim().toUpperCase() !== r.ref || busy !== null}
              onClick={async () => {
                setBusy('delete');
                try {
                  await supportApi.adminDelete(ref, confirmRef);
                  toast('Report deleted.', 'success');
                  navigate('/admin/support', { replace: true });
                } catch (err) {
                  toast(errorText(err), 'error');
                } finally {
                  setBusy(null);
                }
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        <p className="mb-3 text-sm text-muted">Use this for spam or abuse. The report, its conversation, notes and screenshots are removed and cannot be recovered. The deletion is recorded in the admin activity log.</p>
        <Label htmlFor="confirm-ref" hint={`Type ${r.ref} to confirm`}>
          Reference
        </Label>
        <Input id="confirm-ref" value={confirmRef} onChange={(e) => setConfirmRef(e.target.value)} autoComplete="off" autoCapitalize="characters" />
      </Dialog>
    </Page>
  );
}
