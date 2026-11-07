import { limit, orderBy, query } from 'firebase/firestore';
import { FolderClosed, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Dialog, EmptyState, IconButton, Input, Label, PageHeader, Spinner, Textarea } from '@/components/ui';
import { paths, saveProject } from '@/lib/db';
import { useQuery } from '@/lib/hooks';
import type { Project } from '@/lib/types';
import { relativeTime } from '@/lib/utils';
import { useUid } from '@/state/auth';
import { useToast } from '@/state/toast';
import { Page } from '../shell/Page';

export function ProjectEditor({
  open,
  project,
  onClose,
  onSaved,
}: {
  open: boolean;
  project: Project | null;
  onClose: () => void;
  onSaved?: (id: string) => void;
}) {
  const uid = useUid();
  const toast = useToast();
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [busy, setBusy] = useState(false);
  const [lastOpen, setLastOpen] = useState(false);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setName(project?.name ?? '');
      setInstructions(project?.instructions ?? '');
    }
  }
  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const id = await saveProject(uid, { id: project?.id, name: name.trim(), instructions });
      onClose();
      onSaved?.(id);
    } catch {
      toast('Could not save the project.', 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={project ? 'Edit project' : 'New project'}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={save}>
            {project ? 'Save' : 'Create project'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <Label htmlFor="p-name">Name</Label>
          <Input id="p-name" autoFocus maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Q3 planning" />
        </div>
        <div>
          <Label htmlFor="p-ins" hint="Applied to every chat in this project, on top of your custom instructions.">
            Project instructions
          </Label>
          <Textarea
            id="p-ins"
            rows={7}
            maxLength={8000}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="Background, goals, constraints, preferred format…"
          />
        </div>
      </div>
    </Dialog>
  );
}

export default function ProjectsPage() {
  const uid = useUid();
  const navigate = useNavigate();
  const { data, loading } = useQuery<Project>(query(paths.projects(uid), orderBy('updatedAt', 'desc'), limit(200)), [uid]);
  const [open, setOpen] = useState(false);

  return (
    <Page
      title="Projects"
      actions={
        <IconButton label="New project" onClick={() => setOpen(true)}>
          <Plus className="size-5" />
        </IconButton>
      }
    >
      <PageHeader
        title="Projects"
        description="Group related chats and give them shared instructions."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)} className="hidden lg:inline-flex">
            New project
          </Button>
        }
      />
      {loading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : !data.length ? (
        <EmptyState
          icon={<FolderClosed className="size-5" />}
          title="No projects yet"
          action={
            <Button variant="primary" onClick={() => setOpen(true)}>
              Create a project
            </Button>
          }
        >
          A project keeps chats about one topic together, with instructions every chat in it follows.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {data.map((p) => (
            <li key={p.id}>
              <Link to={`/projects/${p.id}`} className="flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-surface">
                <FolderClosed className="size-4 shrink-0 text-accent" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{p.name}</div>
                  {p.instructions && <div className="mt-0.5 truncate text-xs text-muted">{p.instructions}</div>}
                </div>
                <span className="shrink-0 text-xs text-subtle">{relativeTime(p.updatedAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <ProjectEditor open={open} project={null} onClose={() => setOpen(false)} onSaved={(id) => navigate(`/projects/${id}`)} />
    </Page>
  );
}
