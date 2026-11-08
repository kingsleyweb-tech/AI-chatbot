import { Bell, CheckCheck, CircleAlert, LifeBuoy, MessageSquare, ShieldAlert } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button, EmptyState } from '@/components/ui';
import { cn, relativeTime } from '@/lib/utils';
import { Page } from '../shell/Page';
import { useNotifications, type NotificationItem } from './useNotifications';

function Icon({ n }: { n: NotificationItem }) {
  const cls = 'size-[18px]';
  if (n.kind === 'high_priority') return <ShieldAlert className={cn(cls, 'text-danger')} />;
  if (n.kind === 'info_request') return <CircleAlert className={cn(cls, 'text-warn')} />;
  if (n.kind === 'reply' || n.kind === 'user_message') return <MessageSquare className={cls} />;
  return <LifeBuoy className={cls} />;
}

export default function NotificationsPage() {
  const { items, unread, markRead } = useNotifications();
  const navigate = useNavigate();
  const markAll = unread ? (
    <Button size="sm" variant="ghost" icon={<CheckCheck className="size-4" />} onClick={() => void markRead(items)}>
      Mark all read
    </Button>
  ) : null;

  return (
    <Page title="Notifications" actions={markAll}>
      <div className="mx-auto max-w-2xl">
        <div className="mb-5 hidden items-center justify-between lg:flex">
          <h1 className="text-xl font-semibold tracking-tight">Notifications</h1>
          {markAll}
        </div>
        {!items.length ? (
          <EmptyState icon={<Bell className="size-6" />} title="No notifications">
            Replies and status updates on your reports appear here.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-elevated">
            {items.map((n) => (
              <li key={`${n.scope}:${n.id}`}>
                <button
                  type="button"
                  onClick={() => {
                    void markRead([n]);
                    navigate(n.link);
                  }}
                  className="flex w-full items-start gap-3 px-4 py-3.5 text-left transition-colors hover:bg-surface-2"
                >
                  <span className="mt-0.5 shrink-0 text-muted">
                    <Icon n={n} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className={cn('min-w-0 truncate text-[15px]', !n.read && 'font-semibold')}>{n.title}</span>
                      {n.count > 1 && <span className="shrink-0 text-xs text-muted">×{n.count}</span>}
                      {n.scope === 'admin' && <span className="shrink-0 text-[11px] text-subtle">Admin</span>}
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-sm text-muted">{n.body}</span>
                    <span className="mt-1 block text-xs text-subtle">
                      <span className="font-mono">{n.ref}</span> · {relativeTime(new Date(n.at))}
                    </span>
                  </span>
                  {!n.read && <span className="mt-2 size-2 shrink-0 rounded-full bg-accent" aria-label="Unread" />}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Page>
  );
}
