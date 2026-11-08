import { limit, orderBy, query } from 'firebase/firestore';
import { FolderClosed, MessagesSquare, Search, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, ConfirmDialog, EmptyState, IconButton, Spinner } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { deleteConversation, paths } from '@/lib/db';
import { useQuery } from '@/lib/hooks';
import type { Conversation, ProjectBrief } from '@/lib/types';
import { relativeTime } from '@/lib/utils';
import { useUid } from '@/state/auth';
import { useToast } from '@/state/toast';

function List({ title, items }: { title: string; items?: string[] }) {
  if (!items?.length) return null;
  return (
    <div>
      <div className="text-xs font-medium text-muted">{title}</div>
      <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-sm">
        {items.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Project briefs the assistant keeps per project (description, stack,
 * decisions, open bugs and tasks). They are only used when that project is
 * being discussed.
 */
export function ProjectsTab({ projects, loading }: { projects: ProjectBrief[]; loading: boolean }) {
  const toast = useToast();
  const [toDelete, setToDelete] = useState<ProjectBrief | null>(null);
  const sorted = useMemo(() => [...projects].sort((a, b) => (b.updatedAt?.toMillis?.() ?? 0) - (a.updatedAt?.toMillis?.() ?? 0)), [projects]);

  if (loading)
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  if (!projects.length)
    return (
      <EmptyState icon={<FolderClosed className="size-5" />} title="No project memory yet">
        When you work on a named project across chats (for example “Project Alpha”), Atlas AI keeps a brief of its stack, decisions, bugs and tasks here, separate from other projects.
      </EmptyState>
    );

  return (
    <>
      <ul className="divide-y divide-border rounded-xl border border-border">
        {sorted.map((p) => (
          <li key={p.id} className="px-4 py-3.5">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[15px] font-medium">{p.name}</span>
                  {p.aliases?.length ? <span className="text-xs text-muted">also “{p.aliases.slice(0, 3).join('”, “')}”</span> : null}
                </div>
                {p.description && <p className="mt-0.5 text-sm text-muted">{p.description}</p>}
                {p.technologies?.length ? (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {p.technologies.slice(0, 10).map((t) => (
                      <Badge key={t}>{t}</Badge>
                    ))}
                  </div>
                ) : null}
              </div>
              <IconButton label={`Delete ${p.name} project memory`} size="sm" onClick={() => setToDelete(p)}>
                <Trash2 className="size-4" />
              </IconButton>
            </div>
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-accent">
                Details · {p.conversations?.length ?? 0} conversation{p.conversations?.length === 1 ? '' : 's'} · updated {relativeTime(p.updatedAt)}
              </summary>
              <div className="mt-2 space-y-2">
                {p.architecture && (
                  <div>
                    <div className="text-xs font-medium text-muted">Architecture</div>
                    <p className="text-sm">{p.architecture}</p>
                  </div>
                )}
                {p.progress && (
                  <div>
                    <div className="text-xs font-medium text-muted">Progress</div>
                    <p className="text-sm">{p.progress}</p>
                  </div>
                )}
                <List title="Decisions" items={p.decisions} />
                <List title="Known bugs" items={p.bugs} />
                <List title="Open tasks" items={p.tasks} />
                {p.conversations?.length ? (
                  <div>
                    <div className="text-xs font-medium text-muted">Conversations</div>
                    <ul className="mt-0.5 space-y-0.5 text-sm">
                      {p.conversations.map((c) => (
                        <li key={c.id}>
                          <Link to={`/c/${c.id}`} className="text-accent hover:underline">
                            {c.title || 'Untitled chat'}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            </details>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={Boolean(toDelete)}
        onClose={() => setToDelete(null)}
        title={`Delete memory of ${toDelete?.name ?? 'this project'}?`}
        message="The project brief and every memory tied to this project are deleted. The conversations themselves are kept."
        confirmLabel="Delete"
        danger
        onConfirm={async () => {
          if (!toDelete) return;
          try {
            const r = await api<{ memories: number }>('memory', { json: { action: 'deleteProject', projectKey: toDelete.id } });
            toast(`Project memory deleted${r.memories ? ` with ${r.memories} related memories` : ''}.`, 'success');
          } catch (err) {
            toast(err instanceof ApiError ? err.message : 'Could not delete the project memory.', 'error');
          }
        }}
      />
    </>
  );
}

/**
 * Conversation history: the chats Atlas AI can recall from, with deletion that
 * follows the documented policy (see api/memory.ts).
 */
export function ConversationsTab() {
  const uid = useUid();
  const toast = useToast();
  const { data, loading } = useQuery<Conversation>(query(paths.conversations(uid), orderBy('updatedAt', 'desc'), limit(300)), [uid]);
  const [q, setQ] = useState('');
  const [toDelete, setToDelete] = useState<Conversation | null>(null);
  const [forgetOpen, setForgetOpen] = useState(false);
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? data.filter((c) => `${c.title} ${c.summary ?? ''}`.toLowerCase().includes(t)) : data;
  }, [data, q]);

  return (
    <>
      <div className="mb-4 rounded-xl border border-border px-4 py-3 text-sm text-muted">
        Atlas AI can recall relevant parts of your earlier conversations, for example “what did we decide about Project Alpha?”. Deleting a conversation removes its messages, its
        summary and search index entries, and the memories learned from it; project briefs that used it are rebuilt. Memories you wrote yourself and saved responses are kept.
      </div>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <div className="flex h-10 flex-1 items-center gap-2 rounded-[10px] border border-border px-3 focus-within:border-accent">
          <Search className="size-4 text-subtle" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search conversations"
            aria-label="Search conversations"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-subtle"
          />
        </div>
        <Button variant="outline" onClick={() => setForgetOpen(true)}>
          Stop recalling past chats
        </Button>
      </div>
      {loading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : !data.length ? (
        <EmptyState icon={<MessagesSquare className="size-5" />} title="No conversations yet" />
      ) : !filtered.length ? (
        <p className="py-12 text-center text-sm text-muted">No conversations match.</p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {filtered.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-4 py-3">
              <Link to={`/c/${c.id}`} className="min-w-0 flex-1">
                <div className="truncate text-[15px] hover:text-accent">{c.title || 'Untitled chat'}</div>
                <div className="truncate text-xs text-muted">
                  {c.messageCount ? `${c.messageCount} messages · ` : ''}
                  {relativeTime(c.updatedAt)}
                  {c.summary ? ` · ${c.summary}` : ''}
                </div>
              </Link>
              <IconButton label={`Delete ${c.title || 'conversation'}`} size="sm" onClick={() => setToDelete(c)}>
                <Trash2 className="size-4" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={Boolean(toDelete)}
        onClose={() => setToDelete(null)}
        title="Delete conversation?"
        message={`“${toDelete?.title || 'Untitled chat'}” and everything learned from it will be deleted. Memories you wrote yourself and saved responses are kept. This cannot be undone.`}
        confirmLabel="Delete"
        danger
        onConfirm={async () => {
          if (!toDelete) return;
          try {
            await deleteConversation(uid, toDelete.id);
            toast('Conversation deleted.', 'success');
          } catch (err) {
            toast(err instanceof ApiError ? err.message : 'Could not delete the conversation.', 'error');
          }
        }}
      />
      <ConfirmDialog
        open={forgetOpen}
        onClose={() => setForgetOpen(false)}
        title="Stop recalling past chats?"
        message="The search index of your earlier conversations is erased, so Atlas AI no longer brings up excerpts from them. The conversations stay in your history. New messages are indexed again while memory is on."
        confirmLabel="Erase index"
        onConfirm={async () => {
          try {
            await api('memory', { json: { action: 'clearHistoryIndex' } });
            toast('Conversation index erased.', 'success');
          } catch (err) {
            toast(err instanceof ApiError ? err.message : 'Could not erase the index.', 'error');
          }
        }}
      />
    </>
  );
}
