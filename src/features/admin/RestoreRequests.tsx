import { LifeBuoy } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, ConfirmDialog } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/state/toast';

/** Mirrors the restoreRequests response of api/admin.ts. */
interface RestoreRequestRow {
  uid: string;
  email: string;
  reason: string | null;
  requestedAt: number;
  purgeAfter: number | null;
  deletedBy: 'admin' | 'user' | null;
}

const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const daysLeft = (ms: number | null) => (ms ? Math.max(0, Math.ceil((ms - Date.now()) / 86_400_000)) : null);

/**
 * Admin › Users: confirmed requests to get a deleted account back (sent from the
 * sign-in screen, address confirmed by email). Restore brings the account back
 * and emails the person; Decline emails them that it stays deleted.
 * Hidden when nothing is waiting.
 */
export function RestoreRequests({ onChanged, onOpen }: { onChanged: () => void; onOpen: (uid: string) => void }) {
  const toast = useToast();
  const [rows, setRows] = useState<RestoreRequestRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ row: RestoreRequestRow; kind: 'restore' | 'decline' } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ requests: RestoreRequestRow[] }>('admin', { json: { action: 'restoreRequests' } });
      setRows(r.requests);
    } catch {
      setRows([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const decide = async () => {
    if (!confirm) return;
    const { row, kind } = confirm;
    setBusy(row.uid);
    try {
      await api('admin', { json: kind === 'restore' ? { action: 'restore', uid: row.uid } : { action: 'restoreDecline', uid: row.uid } });
      toast(kind === 'restore' ? `${row.email} was restored and told by email.` : `Request declined. ${row.email} was told by email.`, 'success');
      await load();
      onChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'That did not work. Try again.', 'error');
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  };

  if (!rows.length) return null;
  return (
    <section className="mb-6 rounded-2xl border border-accent/40 bg-accent/5 p-4">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <LifeBuoy className="size-4 text-accent" /> Restore requests
        <Badge tone="accent">{rows.length}</Badge>
      </h2>
      <ul className="divide-y divide-border">
        {rows.map((r) => {
          const left = daysLeft(r.purgeAfter);
          return (
            <li key={r.uid} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 text-sm">
                <button type="button" className="break-all font-medium hover:underline" onClick={() => onOpen(r.uid)}>
                  {r.email}
                </button>
                <p className="mt-0.5 text-xs text-muted">
                  Asked {day(r.requestedAt)} · {r.deletedBy === 'user' ? 'deleted by themselves' : 'deleted by an administrator'}
                  {left !== null && ` · ${left} ${left === 1 ? 'day' : 'days'} before permanent deletion`}
                </p>
                <p className="mt-1.5 whitespace-pre-wrap text-[13px] text-fg/90">{r.reason ? `“${r.reason}”` : <span className="text-muted">No reason given.</span>}</p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button size="sm" variant="outline" disabled={busy === r.uid} onClick={() => setConfirm({ row: r, kind: 'decline' })}>
                  Decline
                </Button>
                <Button size="sm" variant="primary" loading={busy === r.uid} onClick={() => setConfirm({ row: r, kind: 'restore' })}>
                  Restore
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        onConfirm={() => void decide()}
        title={confirm?.kind === 'restore' ? 'Restore this account?' : 'Decline this request?'}
        message={
          confirm?.kind === 'restore'
            ? `${confirm.row.email} can sign in again straight away, with all their data. They will get an email.`
            : `${confirm?.row.email ?? ''} stays scheduled for deletion. They will get an email saying the request was declined.`
        }
        confirmLabel={confirm?.kind === 'restore' ? 'Restore' : 'Decline'}
        danger={confirm?.kind === 'decline'}
      />
    </section>
  );
}
