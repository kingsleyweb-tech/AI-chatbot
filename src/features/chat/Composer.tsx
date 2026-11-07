import { ArrowUp, FileText, Globe, ImagePlus, Library, Loader2, Mic, Paperclip, Square, Telescope, TriangleAlert, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import type { ImageAttachment, ModelInfo } from '@shared/types';
import { IconButton, Menu } from '@/components/ui';
import { DOC_ACCEPT } from '@/lib/extract';
import { compressImage, IMAGE_TYPES } from '@/lib/image';
import { useDictation } from '@/lib/speech';
import type { DocumentMeta } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useToast } from '@/state/toast';

export interface ComposerProps {
  onSend: (text: string, images: ImageAttachment[]) => void;
  onStop: () => void;
  generating: boolean;
  model?: ModelInfo;
  visionAlternative?: ModelInfo;
  onSwitchModel: (id: string) => void;
  webSearch: boolean;
  onWebSearch: (v: boolean) => void;
  searchAvailable: boolean;
  deepResearch: boolean;
  onDeepResearch: (v: boolean) => void;
  /** tooltip describing search mode and budget */
  searchHint?: string;
  documents: DocumentMeta[];
  onUploadDocuments: (files: File[]) => void;
  onRemoveDocument: (id: string) => void;
  onPickFromLibrary: () => void;
  sendOnEnter: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  initialText?: string;
}

export function Composer(props: ComposerProps) {
  const toast = useToast();
  const [text, setText] = useState(props.initialText ?? '');
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [processing, setProcessing] = useState(0);
  const [dragging, setDragging] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const imgInput = useRef<HTMLInputElement>(null);
  const docInput = useRef<HTMLInputElement>(null);
  const baseText = useRef('');

  const dictation = useDictation((finalText, interim) => {
    setText((baseText.current ? baseText.current + ' ' : '') + finalText + interim);
  });

  useEffect(() => {
    if (dictation.error) toast(dictation.error, 'error');
  }, [dictation.error, toast]);

  // auto-grow
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = Math.min(el.scrollHeight, 240) + 'px';
  }, [text]);

  useEffect(() => {
    if (props.autoFocus && window.matchMedia('(pointer: fine)').matches) ta.current?.focus();
  }, [props.autoFocus]);

  const addFiles = useCallback(
    async (files: File[]) => {
      const imgs = files.filter((f) => IMAGE_TYPES.includes(f.type) || /\.(heic|heif)$/i.test(f.name));
      const docs = files.filter((f) => !imgs.includes(f));
      if (docs.length) props.onUploadDocuments(docs);
      if (!imgs.length) return;
      if (images.length + imgs.length > 6) {
        toast('You can attach up to 6 images per message.', 'error');
        return;
      }
      setProcessing((n) => n + imgs.length);
      for (const f of imgs) {
        try {
          const a = await compressImage(f);
          setImages((prev) => [...prev, a]);
        } catch (err) {
          toast(err instanceof Error ? err.message : 'Could not attach image.', 'error');
        } finally {
          setProcessing((n) => n - 1);
        }
      }
    },
    [images.length, props, toast],
  );

  const canSend = (text.trim().length > 0 || images.length > 0) && processing === 0 && !props.generating;

  const send = () => {
    if (!canSend) return;
    if (dictation.listening) dictation.stop();
    props.onSend(text.trim(), images);
    setText('');
    setImages([]);
    baseText.current = '';
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      const touch = window.matchMedia('(pointer: coarse)').matches;
      if (props.sendOnEnter && !touch) {
        e.preventDefault();
        send();
      }
    }
  };

  const onPaste = (e: ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length) {
      e.preventDefault();
      void addFiles(files);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) void addFiles(files);
  };

  const needsVisionSwitch = images.length > 0 && props.model && !props.model.capabilities.vision;

  return (
    <div className="mx-auto w-full max-w-3xl px-3 sm:px-4">
      {needsVisionSwitch && (
        <div className="mb-2 flex items-center gap-2 rounded-xl border border-border bg-warn-soft px-3 py-2 text-[13px]">
          <TriangleAlert className="size-4 shrink-0 text-warn" />
          <span className="min-w-0 flex-1">{props.model!.name} can’t view images.</span>
          {props.visionAlternative && (
            <button
              className="shrink-0 font-medium text-accent hover:underline"
              onClick={() => props.onSwitchModel(props.visionAlternative!.id)}
            >
              Switch to {props.visionAlternative.name}
            </button>
          )}
        </div>
      )}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          'rounded-[22px] border bg-elevated shadow-[0_2px_12px_-4px_rgb(var(--shadow-color)/0.12)] transition-colors focus-within:border-border-strong',
          dragging ? 'border-accent bg-accent-soft' : 'border-border',
        )}
      >
        {(images.length > 0 || props.documents.length > 0 || processing > 0) && (
          <div className="flex gap-2 overflow-x-auto px-3 pt-3 scroll-thin">
            {images.map((img, i) => (
              <div key={i} className="group relative size-16 shrink-0 overflow-hidden rounded-xl border border-border">
                <img src={img.dataUrl} alt={img.name} className="size-full object-cover" />
                <button
                  onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                  className="absolute right-1 top-1 rounded-full bg-black/60 p-0.5 text-white"
                  aria-label={`Remove ${img.name}`}
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
            {processing > 0 && (
              <div className="flex size-16 shrink-0 items-center justify-center rounded-xl border border-border bg-surface">
                <Loader2 className="size-4 animate-spin text-muted" />
              </div>
            )}
            {props.documents.map((d) => (
              <div
                key={d.id}
                className="flex h-16 w-52 shrink-0 items-center gap-2.5 rounded-xl border border-border bg-surface px-2.5"
                title={d.error ?? d.name}
              >
                <div
                  className={cn(
                    'flex size-9 shrink-0 items-center justify-center rounded-lg',
                    d.status === 'failed' ? 'bg-danger-soft text-danger' : 'bg-accent-soft text-accent',
                  )}
                >
                  {d.status === 'processing' ? <Loader2 className="size-4 animate-spin" /> : <FileText className="size-4" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{d.name}</div>
                  <div className={cn('truncate text-[11px]', d.status === 'failed' ? 'text-danger' : 'text-muted')}>
                    {d.status === 'processing' ? 'Reading…' : d.status === 'failed' ? d.error ?? 'Failed' : `${d.chunkCount ?? 0} sections indexed`}
                  </div>
                </div>
                <button onClick={() => props.onRemoveDocument(d.id)} className="rounded p-0.5 text-subtle hover:text-fg" aria-label={`Detach ${d.name}`}>
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={ta}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (!dictation.listening) baseText.current = e.target.value;
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          rows={1}
          placeholder={dictation.listening ? 'Listening…' : props.placeholder ?? 'Message Tessera'}
          aria-label="Message"
          enterKeyHint={props.sendOnEnter ? 'send' : 'enter'}
          className="block max-h-60 min-h-[52px] w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[15px] leading-6 outline-none placeholder:text-subtle"
        />
        <div className="flex items-center gap-1 px-2 pb-2">
          <Menu
            side="top"
            align="start"
            trigger={(p) => (
              <IconButton {...p} label="Attach" className="rounded-full">
                <Paperclip className="size-[18px]" />
              </IconButton>
            )}
            items={[
              { label: 'Photo or image', icon: <ImagePlus className="size-4" />, onSelect: () => imgInput.current?.click() },
              { label: 'Upload document', icon: <FileText className="size-4" />, onSelect: () => docInput.current?.click(), hint: 'PDF, DOCX…' },
              { label: 'From document library', icon: <Library className="size-4" />, onSelect: props.onPickFromLibrary },
            ]}
          />
          <button
            onClick={() => {
              if (!props.searchAvailable) {
                toast('Web search is not configured on the server (SERPAPI_API_KEY or TAVILY_API_KEY).', 'info');
                return;
              }
              props.onWebSearch(!props.webSearch);
            }}
            aria-pressed={props.webSearch}
            className={cn(
              'inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition-colors',
              props.webSearch ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-2 hover:text-fg',
              !props.searchAvailable && 'opacity-50',
            )}
            title={props.searchAvailable ? props.searchHint ?? 'Search the web for this message' : 'Web search is not configured'}
          >
            <Globe className="size-4" />
            <span>Search</span>
          </button>
          <button
            onClick={() => {
              if (!props.searchAvailable) {
                toast('Deep Research needs web search, which is not configured on the server.', 'info');
                return;
              }
              props.onDeepResearch(!props.deepResearch);
            }}
            aria-pressed={props.deepResearch}
            className={cn(
              'inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition-colors',
              props.deepResearch ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-2 hover:text-fg',
              !props.searchAvailable && 'opacity-50',
            )}
            title="Deep Research: several searches and page reads within a fixed budget, then a structured report"
          >
            <Telescope className="size-4" />
            <span className="hidden min-[400px]:inline">Research</span>
          </button>
          <div className="flex-1" />
          {dictation.supported && (
            <IconButton
              label={dictation.listening ? 'Stop dictation' : 'Voice input'}
              active={dictation.listening}
              className="rounded-full"
              onClick={() => {
                if (dictation.listening) dictation.stop();
                else {
                  baseText.current = text;
                  dictation.start();
                }
              }}
            >
              <Mic className={cn('size-[18px]', dictation.listening && 'animate-pulse')} />
            </IconButton>
          )}
          {props.generating ? (
            <button
              onClick={props.onStop}
              className="flex size-9 items-center justify-center rounded-full bg-fg text-bg transition-opacity hover:opacity-85"
              aria-label="Stop generating"
              title="Stop"
            >
              <Square className="size-3.5 fill-current" />
            </button>
          ) : (
            <button
              onClick={send}
              disabled={!canSend}
              className="flex size-9 items-center justify-center rounded-full bg-accent text-accent-fg transition-all hover:bg-accent-hover disabled:bg-surface-2 disabled:text-subtle"
              aria-label="Send message"
              title="Send"
            >
              <ArrowUp className="size-[18px]" strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>
      <input
        ref={imgInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          void addFiles(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
      <input
        ref={docInput}
        type="file"
        accept={DOC_ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          void addFiles(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
    </div>
  );
}
