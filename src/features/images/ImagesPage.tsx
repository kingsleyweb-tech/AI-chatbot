import { limit, orderBy, query } from 'firebase/firestore';
import { ImageIcon, ImageOff, MessageSquare, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ConfirmDialog, EmptyState, IconButton, PageHeader, Spinner } from '@/components/ui';
import { useQuery } from '@/lib/hooks';
import { cn, relativeTime } from '@/lib/utils';
import { useUid } from '@/state/auth';
import { useToast } from '@/state/toast';
import { Page } from '../shell/Page';
import { DownloadImageButton, useImageBlob } from './GeneratedImage';
import { deleteImage, imagePaths, type StoredImage } from './images';

const PAGE = 24;

function ImageCard({ img, onDelete }: { img: StoredImage; onDelete: () => void }) {
  // only loads when scrolled near: each image is read once, then kept in memory
  const { ref, state, retry } = useImageBlob({ id: img.id, stored: true }, true);
  const ratio = img.width && img.height ? `${img.width} / ${img.height}` : '1 / 1';
  return (
    <li className="flex flex-col overflow-hidden rounded-xl border border-border bg-bg" data-gallery-image={img.id}>
      <div ref={ref} className={cn('relative w-full bg-surface-2', state.status !== 'ready' && state.status !== 'gone' && state.status !== 'error' && 'animate-pulse')} style={{ aspectRatio: ratio }}>
        {state.status === 'ready' && <img src={state.url} alt={img.prompt} className="size-full object-contain" />}
        {(state.status === 'gone' || state.status === 'error') && (
          <button type="button" onClick={retry} className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 p-3 text-center text-xs text-muted">
            <ImageOff className="size-5 text-subtle" />
            {state.status === 'error' ? 'Could not load. Tap to retry.' : state.message}
          </button>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <p className="line-clamp-3 text-[13px] leading-snug" title={img.prompt}>
          {img.kind === 'edit' && <span className="mr-1 rounded bg-surface-2 px-1 py-px text-[11px] text-muted">Edit</span>}
          {img.prompt}
        </p>
        <div className="mt-auto flex items-center gap-1 text-[11px] text-subtle">
          <span className="truncate">{relativeTime(img.createdAt)}</span>
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            <Link to={`/c/${img.conversationId}`} aria-label="Open conversation" title="Open conversation" className="tap tap-sm inline-flex size-7 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg">
              <MessageSquare className="size-3.5" />
            </Link>
            <IconButton size="sm" label="Delete image" onClick={onDelete}>
              <Trash2 className="size-3.5" />
            </IconButton>
          </div>
        </div>
        <DownloadImageButton info={img} blob={state.status === 'ready' ? state.blob : null} className="w-full" />
      </div>
    </li>
  );
}

export default function ImagesPage() {
  const uid = useUid();
  const toast = useToast();
  const [count, setCount] = useState(PAGE);
  const [pending, setPending] = useState<StoredImage | null>(null);
  const images = useQuery<StoredImage>(query(imagePaths.images(uid), orderBy('createdAt', 'desc'), limit(count)), [uid, count]);

  return (
    <Page title="Images">
      <PageHeader title="Images" description="Pictures Atlas AI created for you. They stay in your account until you delete them." />
      {images.loading && !images.data.length ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : images.error ? (
        <p className="py-6 text-sm text-danger">Your images could not be loaded. Check your connection and try again.</p>
      ) : !images.data.length ? (
        <EmptyState icon={<ImageIcon className="size-5" />} title="No images yet">
          Ask in any chat, for example “Generate an image of a lion in a forest”.
        </EmptyState>
      ) : (
        <>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {images.data.map((img) => (
              <ImageCard key={img.id} img={img} onDelete={() => setPending(img)} />
            ))}
          </ul>
          {images.data.length >= count && (
            <div className="mt-6 flex justify-center">
              <button className="text-sm font-medium text-accent hover:underline" onClick={() => setCount((c) => c + PAGE)}>
                Show more
              </button>
            </div>
          )}
        </>
      )}
      <ConfirmDialog
        open={Boolean(pending)}
        onClose={() => setPending(null)}
        title="Delete image?"
        message="The image is deleted from your account permanently. The chat message that showed it stays, without the picture."
        onConfirm={async () => {
          if (!pending) return;
          try {
            await deleteImage(uid, pending.id);
            toast('Image deleted.', 'success');
          } catch {
            toast('The image could not be deleted. Please try again.', 'error');
          }
          setPending(null);
        }}
      />
    </Page>
  );
}
