import { deleteDoc, limit, orderBy, query, where } from 'firebase/firestore';
import { Bookmark, Copy, MessageSquare, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { EmptyState, IconButton, PageHeader, Spinner } from '@/components/ui';
import { Markdown } from '@/components/Markdown';
import { paths, updateConversation } from '@/lib/db';
import { useQuery } from '@/lib/hooks';
import type { Conversation, SavedResponse } from '@/lib/types';
import { cn, copyText, modelShortName, relativeTime } from '@/lib/utils';
import { useUid } from '@/state/auth';
import { useToast } from '@/state/toast';
import { Page } from '../shell/Page';

type Tab = 'responses' | 'chats';

function SavedResponseItem({ s }: { s: SavedResponse }) {
  const uid = useUid();
  const toast = useToast();
  const [expanded, setExpanded] = useState(false);
  const long = s.content.length > 700;
  return (
    <li className="rounded-xl border border-border px-4 py-3.5">
      <div className="mb-2 flex items-center gap-2 text-xs text-muted">
        <Link to={`/c/${s.conversationId}`} className="min-w-0 truncate font-medium text-fg hover:text-accent">
          {s.conversationTitle || 'Conversation'}
        </Link>
        <span className="shrink-0">· {relativeTime(s.createdAt)}</span>
        {s.model && <span className="hidden shrink-0 sm:inline">· {modelShortName(s.model)}</span>}
        <div className="ml-auto flex shrink-0">
          <IconButton
            size="sm"
            label="Copy"
            onClick={async () => toast((await copyText(s.content)) ? 'Copied.' : 'Copy failed.', 'info')}
          >
            <Copy className="size-3.5" />
          </IconButton>
          <IconButton
            size="sm"
            label="Remove from saved"
            onClick={() => deleteDoc(paths.savedItem(uid, s.id)).catch(() => toast('Could not remove.', 'error'))}
          >
            <Trash2 className="size-3.5" />
          </IconButton>
        </div>
      </div>
      <div className={cn('relative overflow-hidden', !expanded && long && 'max-h-64')}>
        <Markdown content={s.content} />
        {!expanded && long && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-bg" />}
      </div>
      {long && (
        <button onClick={() => setExpanded((e) => !e)} className="mt-2 text-xs font-medium text-accent hover:underline">
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </li>
  );
}

export default function SavedPage() {
  const uid = useUid();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('responses');
  const responses = useQuery<SavedResponse>(query(paths.saved(uid), orderBy('createdAt', 'desc'), limit(200)), [uid]);
  const chats = useQuery<Conversation>(
    tab === 'chats' ? query(paths.conversations(uid), where('saved', '==', true), orderBy('updatedAt', 'desc'), limit(200)) : null,
    [uid, tab],
  );

  return (
    <Page title="Saved">
      <PageHeader title="Saved" description="Responses you bookmarked and conversations you saved." />
      <div className="mb-5 inline-flex rounded-lg bg-surface-2 p-0.5">
        {(['responses', 'chats'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              'rounded-md px-3.5 py-1.5 text-[13px] font-medium transition-colors',
              tab === t ? 'bg-elevated text-fg shadow-sm' : 'text-muted hover:text-fg',
            )}
          >
            {t === 'responses' ? 'Responses' : 'Conversations'}
          </button>
        ))}
      </div>

      {tab === 'responses' ? (
        responses.loading ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : !responses.data.length ? (
          <EmptyState icon={<Bookmark className="size-5" />} title="No saved responses">
            Use the bookmark button under any answer to keep it here.
          </EmptyState>
        ) : (
          <ul className="space-y-3">
            {responses.data.map((s) => (
              <SavedResponseItem key={s.id} s={s} />
            ))}
          </ul>
        )
      ) : chats.loading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : chats.error ? (
        <p className="py-6 text-sm text-danger">{chats.error}</p>
      ) : !chats.data.length ? (
        <EmptyState icon={<MessageSquare className="size-5" />} title="No saved conversations">
          Choose “Save conversation” from a chat’s menu to keep it here.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {chats.data.map((c) => (
            <li key={c.id} className="flex items-center gap-2 pr-2">
              <Link to={`/c/${c.id}`} className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 hover:bg-surface">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{c.title}</div>
                  {c.summary && <div className="mt-0.5 truncate text-xs text-muted">{c.summary}</div>}
                </div>
                <span className="shrink-0 text-xs text-subtle">{relativeTime(c.updatedAt)}</span>
              </Link>
              <IconButton
                size="sm"
                label="Remove from saved"
                onClick={() => updateConversation(uid, c.id, { saved: false }).catch(() => toast('Could not update.', 'error'))}
              >
                <Bookmark className="size-4 fill-current text-accent" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
