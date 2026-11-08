import { collection, getCountFromServer, limit, orderBy, query, where } from 'firebase/firestore';
import { Bell, Bookmark, Brain, CircleHelp, FileText, FolderClosed, ImageIcon, LifeBuoy, Library, LogOut, MessageSquareText, MoreHorizontal, PanelLeftClose, Pencil, Search, Settings, SquarePen, Trash2, UserPlus, Users, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { NavLink, useMatch, useNavigate } from 'react-router-dom';
import { Logo } from '@/components/Logo';
import { ConfirmDialog, Dialog, Button, IconButton, Input, Menu } from '@/components/ui';
import { deleteConversation, paths, renameConversation, updateConversation } from '@/lib/db';
import { db } from '@/lib/firebase';
import { useQuery } from '@/lib/hooks';
import type { Conversation } from '@/lib/types';
import { cn, dateGroup } from '@/lib/utils';
import { useAuth, useUid } from '@/state/auth';
import { useToast } from '@/state/toast';
import { useNotifications } from '../notifications/useNotifications';

const PAGE = 40;

function NavItem({ to, icon, label, onClick, count }: { to: string; icon: React.ReactNode; label: string; onClick?: () => void; count?: number }) {
  return (
    <NavLink
      to={to}
      onClick={onClick}
      className={({ isActive }) =>
        cn(
          'flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors',
          isActive ? 'bg-surface-2 font-medium text-fg' : 'text-muted hover:bg-surface-2 hover:text-fg',
        )
      }
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count ? (
        <span className="rounded-full bg-accent px-1.5 text-[11px] leading-[18px] font-semibold text-white tabular-nums" aria-label={`${count} waiting`}>
          {count > 99 ? '99+' : count}
        </span>
      ) : null}
    </NavLink>
  );
}

/**
 * Pending access requests, for the administrator's sidebar badge. One
 * aggregation query (admins may read accessRequests), re-run when the app
 * comes back into view, not on a timer.
 */
/** New (unanswered) support reports, for the administrator's sidebar badge. */
function useNewReports(enabled: boolean): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const run = () =>
      getCountFromServer(query(collection(db, 'supportReports'), where('status', '==', 'new')))
        .then((r) => live && setN(r.data().count))
        .catch(() => undefined);
    void run();
    const onVisible = () => document.visibilityState === 'visible' && void run();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('atlas:notified', run);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('atlas:notified', run);
    };
  }, [enabled]);
  return n;
}

function usePendingRequests(enabled: boolean): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const run = () =>
      getCountFromServer(query(collection(db, 'accessRequests'), where('status', '==', 'pending')))
        .then((r) => live && setN(r.data().count))
        .catch(() => undefined);
    void run();
    const onVisible = () => document.visibilityState === 'visible' && void run();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('atlas:requests-changed', run);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('atlas:requests-changed', run);
    };
  }, [enabled]);
  return n;
}

export function useRenameDialog() {
  const uid = useUid();
  const toast = useToast();
  const [target, setTarget] = useState<Conversation | null>(null);
  const [value, setValue] = useState('');
  const open = (c: Conversation) => {
    setTarget(c);
    setValue(c.title);
  };
  const dialog = (
    <Dialog
      open={Boolean(target)}
      onClose={() => setTarget(null)}
      title="Rename conversation"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => setTarget(null)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!value.trim()}
            onClick={async () => {
              if (!target) return;
              await renameConversation(uid, target.id, value.trim()).catch(() => toast('Could not rename.', 'error'));
              setTarget(null);
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (target && value.trim()) renameConversation(uid, target.id, value.trim()).then(() => setTarget(null));
        }}
      >
        <Input autoFocus value={value} onChange={(e) => setValue(e.target.value)} maxLength={120} />
      </form>
    </Dialog>
  );
  return { open, dialog };
}

export function useDeleteConversation() {
  const uid = useUid();
  const toast = useToast();
  const navigate = useNavigate();
  const match = useMatch('/c/:conversationId');
  const [target, setTarget] = useState<Conversation | null>(null);
  const dialog = (
    <ConfirmDialog
      open={Boolean(target)}
      onClose={() => setTarget(null)}
      title="Delete conversation?"
      message={
        <>
          “{target?.title}” and all of its messages will be permanently deleted. Long-term memories learned from it are kept (manage them in
          Memory).
        </>
      }
      onConfirm={async () => {
        if (!target) return;
        try {
          if (match?.params.conversationId === target.id) navigate('/', { replace: true });
          await deleteConversation(uid, target.id);
          toast('Conversation deleted.', 'success');
        } catch {
          toast('Could not delete the conversation.', 'error');
        }
      }}
    />
  );
  return { open: setTarget, dialog };
}

export function Sidebar({ onSearch, onClose, onCollapse }: { onSearch: () => void; onClose?: () => void; onCollapse?: () => void }) {
  const uid = useUid();
  const { user, profile, admin, signOut } = useAuth();
  const pendingRequests = usePendingRequests(admin);
  const newReports = useNewReports(admin);
  const { unread } = useNotifications();
  const navigate = useNavigate();
  const toast = useToast();
  const [count, setCount] = useState(PAGE);
  const { data: convs, loading } = useQuery<Conversation>(
    query(paths.conversations(uid), orderBy('updatedAt', 'desc'), limit(count)),
    [uid, count],
  );
  const rename = useRenameDialog();
  const del = useDeleteConversation();
  const match = useMatch('/c/:conversationId');
  const activeId = match?.params.conversationId;

  const groups = useMemo(() => {
    const out: { label: string; items: Conversation[] }[] = [];
    for (const c of convs) {
      const label = dateGroup(c.updatedAt);
      const g = out.find((x) => x.label === label);
      if (g) g.items.push(c);
      else out.push({ label, items: [c] });
    }
    return out;
  }, [convs]);

  const name = profile?.displayName || user?.displayName || user?.email?.split('@')[0] || 'You';

  return (
    <div className="flex h-full flex-col pt-safe pl-safe">
      <div className="flex h-14 shrink-0 items-center justify-between px-3">
        <button onClick={() => navigate('/')} className="rounded-lg px-1.5 py-1" aria-label="Home">
          <Logo />
        </button>
        {onClose ? (
          <IconButton label="Close menu" onClick={onClose}>
            <X className="size-[18px]" />
          </IconButton>
        ) : (
          <IconButton label="Collapse sidebar" onClick={onCollapse}>
            <PanelLeftClose className="size-[18px]" />
          </IconButton>
        )}
      </div>

      {/* One scroll area: the links and the chat list move together. */}
      <div className="scroll-thin touch-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="space-y-0.5 px-2">
          <button
            onClick={() => {
              navigate('/');
              onClose?.();
            }}
            className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium text-fg transition-colors hover:bg-surface-2"
          >
            <SquarePen className="size-[17px]" />
            New chat
          </button>
          <button
            onClick={() => {
              onSearch();
              onClose?.();
            }}
            className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-fg"
          >
            <Search className="size-[17px]" />
            <span className="flex-1 text-left">Search chats</span>
            <span className="hidden text-[11px] text-subtle lg:inline">Ctrl K</span>
          </button>
          <NavItem to="/projects" icon={<FolderClosed className="size-[17px]" />} label="Projects" />
          <NavItem to="/saved" icon={<Bookmark className="size-[17px]" />} label="Saved" />
          <NavItem to="/images" icon={<ImageIcon className="size-[17px]" />} label="Images" />
          <NavItem to="/documents" icon={<FileText className="size-[17px]" />} label="Documents" />
          <NavItem to="/knowledge" icon={<Library className="size-[17px]" />} label="Knowledge" />
          <NavItem to="/memory" icon={<Brain className="size-[17px]" />} label="Memory" />
          <NavItem to="/notifications" icon={<Bell className="size-[17px]" />} label="Notifications" count={unread} />
          {admin && <NavItem to="/admin/users" icon={<Users className="size-[17px]" />} label="Users" />}
          {admin && <NavItem to="/admin/requests" icon={<UserPlus className="size-[17px]" />} label="Access requests" count={pendingRequests} />}
          {admin && <NavItem to="/admin/support" icon={<LifeBuoy className="size-[17px]" />} label="Support" count={newReports} />}
          {admin && <NavItem to="/admin/sms" icon={<MessageSquareText className="size-[17px]" />} label="SMS" />}
        </div>

        <div className="mt-3 px-2 pb-3">
          {loading && !convs.length ? (
            <div className="space-y-2 px-2.5 pt-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-4 animate-pulse rounded bg-surface-2" style={{ width: `${55 + ((i * 17) % 40)}%` }} />
              ))}
            </div>
          ) : !convs.length ? (
            <p className="px-2.5 pt-2 text-[13px] text-subtle">No conversations yet.</p>
          ) : (
            groups.map((g) => (
              <div key={g.label} className="mb-3">
                <div className="px-2.5 pb-1 pt-2 text-[11px] font-medium text-subtle">{g.label}</div>
                {g.items.map((c) => (
                  <div
                    key={c.id}
                    className={cn(
                      'group relative flex items-center rounded-lg transition-colors',
                      activeId === c.id ? 'bg-surface-2' : 'hover:bg-surface-2',
                    )}
                  >
                    <NavLink
                      to={`/c/${c.id}`}
                      className={cn(
                        'min-w-0 flex-1 truncate py-2 pl-2.5 pr-8 text-[13.5px]',
                        activeId === c.id ? 'text-fg' : 'text-fg/85',
                      )}
                      title={c.title}
                    >
                      {c.saved && <Bookmark className="mr-1.5 inline size-3 -translate-y-px fill-current text-accent" />}
                      {c.title || 'New chat'}
                    </NavLink>
                    <Menu
                      trigger={(p) => (
                        <button
                          {...p}
                          className={cn(
                            'absolute right-1 rounded-md p-1 text-muted transition-opacity hover:bg-border hover:text-fg',
                            activeId === c.id || p['aria-expanded'] ? 'opacity-100' : 'opacity-100 lg:opacity-0 lg:group-hover:opacity-100',
                          )}
                          aria-label="Conversation options"
                        >
                          <MoreHorizontal className="size-4" />
                        </button>
                      )}
                      items={[
                        { label: 'Rename', icon: <Pencil className="size-4" />, onSelect: () => rename.open(c) },
                        {
                          label: c.saved ? 'Remove from saved' : 'Save conversation',
                          icon: <Bookmark className="size-4" />,
                          onSelect: () =>
                            updateConversation(uid, c.id, { saved: !c.saved }).catch(() => toast('Could not update.', 'error')),
                        },
                        'separator',
                        { label: 'Delete', icon: <Trash2 className="size-4" />, danger: true, onSelect: () => del.open(c) },
                      ]}
                    />
                  </div>
                ))}
              </div>
            ))
          )}
          {convs.length >= count && (
            <button onClick={() => setCount((n) => n + PAGE)} className="w-full rounded-lg py-2 text-[13px] text-muted hover:bg-surface-2">
              Show more
            </button>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1 border-t border-border p-2 pb-safe">
        <div className="min-w-0 flex-1">
        <Menu
          side="top"
          align="start"
          trigger={(p) => (
            <button {...p} className="flex w-full items-center gap-2.5 rounded-lg p-2 text-left transition-colors hover:bg-surface-2">
              {user?.photoURL ? (
                <img src={user.photoURL} alt="" className="size-8 rounded-full" referrerPolicy="no-referrer" />
              ) : (
                <span className="flex size-8 items-center justify-center rounded-full bg-accent text-[13px] font-semibold text-accent-fg">
                  {name.slice(0, 1).toUpperCase()}
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{name}</span>
                <span className="block truncate text-xs text-muted">{user?.email}</span>
              </span>
            </button>
          )}
          items={[
            { label: 'Settings', icon: <Settings className="size-4" />, onSelect: () => navigate('/settings') },
            { label: 'Memory', icon: <Brain className="size-4" />, onSelect: () => navigate('/memory') },
            { label: 'Help Centre', icon: <CircleHelp className="size-4" />, onSelect: () => navigate('/help') },
            { label: 'Report an issue', icon: <LifeBuoy className="size-4" />, onSelect: () => navigate('/support/new') },
            'separator',
            { label: 'Sign out', icon: <LogOut className="size-4" />, onSelect: () => signOut() },
          ]}
        />
        </div>
        <IconButton
          label="Settings"
          onClick={() => {
            navigate('/settings');
            onClose?.();
          }}
        >
          <Settings className="size-[18px]" />
        </IconButton>
      </div>
      {rename.dialog}
      {del.dialog}
    </div>
  );
}
