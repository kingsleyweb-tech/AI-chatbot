import { Download, ImageOff, RefreshCw, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { GeneratedImageInfo } from '@shared/types';
import { Button, IconButton } from '@/components/ui';
import { cn } from '@/lib/utils';
import { useUid } from '@/state/auth';
import { useToast } from '@/state/toast';
import { cachedImage, downloadImage, ImageGoneError, loadImageBlob } from './images';

type State =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; url: string; blob: Blob }
  | { status: 'gone' | 'error'; message: string };

/** Loads the original image (memory first, then Firestore) once the element is near the screen. */
export function useImageBlob(info: Pick<GeneratedImageInfo, 'id' | 'stored'>, lazy = false) {
  const uid = useUid();
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(!lazy);
  const [state, setState] = useState<State>({ status: 'idle' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (visible || !ref.current) return;
    const el = ref.current;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setVisible(true), { rootMargin: '300px' });
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible || !uid) return;
    let cancelled = false;
    let url: string | null = null;
    setState({ status: 'loading' });
    const local = cachedImage(info.id);
    const p = local
      ? Promise.resolve(local)
      : info.stored
        ? loadImageBlob(uid, info.id)
        : Promise.reject(new ImageGoneError('This image could not be saved to your account, and it is no longer available on this device.'));
    p.then(
      (blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setState({ status: 'ready', url, blob });
      },
      (err) => {
        if (cancelled) return;
        setState(
          err instanceof ImageGoneError
            ? { status: 'gone', message: err.message }
            : { status: 'error', message: 'The image could not be loaded. Check your connection and retry.' },
        );
      },
    );
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [uid, info.id, info.stored, visible, attempt]);

  return { ref, state, retry: () => setAttempt((a) => a + 1) };
}

export function DownloadImageButton({ info, blob, size = 'sm', className }: { info: GeneratedImageInfo; blob: Blob | null; size?: 'sm' | 'md'; className?: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size={size}
      variant="outline"
      className={className}
      disabled={!blob}
      loading={busy}
      icon={<Download className="size-3.5" />}
      onClick={async () => {
        if (!blob) return;
        setBusy(true);
        try {
          const r = await downloadImage(blob, info);
          if (r === 'downloaded') toast('Image downloaded.', 'success');
        } catch {
          toast('The download did not start. Please try again.', 'error');
        } finally {
          setBusy(false);
        }
      }}
    >
      Download
    </Button>
  );
}

function Lightbox({ url, alt, onClose }: { url: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div role="dialog" aria-modal="true" aria-label="Image" className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4" onClick={onClose}>
      <img src={url} alt={alt} className="max-h-full max-w-full rounded-lg object-contain" onClick={(e) => e.stopPropagation()} />
      <IconButton label="Close" className="absolute right-3 top-3 bg-black/40 text-white hover:bg-black/60 hover:text-white" onClick={onClose}>
        <X className="size-5" />
      </IconButton>
    </div>
  );
}

/** A created picture inside a chat reply: correct shape while loading, Download under it. */
export function GeneratedImage({ info }: { info: GeneratedImageInfo }) {
  const { ref, state, retry } = useImageBlob(info);
  const [open, setOpen] = useState(false);
  const ratio = info.width && info.height ? `${info.width} / ${info.height}` : '1 / 1';
  return (
    <figure className="my-2 w-full max-w-md" data-generated-image={info.id}>
      <div
        ref={ref}
        className={cn('relative w-full overflow-hidden rounded-xl border border-border bg-surface-2', state.status === 'loading' || state.status === 'idle' ? 'animate-pulse' : '')}
        style={{ aspectRatio: ratio }}
      >
        {state.status === 'ready' && (
          <button type="button" className="block size-full cursor-zoom-in" onClick={() => setOpen(true)} aria-label="View full size">
            <img src={state.url} alt={info.prompt} width={info.width} height={info.height} className="size-full object-contain" />
          </button>
        )}
        {(state.status === 'gone' || state.status === 'error') && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-[13px] text-muted">
            <ImageOff className="size-6 text-subtle" />
            <p>{state.message}</p>
            {state.status === 'error' && (
              <Button size="sm" variant="outline" icon={<RefreshCw className="size-3.5" />} onClick={retry}>
                Retry
              </Button>
            )}
          </div>
        )}
      </div>
      {state.status !== 'gone' && (
        <figcaption className="mt-2 flex items-center gap-2">
          <DownloadImageButton info={info} blob={state.status === 'ready' ? state.blob : null} />
          <span className="truncate text-[11px] text-subtle">
            {info.width}×{info.height} · {info.mime === 'image/png' ? 'PNG' : info.mime === 'image/webp' ? 'WebP' : 'JPEG'}
          </span>
        </figcaption>
      )}
      {open && state.status === 'ready' && <Lightbox url={state.url} alt={info.prompt} onClose={() => setOpen(false)} />}
    </figure>
  );
}
