import { limit, orderBy, query } from 'firebase/firestore';
import { AlertCircle, FileText, Loader2, MessageSquarePlus, MoreHorizontal, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, ConfirmDialog, EmptyState, IconButton, Menu, PageHeader, Spinner } from '@/components/ui';
import { deleteDocument, paths } from '@/lib/db';
import { DOC_ACCEPT } from '@/lib/extract';
import { useQuery } from '@/lib/hooks';
import type { DocumentMeta } from '@/lib/types';
import { cn, formatBytes, relativeTime } from '@/lib/utils';
import { useUid } from '@/state/auth';
import { useToast } from '@/state/toast';
import { Page } from '../shell/Page';
import { uploadDocument } from './upload';

export default function DocumentsPage() {
  const uid = useUid();
  const toast = useToast();
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const { data, loading } = useQuery<DocumentMeta & { warning?: string }>(
    query(paths.documents(uid), orderBy('createdAt', 'desc'), limit(200)),
    [uid],
  );
  const [toDelete, setToDelete] = useState<DocumentMeta | null>(null);
  const [dragging, setDragging] = useState(false);

  const upload = async (files: File[]) => {
    for (const f of files) {
      try {
        await uploadDocument(uid, f);
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Upload failed.', 'error');
      }
    }
  };

  const uploadButton = (
    <Button variant="primary" icon={<Upload className="size-4" />} onClick={() => input.current?.click()}>
      Upload
    </Button>
  );

  return (
    <Page
      title="Documents"
      actions={
        <IconButton label="Upload document" onClick={() => input.current?.click()}>
          <Upload className="size-5" />
        </IconButton>
      }
    >
      <PageHeader
        title="Documents"
        description="Files you upload are read, split into sections and indexed so Atlas AI can answer questions about them with citations."
        actions={<div className="hidden lg:block">{uploadButton}</div>}
      />

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void upload(Array.from(e.dataTransfer.files));
        }}
        className={cn(
          'mb-6 hidden flex-col items-center rounded-xl border border-dashed px-4 py-8 text-center transition-colors sm:flex',
          dragging ? 'border-accent bg-accent-soft' : 'border-border-strong',
        )}
      >
        <Upload className="mb-2 size-5 text-muted" />
        <p className="text-sm">
          Drop files here, or{' '}
          <button onClick={() => input.current?.click()} className="font-medium text-accent hover:underline">
            browse
          </button>
        </p>
        <p className="mt-1 text-xs text-muted">PDF, DOCX, TXT, Markdown, CSV, XLSX, PPTX · up to 25 MB</p>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : !data.length ? (
        <EmptyState icon={<FileText className="size-5" />} title="No documents yet" action={<div className="sm:hidden">{uploadButton}</div>}>
          Upload a file, then ask questions about it in any chat.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {data.map((d) => (
            <li key={d.id} className="flex items-center gap-3 px-4 py-3">
              <div
                className={cn(
                  'flex size-9 shrink-0 items-center justify-center rounded-lg',
                  d.status === 'failed' ? 'bg-danger-soft text-danger' : 'bg-accent-soft text-accent',
                )}
              >
                {d.status === 'processing' ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : d.status === 'failed' ? (
                  <AlertCircle className="size-4" />
                ) : (
                  <FileText className="size-4" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{d.name}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
                  {d.status === 'processing' && <span>Reading and indexing…</span>}
                  {d.status === 'failed' && <span className="text-danger">{d.error ?? 'Processing failed'}</span>}
                  {d.status === 'ready' && (
                    <>
                      <span>{formatBytes(d.size)}</span>
                      {d.pageCount ? <span>· {d.pageCount} pages</span> : null}
                      <span>· {d.chunkCount ?? 0} sections</span>
                    </>
                  )}
                  <span>· {relativeTime(d.createdAt)}</span>
                </div>
                {d.warning && <div className="mt-1 text-xs text-warn">{d.warning}</div>}
              </div>
              {d.status === 'ready' && <Badge tone="accent" className="hidden sm:inline-flex">Indexed</Badge>}
              <Menu
                trigger={(p) => (
                  <IconButton {...p} label="Document options" size="sm">
                    <MoreHorizontal className="size-4" />
                  </IconButton>
                )}
                items={[
                  {
                    label: 'Ask about this document',
                    icon: <MessageSquarePlus className="size-4" />,
                    disabled: d.status !== 'ready',
                    onSelect: () => navigate(`/?doc=${d.id}`),
                  },
                  'separator',
                  { label: 'Delete', icon: <Trash2 className="size-4" />, danger: true, onSelect: () => setToDelete(d) },
                ]}
              />
            </li>
          ))}
        </ul>
      )}

      <p className="mt-6 text-xs text-subtle">
        Text is extracted on your device and stored with your account. Original files are not kept. Scanned PDFs without a text layer need OCR, which is not configured.
      </p>

      <input
        ref={input}
        type="file"
        accept={DOC_ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          void upload(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
      <ConfirmDialog
        open={Boolean(toDelete)}
        onClose={() => setToDelete(null)}
        title="Delete document?"
        message={`“${toDelete?.name}” and its index will be removed. Chats that used it keep their answers.`}
        onConfirm={async () => {
          if (toDelete) await deleteDocument(uid, toDelete.id);
        }}
      />
    </Page>
  );
}
