import { limit, query, where } from 'firebase/firestore';
import { MessageSquare, MoreHorizontal, Pencil, SquarePen, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button, ConfirmDialog, EmptyState, IconButton, Menu, Spinner } from '@/components/ui';
import { deleteProject, paths } from '@/lib/db';
import { useDocument, useQuery } from '@/lib/hooks';
import type { Conversation, Project } from '@/lib/types';
import { byUpdatedDesc, relativeTime } from '@/lib/utils';
import { useUid } from '@/state/auth';
import { useToast } from '@/state/toast';
import { Page } from '../shell/Page';
import { ProjectEditor } from './ProjectsPage';

export default function ProjectPage() {
  const { projectId = '' } = useParams();
  const uid = useUid();
  const toast = useToast();
  const navigate = useNavigate();
  const { data: project, loading, exists } = useDocument<Project>(paths.project(uid, projectId), [uid, projectId]);
  const chats = useQuery<Conversation>(
    query(paths.conversations(uid), where('projectId', '==', projectId), limit(300)),
    [uid, projectId],
  );
  const [editOpen, setEditOpen] = useState(false);
  const [delOpen, setDelOpen] = useState(false);

  if (loading) {
    return (
      <Page title="Project" back="/projects">
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      </Page>
    );
  }
  if (!exists || !project) {
    return (
      <Page title="Project" back="/projects">
        <EmptyState title="Project not found">It may have been deleted.</EmptyState>
      </Page>
    );
  }

  const menu = (
    <Menu
      trigger={(p) => (
        <IconButton {...p} label="Project options">
          <MoreHorizontal className="size-5" />
        </IconButton>
      )}
      items={[
        { label: 'Edit project', icon: <Pencil className="size-4" />, onSelect: () => setEditOpen(true) },
        { label: 'Delete project', icon: <Trash2 className="size-4" />, danger: true, onSelect: () => setDelOpen(true) },
      ]}
    />
  );

  return (
    <Page title={project.name} back="/projects" actions={menu}>
      <div className="mb-6 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">{project.name}</h1>
          <p className="mt-1 text-sm text-muted">
            {chats.data.length} {chats.data.length === 1 ? 'chat' : 'chats'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="primary" icon={<SquarePen className="size-4" />} onClick={() => navigate(`/?project=${project.id}`)}>
            New chat
          </Button>
          <div className="hidden lg:block">{menu}</div>
        </div>
      </div>

      <section className="mb-8 rounded-xl border border-border px-4 py-3.5">
        <div className="mb-1.5 flex items-center justify-between">
          <h2 className="text-[13px] font-medium">Instructions</h2>
          <button onClick={() => setEditOpen(true)} className="text-xs text-accent hover:underline">
            Edit
          </button>
        </div>
        {project.instructions ? (
          <p className="whitespace-pre-wrap text-sm text-muted">{project.instructions}</p>
        ) : (
          <p className="text-sm text-subtle">No instructions. Add background or rules that every chat in this project should follow.</p>
        )}
      </section>

      <h2 className="mb-2 text-[13px] font-medium text-muted">Chats</h2>
      {chats.loading ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : chats.error ? (
        <p className="py-6 text-sm text-danger">{chats.error}</p>
      ) : !chats.data.length ? (
        <EmptyState icon={<MessageSquare className="size-5" />} title="No chats in this project">
          Start a new chat here, or move an existing chat in from its menu.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {[...chats.data].sort(byUpdatedDesc).map((c) => (
            <li key={c.id}>
              <Link to={`/c/${c.id}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{c.title}</div>
                  {c.summary && <div className="mt-0.5 truncate text-xs text-muted">{c.summary}</div>}
                </div>
                <span className="shrink-0 text-xs text-subtle">{relativeTime(c.updatedAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <ProjectEditor open={editOpen} project={project} onClose={() => setEditOpen(false)} />
      <ConfirmDialog
        open={delOpen}
        onClose={() => setDelOpen(false)}
        title="Delete project?"
        message="The project and its instructions are removed. Its chats are kept and moved out of the project."
        onConfirm={async () => {
          try {
            await deleteProject(uid, project.id);
            navigate('/projects');
          } catch {
            toast('Could not delete the project.', 'error');
          }
        }}
      />
    </Page>
  );
}
