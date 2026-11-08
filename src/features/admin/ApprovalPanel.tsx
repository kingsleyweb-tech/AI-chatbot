import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, ConfirmDialog, Switch } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/state/toast';

/** Mirrors approvalView() in api/admin.ts. */
export interface ApprovalSetting {
  autoApprove: boolean;
  updatedAt: number | null;
  updatedBy: string | null;
}

/** Mirrors recentProfiles() in api/admin.ts. */
export interface RecentUser {
  uid: string;
  name: string | null;
  email: string | null;
  provider: string | null;
  accessStatus: string;
  autoApproved: boolean;
  accountStatus: string;
  createdAt: number | null;
}

const fmt = (ms: number | null) => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

function AccessBadge({ u }: { u: RecentUser }) {
  if (u.accountStatus === 'suspended') return <Badge tone="warn">Suspended</Badge>;
  if (u.accountStatus === 'deleted') return <Badge tone="danger">Deleted</Badge>;
  if (u.accessStatus === 'approved') return <Badge tone="accent">{u.autoApproved ? 'Approved · auto' : 'Approved'}</Badge>;
  if (u.accessStatus === 'rejected') return <Badge tone="danger">Rejected</Badge>;
  return <Badge tone="warn">Pending</Badge>;
}

/**
 * "Automatically approve new users". The setting lives in config/approval,
 * which only the admin API can write (each change is in the activity log).
 * It applies to accounts created after it is turned on; waiting requests are
 * approved only through the explicit "Approve all pending" action.
 */
export function ApprovalPanel({
  approval,
  pending,
  recent,
  onChanged,
}: {
  approval: ApprovalSetting;
  pending: number;
  recent: RecentUser[];
  onChanged: (a: ApprovalSetting | null) => void;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);

  const toggle = async (enabled: boolean) => {
    setSaving(true);
    try {
      const r = await api<{ approval: ApprovalSetting }>('admin', { json: { action: 'setAutoApprove', enabled } });
      onChanged(r.approval);
      toast(enabled ? 'Automatic approval is on' : 'Automatic approval is off', 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'The setting could not be saved.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const approveAll = async () => {
    try {
      const r = await api<{ approved: number; total: number }>('admin', { json: { action: 'approveAllPending', confirm: true } });
      toast(`${r.approved} of ${r.total} pending requests approved`, 'success');
      onChanged(null);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Pending requests could not be approved.', 'error');
    }
  };

  return (
    <section className="mb-6 overflow-hidden rounded-2xl border border-border">
      <div className="flex items-start gap-4 px-4 py-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[15px] font-medium">Automatically approve new users</h2>
            {approval.autoApprove ? (
              <Badge tone="accent">
                <Sparkles className="mr-1 inline size-3" /> On
              </Badge>
            ) : (
              <Badge>Off</Badge>
            )}
          </div>
          <p className="mt-1 text-sm text-muted">
            When enabled, newly registered users will automatically receive access to Atlas AI without requiring manual administrator approval.
          </p>
          <p className="mt-1 text-xs text-subtle">
            Rejected, suspended and deleted accounts are never approved automatically, and requests already waiting stay as they are.
            {approval.updatedAt ? ` Last changed ${fmt(approval.updatedAt)}${approval.updatedBy ? ` by ${approval.updatedBy}` : ''}.` : ''}
          </p>
        </div>
        <Switch checked={approval.autoApprove} onChange={(v) => void toggle(v)} label="Automatically approve new users" disabled={saving} />
      </div>
      {pending > 0 && (
        <div className="flex flex-col gap-2 border-t border-border bg-surface-2/50 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <span className="text-muted">
            {pending} {pending === 1 ? 'request is' : 'requests are'} waiting for review.
          </span>
          <Button size="sm" variant="secondary" onClick={() => setConfirmAll(true)}>
            Approve all pending
          </Button>
        </div>
      )}
      {recent.length > 0 && (
        <div className="border-t border-border">
          <h3 className="px-4 pt-3 pb-1 text-xs font-medium text-muted">Recently registered</h3>
          <ul className="divide-y divide-border">
            {recent.map((u) => (
              <li key={u.uid} className="flex items-center gap-3 px-4 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{u.name || u.email || u.uid}</span>
                  <span className="block truncate text-xs text-muted">
                    {u.email}
                    {u.createdAt ? ` · ${fmt(u.createdAt)}` : ''}
                  </span>
                </span>
                <AccessBadge u={u} />
              </li>
            ))}
          </ul>
        </div>
      )}
      <ConfirmDialog
        open={confirmAll}
        onClose={() => setConfirmAll(false)}
        onConfirm={approveAll}
        title="Approve all pending requests?"
        message={`All ${pending} waiting ${pending === 1 ? 'request' : 'requests'} will be approved now. Suspended accounts are skipped. This is recorded in the activity log.`}
        confirmLabel="Approve all"
        danger={false}
      />
    </section>
  );
}
