import { limit, orderBy, query } from 'firebase/firestore';
import { Brain, MoreHorizontal, Pencil, Plus, Power, Search, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { MEMORY_CATEGORIES, type MemoryCategory } from '@shared/types';
import { Badge, Button, ConfirmDialog, Dialog, EmptyState, IconButton, Label, Menu, PageHeader, Select, Spinner, Switch, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { deleteAllMemories, deleteMemory, paths, saveMemory } from '@/lib/db';
import { useQuery } from '@/lib/hooks';
import type { Memory } from '@/lib/types';
import { cn, relativeTime } from '@/lib/utils';
import { useUid } from '@/state/auth';
import { useSettings } from '@/state/settings';
import { useToast } from '@/state/toast';
import { Page } from '../shell/Page';

const label = (c: string) => c.charAt(0).toUpperCase() + c.slice(1);

function MemoryEditor({ open, memory, onClose }: { open: boolean; memory: Memory | null; onClose: () => void }) {
  const uid = useUid();
  const toast = useToast();
  const [text, setText] = useState('');
  const [category, setCategory] = useState<MemoryCategory>('fact');
  const [busy, setBusy] = useState(false);
  const [lastOpen, setLastOpen] = useState(false);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setText(memory?.text ?? '');
      setCategory(memory?.category ?? 'fact');
    }
  }

  const save = async () => {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    try {
      const id = await saveMemory(uid, { id: memory?.id, text: t, category, reason: memory ? memory.reason : 'Added manually.' });
      onClose();
      api('memory', { json: { action: 'reembed', ids: [id] } }).catch(() => undefined);
    } catch {
      toast('Could not save the memory.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={memory ? 'Edit memory' : 'Add memory'}
      description="Write it as a short fact about you, e.g. “Prefers metric units.”"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!text.trim()} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <Label htmlFor="mem-text">Memory</Label>
          <Textarea id="mem-text" autoFocus rows={3} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="mem-cat">Category</Label>
          <Select id="mem-cat" value={category} onChange={setCategory} options={MEMORY_CATEGORIES.map((c) => ({ value: c, label: label(c) }))} />
        </div>
      </div>
    </Dialog>
  );
}

export default function MemoryPage() {
  const uid = useUid();
  const toast = useToast();
  const { settings, update } = useSettings();
  const { data, loading } = useQuery<Memory>(query(paths.memories(uid), orderBy('updatedAt', 'desc'), limit(500)), [uid]);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<'all' | MemoryCategory>('all');
  const [editing, setEditing] = useState<Memory | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [toDelete, setToDelete] = useState<Memory | null>(null);
  const [clearOpen, setClearOpen] = useState(false);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return data.filter((m) => (cat === 'all' || m.category === cat) && (!term || `${m.text} ${m.reason}`.toLowerCase().includes(term)));
  }, [data, q, cat]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    data.forEach((m) => (c[m.category] = (c[m.category] ?? 0) + 1));
    return c;
  }, [data]);

  const openEditor = (m: Memory | null) => {
    setEditing(m);
    setEditorOpen(true);
  };

  return (
    <Page
      title="Memory"
      actions={
        <IconButton label="Add memory" onClick={() => openEditor(null)}>
          <Plus className="size-5" />
        </IconButton>
      }
    >
      <PageHeader
        title="Memory"
        description="Things Atlas AI has learned about you across conversations. They are added to future chats when relevant."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => openEditor(null)} className="hidden lg:inline-flex">
            Add memory
          </Button>
        }
      />

      <div className="mb-6 flex items-center gap-3 rounded-xl border border-border px-4 py-3">
        <Brain className="size-5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">Use memory</div>
          <div className="text-xs text-muted">
            {settings.memoryEnabled
              ? 'Atlas AI saves useful details automatically and recalls them when relevant.'
              : 'Memory is off. Nothing new is saved and saved memories are not used.'}
          </div>
        </div>
        <Switch label="Use memory" checked={settings.memoryEnabled} onChange={(v) => update({ memoryEnabled: v })} />
      </div>

      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <div className="flex h-10 flex-1 items-center gap-2 rounded-[10px] border border-border px-3 focus-within:border-accent">
          <Search className="size-4 text-subtle" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search memories"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-subtle"
          />
        </div>
        <Select
          className="sm:w-44"
          value={cat}
          onChange={setCat}
          options={[
            { value: 'all', label: `All categories (${data.length})` },
            ...MEMORY_CATEGORIES.map((c) => ({ value: c, label: `${label(c)} (${counts[c] ?? 0})` })),
          ]}
        />
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : !data.length ? (
        <EmptyState icon={<Brain className="size-5" />} title="No memories yet">
          As you chat, Atlas AI notes lasting details such as preferences, projects and decisions. You can also add one yourself, or say “remember that…” in a chat.
        </EmptyState>
      ) : !filtered.length ? (
        <p className="py-12 text-center text-sm text-muted">No memories match.</p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {filtered.map((m) => (
            <li key={m.id} className={cn('flex gap-3 px-4 py-3.5', !m.active && 'opacity-55')}>
              <div className="min-w-0 flex-1">
                <p className="text-[14px] leading-relaxed">{m.text}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                  <Badge>{label(m.category)}</Badge>
                  {!m.active && <Badge tone="warn">Disabled</Badge>}
                  <span>{m.origin === 'manual' ? 'Added by you' : 'Learned'}</span>
                  <span>·</span>
                  <span>{relativeTime(m.updatedAt)}</span>
                  {m.sourceConversationId && (
                    <>
                      <span>·</span>
                      <Link to={`/c/${m.sourceConversationId}`} className="truncate text-accent hover:underline">
                        {m.sourceTitle || 'Source chat'}
                      </Link>
                    </>
                  )}
                </div>
                {m.reason && m.origin !== 'manual' && <p className="mt-1 text-xs text-subtle">Why: {m.reason}</p>}
              </div>
              <Menu
                trigger={(p) => (
                  <IconButton {...p} label="Memory options" size="sm">
                    <MoreHorizontal className="size-4" />
                  </IconButton>
                )}
                items={[
                  { label: 'Edit', icon: <Pencil className="size-4" />, onSelect: () => openEditor(m) },
                  {
                    label: m.active ? 'Disable' : 'Enable',
                    icon: <Power className="size-4" />,
                    onSelect: () => saveMemory(uid, { id: m.id, text: m.text, active: !m.active, reason: m.reason, category: m.category }).catch(() => toast('Could not update.', 'error')),
                  },
                  'separator',
                  { label: 'Delete', icon: <Trash2 className="size-4" />, danger: true, onSelect: () => setToDelete(m) },
                ]}
              />
            </li>
          ))}
        </ul>
      )}

      {data.length > 0 && (
        <div className="mt-8 flex justify-end">
          <Button variant="ghost" className="text-danger" icon={<Trash2 className="size-4" />} onClick={() => setClearOpen(true)}>
            Delete all memories
          </Button>
        </div>
      )}

      <MemoryEditor open={editorOpen} memory={editing} onClose={() => setEditorOpen(false)} />
      <ConfirmDialog
        open={Boolean(toDelete)}
        onClose={() => setToDelete(null)}
        title="Delete memory?"
        message={toDelete?.text}
        onConfirm={async () => {
          if (toDelete) await deleteMemory(uid, toDelete.id);
        }}
      />
      <ConfirmDialog
        open={clearOpen}
        onClose={() => setClearOpen(false)}
        title="Delete all memories?"
        message="This permanently removes everything Atlas AI has remembered about you. Conversations are not affected."
        confirmLabel="Delete all"
        onConfirm={async () => {
          await deleteAllMemories(uid);
          toast('All memories deleted.', 'success');
        }}
      />
    </Page>
  );
}
