import { ArrowUp, AudioLines, FileAudio, FileText, Globe, ImagePlus, Library, Loader2, Mic, Paperclip, RotateCw, Square, Telescope, Info, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import type { ImageAttachment, ModelInfo } from '@shared/types';
import { IconButton, Menu } from '@/components/ui';
import { DOC_ACCEPT } from '@/lib/extract';
import { compressImage, IMAGE_TYPES } from '@/lib/image';
import { useDictation } from '@/lib/speech';
import { AUDIO_ACCEPT, micErrorMessage, Recorder, recordingSupported, speechConfig, transcribeAudio } from '@/lib/voice';
import type { DocumentMeta } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useToast } from '@/state/toast';
import { documentStage, planSend, type AttachmentStage, type PendingUpload } from './attachments';

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
  /** opens Voice Mode (talk with Atlas AI hands-free) */
  onStartVoice?: () => void;
  /** images put back after a message could not be sent */
  initialImages?: ImageAttachment[];
  /** a message is being stored */
  sending?: boolean;
  /** files still uploading, or whose upload failed */
  uploads?: PendingUpload[];
  onRetryUpload?: (uploadId: string) => void;
  onDismissUpload?: (uploadId: string) => void;
  /** upload a document that could not be read again (only when the file is still at hand) */
  onRetryDocument?: (id: string) => void;
  canRetryDocument?: (id: string) => boolean;
  /** documents this conversation already searches (sent earlier), which can be removed */
  chatDocuments?: DocumentMeta[];
  onDetachChatDocument?: (id: string) => void;
}

function DocChip({
  name,
  stage,
  detail,
  onRetry,
  onRemove,
}: {
  name: string;
  stage: AttachmentStage;
  detail: string;
  onRetry?: () => void;
  onRemove?: () => void;
}) {
  const failed = stage === 'failed';
  const busy = stage === 'uploading' || stage === 'processing';
  return (
    <div className="flex h-16 w-56 shrink-0 items-center gap-2.5 rounded-xl border border-border bg-surface px-2.5" title={`${name}: ${detail}`}>
      <div className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg', failed ? 'bg-danger-soft text-danger' : 'bg-accent-soft text-accent')}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : <FileText className="size-4" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium">{name}</div>
        <div className={cn('flex items-center gap-1.5 truncate text-[11px]', failed ? 'text-danger' : 'text-muted')} aria-live="polite">
          <span className="truncate">{detail}</span>
          {onRetry && (
            <button onClick={onRetry} className="inline-flex shrink-0 items-center gap-0.5 font-medium text-accent hover:underline">
              <RotateCw className="size-3" aria-hidden="true" /> Retry
            </button>
          )}
        </div>
      </div>
      {onRemove && (
        <button onClick={onRemove} className="rounded p-0.5 text-subtle hover:text-fg" aria-label={`Remove ${name}`}>
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}

export function Composer(props: ComposerProps) {
  const toast = useToast();
  const [text, setText] = useState(props.initialText ?? '');
  const [images, setImages] = useState<ImageAttachment[]>(props.initialImages ?? []);
  const [processing, setProcessing] = useState(0);
  const [dragging, setDragging] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const imgInput = useRef<HTMLInputElement>(null);
  const docInput = useRef<HTMLInputElement>(null);
  const baseText = useRef('');

  const dictation = useDictation((finalText, interim) => {
    setText((baseText.current ? baseText.current + ' ' : '') + finalText + interim);
  });

  // Whisper voice input (server) when available; the browser's own dictation otherwise
  const [whisper, setWhisper] = useState(false);
  useEffect(() => {
    if (!recordingSupported()) return;
    let alive = true;
    void speechConfig().then((c) => alive && setWhisper(c.configured));
    return () => {
      alive = false;
    };
  }, []);
  const recorder = useRef<Recorder | null>(null);
  const [rec, setRec] = useState<{ state: 'recording' | 'transcribing'; started: number; level: number } | null>(null);
  const [lastAudio, setLastAudio] = useState<Blob | null>(null);
  const audioInput = useRef<HTMLInputElement>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    if (rec?.state !== 'recording') return;
    const t = window.setInterval(() => tick((n) => n + 1), 500);
    return () => window.clearInterval(t);
  }, [rec?.state]);
  useEffect(() => () => recorder.current?.cancel(), []);

  const insertTranscript = useCallback((t: string) => {
    setText((prev) => (prev.trim() ? `${prev.trimEnd()} ${t}` : t));
    window.setTimeout(() => ta.current?.focus(), 0);
  }, []);

  const runTranscription = useCallback(
    async (audio: Blob) => {
      setRec({ state: 'transcribing', started: Date.now(), level: 0 });
      try {
        const r = await transcribeAudio(audio);
        setLastAudio(null);
        if (!r.text.trim()) toast('No speech was recognised. Please try again.', 'info');
        else insertTranscript(r.text.trim());
      } catch (err) {
        setLastAudio(audio);
        toast(err instanceof Error ? err.message : 'Transcription failed.', 'error');
      } finally {
        setRec(null);
      }
    },
    [insertTranscript, toast],
  );

  const startRecording = async () => {
    const r = new Recorder({ onLevel: (level) => setRec((p) => (p && p.state === 'recording' ? { ...p, level } : p)) });
    try {
      await r.start();
    } catch (err) {
      toast(micErrorMessage(err), 'error');
      return;
    }
    recorder.current = r;
    setLastAudio(null);
    setRec({ state: 'recording', started: Date.now(), level: 0 });
    // resolves when the recording stops (the mic button or the 2-minute limit)
    void r.finished.then((blob) => {
      if (recorder.current !== r) return;
      recorder.current = null;
      if (blob) void runTranscription(blob);
      else setRec(null);
    });
  };
  const stopRecording = () => {
    recorder.current?.stop();
  };
  const cancelRecording = () => {
    const r = recorder.current;
    recorder.current = null;
    r?.cancel();
    setRec(null);
  };

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
      const audio = files.filter((f) => f.type.startsWith('audio/') || /\.(mp3|m4a|wav|ogg|oga|opus|flac|aac)$/i.test(f.name));
      const imgs = files.filter((f) => !audio.includes(f) && (IMAGE_TYPES.includes(f.type) || /\.(heic|heif)$/i.test(f.name)));
      const docs = files.filter((f) => !imgs.includes(f) && !audio.includes(f));
      if (audio.length) {
        if (!whisper) toast('Transcribing audio files is not available on this server.', 'info');
        else void runTranscription(audio[0]);
      }
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
    [images.length, props, toast, whisper, runTranscription],
  );

  // While a message is being stored, the documents it carries are shown in that message
  // (as Sending), not here; they come back here only if storing it fails.
  const shownDocs = props.sending ? props.documents.filter((d) => documentStage(d) !== 'ready') : props.documents;
  // a document still uploading or being read would be left out of the message
  const waiting = planSend(props.documents, props.uploads ?? []).waiting;
  const canSend = (text.trim().length > 0 || images.length > 0) && processing === 0 && !waiting && !props.sending && !props.generating && !rec;

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
        <div className="mb-2 flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-[13px]">
          <Info className="size-4 shrink-0 text-accent" />
          <span className="min-w-0 flex-1 text-muted">
            {props.model!.name} can’t view images, so this message will be answered by a free vision model. Your selected model stays the same.
          </span>
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
        {(images.length > 0 || shownDocs.length > 0 || processing > 0 || (props.uploads?.length ?? 0) > 0) && (
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
            {(props.uploads ?? []).map((u) => (
              <DocChip
                key={u.id}
                name={u.name}
                stage={u.status === 'failed' ? 'failed' : 'uploading'}
                detail={u.status === 'failed' ? u.error ?? 'Upload failed' : 'Uploading…'}
                onRetry={u.status === 'failed' && props.onRetryUpload ? () => props.onRetryUpload!(u.id) : undefined}
                onRemove={u.status === 'failed' && props.onDismissUpload ? () => props.onDismissUpload!(u.id) : undefined}
              />
            ))}
            {shownDocs.map((d) => {
              const stage = documentStage(d);
              return (
                <DocChip
                  key={d.id}
                  name={d.name}
                  stage={stage}
                  detail={
                    stage === 'processing'
                        ? 'Processing…'
                        : stage === 'failed'
                          ? d.error ?? 'Could not be read'
                          : `Ready · ${d.chunkCount ?? 0} sections`
                  }
                  onRetry={stage === 'failed' && props.onRetryDocument && props.canRetryDocument?.(d.id) ? () => props.onRetryDocument!(d.id) : undefined}
                  onRemove={props.sending ? undefined : () => props.onRemoveDocument(d.id)}
                />
              );
            })}
          </div>
        )}
        {(rec || lastAudio) && (
          <div className="mx-3 mt-3 flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2 text-[13px]" role="status" aria-live="polite">
            {rec?.state === 'recording' && (
              <>
                <span className="relative flex size-2.5">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-danger opacity-60" />
                  <span className="relative inline-flex size-2.5 rounded-full bg-danger" />
                </span>
                <span className="tabular-nums text-fg">
                  {Math.floor((Date.now() - rec.started) / 60000)}:{String(Math.floor(((Date.now() - rec.started) / 1000) % 60)).padStart(2, '0')}
                </span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-border" aria-hidden>
                  <span className="block h-full rounded-full bg-accent transition-[width] duration-75" style={{ width: `${Math.round(rec.level * 100)}%` }} />
                </span>
                <span className="hidden text-muted sm:inline">Listening… tap the mic to finish</span>
                <button onClick={cancelRecording} className="rounded px-1.5 py-0.5 text-muted hover:text-fg">
                  Cancel
                </button>
              </>
            )}
            {rec?.state === 'transcribing' && (
              <>
                <Loader2 className="size-4 animate-spin text-accent" />
                <span className="text-muted">Turning your speech into text…</span>
              </>
            )}
            {!rec && lastAudio && (
              <>
                <span className="flex-1 text-muted">The recording could not be transcribed.</span>
                <button onClick={() => void runTranscription(lastAudio)} className="rounded px-1.5 py-0.5 font-medium text-accent">
                  Retry
                </button>
                <button onClick={() => setLastAudio(null)} className="rounded px-1.5 py-0.5 text-muted hover:text-fg">
                  Discard
                </button>
              </>
            )}
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
          placeholder={dictation.listening ? 'Listening…' : props.placeholder ?? 'Message Atlas AI'}
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
              ...(whisper ? [{ label: 'Audio to text', icon: <FileAudio className="size-4" />, onSelect: () => audioInput.current?.click(), hint: 'MP3, M4A, WAV…' }] : []),
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
          {(props.chatDocuments?.length ?? 0) > 0 && props.onDetachChatDocument && (
            <Menu
              side="top"
              align="start"
              trigger={(p) => (
                <button
                  {...p}
                  className="inline-flex h-9 items-center gap-1 rounded-full px-2.5 text-[13px] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg"
                  title="Documents this chat searches when you ask questions"
                  aria-label={`${props.chatDocuments!.length} documents in this chat`}
                >
                  <FileText className="size-4" />
                  <span className="tabular-nums">{props.chatDocuments!.length}</span>
                </button>
              )}
              items={props.chatDocuments!.map((d) => ({
                label: d.name,
                icon: <FileText className="size-4" />,
                hint: 'Remove',
                onSelect: () => props.onDetachChatDocument!(d.id),
              }))}
            />
          )}
          <div className="flex-1" />
          {whisper ? (
            <IconButton
              label={rec?.state === 'recording' ? 'Stop recording' : 'Voice input'}
              active={rec?.state === 'recording'}
              disabled={rec?.state === 'transcribing'}
              className="rounded-full"
              onClick={() => (rec?.state === 'recording' ? stopRecording() : void startRecording())}
            >
              {rec?.state === 'transcribing' ? <Loader2 className="size-[18px] animate-spin" /> : <Mic className={cn('size-[18px]', rec?.state === 'recording' && 'animate-pulse')} />}
            </IconButton>
          ) : (
            dictation.supported && (
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
            )
          )}
          {props.onStartVoice && !rec && (
            <IconButton label="Voice Mode: talk with Atlas AI" className="rounded-full" onClick={props.onStartVoice} disabled={props.generating}>
              <AudioLines className="size-[18px]" />
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
              aria-label={props.sending ? 'Sending message' : 'Send message'}
              title={waiting ? 'Waiting for your documents to finish uploading and processing' : props.sending ? 'Sending…' : 'Send'}
            >
              {props.sending ? <Loader2 className="size-[18px] animate-spin" /> : <ArrowUp className="size-[18px]" strokeWidth={2.4} />}
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
        ref={audioInput}
        type="file"
        accept={AUDIO_ACCEPT}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void runTranscription(f);
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
