import {
  AlertCircle,
  Bookmark,
  Brain,
  Check,
  ChevronDown,
  CircleDollarSign,
  Copy,
  FileText,
  Library,
  Languages,
  ListCollapse,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Pause,
  Play,
  Square,
  Loader2,
  Pencil,
  RefreshCw,
  Shuffle,
  Sparkles,
  StepForward,
  Trash2,
  Volume2,
} from 'lucide-react';
import { memo, useState } from 'react';
import type { ApprovalRequest, QuickAction, RouteInfo, Source } from '@shared/types';
import { LogoMark } from '@/components/Logo';
import { Markdown } from '@/components/Markdown';
import { Button, IconButton, Menu, Textarea } from '@/components/ui';
import { pauseSpeaking, resumeSpeaking, speak, stopSpeaking, ttsSupported, usePlayback } from '@/lib/speech';
import type { Message } from '@/lib/types';
import { stripSourceList } from '@/lib/sourceList';
import { naturalVoiceFrom } from '@/lib/voice';
import { cn, copyText, domainOf, modelShortName } from '@/lib/utils';
import { useSettings } from '@/state/settings';
import { useToast } from '@/state/toast';
import { GeneratedImage, ImagePlaceholder } from '../images/GeneratedImage';
import type { LiveReply } from './engine';
import { TranslateDialog, TranslationView, type TranslationResult } from './Translate';
import { replyPhase } from './phase';
import { activitySteps } from './activity';
import { ActivityPanel } from './ActivityPanel';
import { SourcesButton, SourcesSheet } from './SourcesSheet';

/** Excerpts from the person's documents and knowledge base (web sources are under the Sources button). */
function Sources({ sources }: { sources: Source[] }) {
  const docs = sources.filter((s) => s.kind === 'document');
  const kb = sources.filter((s) => s.kind === 'knowledge');
  if (!docs.length && !kb.length) return null;
  return (
    <div className="mt-3 space-y-2">
      {kb.length > 0 && (
        <details className="group text-xs">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-muted hover:text-fg">
            <Library className="size-3.5" />
            {kb.length} knowledge base excerpt{kb.length > 1 ? 's' : ''} used
            <ChevronDown className="size-3 transition-transform group-open:rotate-180" />
          </summary>
          <ul className="mt-1.5 space-y-1 pl-1">
            {kb.map((s) => (
              <li key={s.index} className="text-muted">
                <span className="font-medium text-fg">K{s.index}</span> {s.title}
                <span className="text-subtle"> · {s.site}</span>
                {s.indexedAt && <span className="text-subtle"> · indexed {s.indexedAt.slice(0, 10)}</span>}
                {s.url && (
                  <a href={s.url} target="_blank" rel="noopener noreferrer" className="ml-1 text-accent hover:underline">
                    {domainOf(s.url)}
                  </a>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {docs.length > 0 && (
        <details className="group text-xs">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-muted hover:text-fg">
            <FileText className="size-3.5" />
            {docs.length} document excerpt{docs.length > 1 ? 's' : ''} used
            <ChevronDown className="size-3 transition-transform group-open:rotate-180" />
          </summary>
          <ul className="mt-1.5 space-y-1 pl-1">
            {docs.map((s) => (
              <li key={s.index} className="text-muted">
                <span className="font-medium text-fg">D{s.index}</span> {s.title}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** Where the answer's information came from (source transparency). */
function ContextLine({ used }: { used: { memories: number; documents: number; conversations: number; knowledge?: number; web?: number } | null }) {
  if (!used) return null;
  const parts = [
    used.knowledge ? `knowledge base (${used.knowledge})` : '',
    used.documents ? `documents (${used.documents})` : '',
    used.web ? `web (${used.web})` : '',
    used.memories ? `${used.memories} memor${used.memories === 1 ? 'y' : 'ies'}` : '',
    used.conversations ? `${used.conversations} past chat${used.conversations > 1 ? 's' : ''}` : '',
  ].filter(Boolean);
  return (
    <span className="ml-1.5 text-[11px] text-subtle" title="Sources used for this answer">
      · {parts.length ? `used ${parts.join(', ')}` : 'model knowledge only'}
    </span>
  );
}

/**
 * Shown for the whole generation: while the request is processed, while the answer streams in,
 * and while it is being stored. Hidden only once the reply is complete, failed or stopped.
 */
function GenerationIndicator({ live }: { live: LiveReply }) {
  const phase = replyPhase(live);
  if (phase !== 'thinking' && phase !== 'streaming' && phase !== 'saving') return null;
  const image = Boolean(live.imageStage);
  const label =
    phase === 'saving'
      ? image
        ? 'Saving image…'
        : 'Saving response…'
      : phase === 'streaming'
        ? image
          ? 'Saving image…'
          : 'Generating response…'
        : image
          ? live.imageStage === 'saving'
            ? 'Saving image…'
            : 'Creating your image…'
          : live.researchSteps.length && !live.search
          ? 'Researching…'
          : live.sources.length
            ? 'Reading sources…'
            : 'Thinking…';
  return (
    <div role="status" aria-live="polite" data-generation-indicator={phase} className={cn('flex items-center gap-2 py-1.5 text-sm text-muted', live.content && 'mt-1')}>
      <span className="flex gap-1" aria-hidden>
        <span className="size-1.5 animate-bounce rounded-full bg-accent [animation-delay:-0.3s]" />
        <span className="size-1.5 animate-bounce rounded-full bg-accent [animation-delay:-0.15s]" />
        <span className="size-1.5 animate-bounce rounded-full bg-accent" />
      </span>
      {label}
    </div>
  );
}

function Reasoning({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-2">
      {/* shown only when the model actually reasoned (Advanced Reasoning) */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1 text-xs text-subtle transition-colors hover:text-muted"
      >
        <Brain className={cn('size-3', live && 'animate-pulse text-accent')} aria-hidden="true" />
        Reasoning
        <ChevronDown className={cn('size-3 transition-transform', open && 'rotate-180')} aria-hidden="true" />
      </button>
      {open && (
        <div className="scroll-thin mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap border-l-2 border-border pl-3 text-[13px] leading-relaxed text-muted">
          {text}
        </div>
      )}
    </div>
  );
}

export interface MessageActions {
  onRegenerate?: (m: Message) => void;
  onEdit?: (m: Message, text: string) => void;
  onDelete?: (m: Message) => void;
  onToggleSave?: (m: Message, saved: boolean) => void;
  onQuickAction?: (action: QuickAction) => void;
  onRetry?: () => void;
  /** resend this reply once with a paid model the user explicitly approved */
  onApprovePaid?: (m: Message, model: string) => void;
  /** ask for a new picture with the same description */
  onGenerateAnother?: (prompt: string) => void;
}

function RouteNote({ route }: { route: RouteInfo }) {
  return (
    <div className="mb-2 flex items-start gap-1.5 text-xs text-muted">
      <Shuffle className="mt-px size-3.5 shrink-0 text-accent" />
      <span>
        Answered by <span className="text-fg">{route.toName}</span> because {route.fromName} {route.reason}. Your selected model is unchanged.
      </span>
    </div>
  );
}

function ApprovalCard({
  approval,
  canAct,
  onApprove,
}: {
  approval: ApprovalRequest;
  canAct: boolean;
  onApprove: () => void;
}) {
  const cost =
    approval.estCost == null ? 'unknown' : approval.estCost < 0.01 ? 'under $0.01' : `about $${approval.estCost.toFixed(2)}`;
  return (
    <div className="mt-1 rounded-xl border border-border px-3.5 py-3 text-[13px]">
      <div className="flex items-start gap-2.5">
        <CircleDollarSign className="mt-0.5 size-4 shrink-0 text-accent" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-medium text-fg">A paid model is needed for this request</p>
          <p className="text-muted">{approval.reason}</p>
          <p className="text-muted">
            Estimated cost for this one reply: {cost} (estimate from list prices, not a bill). Nothing has been charged.
          </p>
          {approval.creditsNeeded && (
            <p className="text-muted">
              The OpenRouter account has no credits, so this model cannot run until credits are added. Atlas AI never buys credits for you.
            </p>
          )}
        </div>
      </div>
      {canAct && !approval.creditsNeeded && (
        <div className="mt-2.5 flex justify-end">
          <Button size="sm" variant="outline" onClick={onApprove}>
            Use {approval.modelName} once
          </Button>
        </div>
      )}
    </div>
  );
}

export const UserMessage = memo(function UserMessage({
  m,
  actions,
  canEdit,
  delivery = 'sent',
}: {
  m: Message;
  actions: MessageActions;
  canEdit: boolean;
  /** 'sending' until the server has stored the message (and its attachment references) */
  delivery?: 'sending' | 'sent';
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.content);
  const [copied, setCopied] = useState(false);
  const images = m.attachments?.filter((a) => a.kind === 'image') ?? [];
  const docs = m.attachments?.filter((a) => a.kind === 'document') ?? [];

  if (editing) {
    return (
      <div className="ml-auto w-full max-w-[85%] space-y-2">
        <Textarea autoFocus rows={Math.min(10, draft.split('\n').length + 1)} value={draft} onChange={(e) => setDraft(e.target.value)} />
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!draft.trim()}
            onClick={() => {
              setEditing(false);
              actions.onEdit?.(m, draft.trim());
            }}
          >
            Save & resend
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex flex-col items-end">
      {images.length > 0 && (
        <div className="mb-1.5 flex max-w-[85%] flex-wrap justify-end gap-1.5">
          {images.map((img, i) =>
            img.kind === 'image' ? (
              <a key={i} href={img.dataUrl} target="_blank" rel="noopener noreferrer">
                <img src={img.dataUrl} alt={img.name} className="max-h-48 max-w-[220px] rounded-2xl border border-border object-cover" />
              </a>
            ) : null,
          )}
        </div>
      )}
      {docs.length > 0 && (
        <div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
          {docs.map((d, i) => (
            <span key={i} className="flex min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1 text-xs">
              <FileText className="size-3.5 shrink-0 text-accent" />
              <span className="truncate">{d.name}</span>
            </span>
          ))}
        </div>
      )}
      {(images.length > 0 || docs.length > 0) && (
        <div className="mb-1 flex items-center gap-1 text-[11px] text-subtle" aria-live="polite">
          {delivery === 'sending' ? (
            <>
              <Loader2 className="size-3 animate-spin" aria-hidden="true" /> Sending…
            </>
          ) : (
            <>
              <Check className="size-3" aria-hidden="true" /> Sent
            </>
          )}
        </div>
      )}
      {m.content && (
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-[20px] rounded-br-md bg-surface-2 px-4 py-2.5 text-[15px] leading-relaxed">
          {m.content}
        </div>
      )}
      <div className="mt-1 flex items-center gap-0.5 opacity-100 transition-opacity lg:opacity-0 lg:group-hover:opacity-100">
        <IconButton
          label="Copy"
          size="sm"
          onClick={async () => {
            if (await copyText(m.content)) {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }
          }}
        >
          {copied ? <Check className="size-3.5 text-accent" /> : <Copy className="size-3.5" />}
        </IconButton>
        {canEdit && (
          <IconButton
            label="Edit"
            size="sm"
            onClick={() => {
              setDraft(m.content);
              setEditing(true);
            }}
          >
            <Pencil className="size-3.5" />
          </IconButton>
        )}
        <IconButton label="Delete message" size="sm" onClick={() => actions.onDelete?.(m)}>
          <Trash2 className="size-3.5" />
        </IconButton>
      </div>
    </div>
  );
});

export const AssistantMessage = memo(function AssistantMessage({
  m,
  live,
  isLast,
  saved,
  actions,
  busy,
}: {
  m: Message;
  live?: LiveReply;
  isLast: boolean;
  saved: boolean;
  actions: MessageActions;
  busy: boolean;
}) {
  const toast = useToast();
  const { settings } = useSettings();
  const playback = usePlayback();
  const reading = playback.id === m.id;
  const [copied, setCopied] = useState(false);
  const [translateOpen, setTranslateOpen] = useState(false);
  const [translation, setTranslation] = useState<TranslationResult | null>(null);
  const streaming = live ? live.status === 'streaming' || live.status === 'connecting' : false;
  const content = live?.content ?? m.content;
  const reasoning = live?.reasoning ?? m.reasoning ?? '';
  const sources = live?.sources ?? m.sources ?? [];
  const webSources = sources.filter((x) => x.kind === 'web' && x.url);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const search = live ? live.search : m.search;
  const researchSteps = live?.researchSteps ?? m.researchSteps ?? [];
  const model = live?.model ?? m.model;
  const error = live?.error ?? m.error;
  const status = live ? live.status : m.status;
  const route = live ? live.route : m.route;
  const approval = live ? live.approval : m.approval;
  const createdImages = live?.images.length ? live.images : (m.images ?? []);
  // a picture is being made: its placeholder stands where it will appear
  const imagePending = Boolean(live?.imageStage) && streaming && !createdImages.length;

  return (
    <div className="group flex gap-3">
      <div className="hidden shrink-0 pt-0.5 sm:block">
        <div className="flex size-7 items-center justify-center rounded-full border border-border bg-bg">
          <LogoMark className="size-4" />
        </div>
      </div>
      <div className="min-w-0 flex-1">
        {route && <RouteNote route={route} />}
        <ActivityPanel
          live={streaming}
          steps={activitySteps({
            live: Boolean(live),
            status,
            // the switch is explained by its own note above
            route: null,
            search,
            researchSteps,
            context: live ? live.context : m.contextUsed,
            imageStage: live?.imageStage,
            imageCount: createdImages.length,
            hasContent: Boolean(content),
          })}
        />
        {reasoning && <Reasoning text={reasoning} live={streaming && !content} />}
        {content && (
          <div className={cn('text-[15px] leading-[1.65]', streaming && 'caret-host')}>
            <Markdown content={webSources.length ? stripSourceList(content) : content} sources={sources} streaming={streaming} />
          </div>
        )}
        {createdImages.map((img) => (
          <GeneratedImage key={img.id} info={img} onGenerateAnother={isLast && !live ? actions.onGenerateAnother : undefined} busy={busy} />
        ))}
        {imagePending && <ImagePlaceholder stage={live?.imageStage} size={live?.imageSize} />}
        {live && !imagePending && <GenerationIndicator live={live} />}
        {!live && status === 'processing' && <p className="animate-pulse py-1.5 text-sm text-muted">Generating…</p>}
        {status === 'stopped' && <p className="mt-2 text-xs text-subtle">Stopped before it finished</p>}
        {approval && (
          <ApprovalCard
            approval={approval}
            canAct={!live && isLast && !busy && Boolean(actions.onApprovePaid)}
            onApprove={() => actions.onApprovePaid?.(m, approval.model)}
          />
        )}
        {error && !approval && (status === 'error' || !content) && (
          <div className="mt-2 flex items-start gap-2.5 rounded-xl border border-border bg-danger-soft px-3 py-2.5 text-[13px]">
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-danger" />
            <div className="min-w-0 flex-1">
              <p className="text-fg">{error.message}</p>
              {error.suggestion && <p className="mt-0.5 text-muted">{error.suggestion}</p>}
            </div>
            {isLast && (actions.onRetry || actions.onRegenerate) && (
              <Button size="sm" variant="outline" onClick={() => (live ? actions.onRetry?.() : actions.onRegenerate?.(m))}>
                Retry
              </Button>
            )}
          </div>
        )}
        {translation && <TranslationView result={translation} onClose={() => setTranslation(null)} />}
        <TranslateDialog open={translateOpen} text={content.slice(0, 12_000)} onClose={() => setTranslateOpen(false)} onDone={setTranslation} />
        {sources.length > 0 && !streaming && <Sources sources={sources} />}
        {webSources.length > 0 && <SourcesSheet open={sourcesOpen} onClose={() => setSourcesOpen(false)} sources={webSources} />}
        {!streaming && content && (
          <div className={cn('mt-2 flex flex-wrap items-center gap-0.5', !isLast && 'opacity-100 transition-opacity lg:opacity-0 lg:group-hover:opacity-100')}>
            <IconButton
              label="Copy"
              size="sm"
              onClick={async () => {
                if (await copyText(content)) {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1200);
                }
              }}
            >
              {copied ? <Check className="size-3.5 text-accent" /> : <Copy className="size-3.5" />}
            </IconButton>
            {isLast && actions.onRegenerate && !live && (
              <IconButton label="Regenerate" size="sm" disabled={busy} onClick={() => actions.onRegenerate?.(m)}>
                <RefreshCw className="size-3.5" />
              </IconButton>
            )}
            {ttsSupported() && !reading && (
              <IconButton
                label="Read aloud"
                size="sm"
                onClick={() =>
                  void speak(m.id, content, {
                    voiceName: settings.voiceName,
                    natural: settings.naturalVoice,
                    voice: naturalVoiceFrom(settings),
                    onFallback: (msg) => toast(msg, 'info'),
                  })
                }
              >
                <Volume2 className="size-3.5" />
              </IconButton>
            )}
            {reading && (
              <>
                {playback.status === 'loading' ? (
                  <span className="inline-flex h-7 items-center px-1.5 text-[11px] text-muted">Preparing voice…</span>
                ) : playback.status === 'paused' ? (
                  <IconButton label="Resume reading" size="sm" active onClick={resumeSpeaking}>
                    <Play className="size-3.5" />
                  </IconButton>
                ) : (
                  <IconButton label="Pause reading" size="sm" active onClick={pauseSpeaking}>
                    <Pause className="size-3.5" />
                  </IconButton>
                )}
                <IconButton label="Stop reading" size="sm" active onClick={stopSpeaking}>
                  <Square className="size-3 fill-current" />
                </IconButton>
              </>
            )}
            {!live && (
              <IconButton
                label={saved ? 'Remove bookmark' : 'Save response'}
                size="sm"
                active={saved}
                onClick={() => {
                  actions.onToggleSave?.(m, !saved);
                  toast(saved ? 'Removed from saved.' : 'Saved to bookmarks.', 'success');
                }}
              >
                <Bookmark className={cn('size-3.5', saved && 'fill-current')} />
              </IconButton>
            )}
            {isLast && actions.onQuickAction && !live && (
              <Menu
                align="start"
                trigger={(p) => (
                  <IconButton {...p} label="More actions" size="sm" disabled={busy}>
                    <Sparkles className="size-3.5" />
                  </IconButton>
                )}
                items={[
                  { label: 'Explain further', icon: <Sparkles className="size-4" />, onSelect: () => actions.onQuickAction?.('explain') },
                  { label: 'Summarize', icon: <ListCollapse className="size-4" />, onSelect: () => actions.onQuickAction?.('summarize') },
                  { label: 'Make shorter', icon: <Minimize2 className="size-4" />, onSelect: () => actions.onQuickAction?.('shorter') },
                  { label: 'Make more detailed', icon: <Maximize2 className="size-4" />, onSelect: () => actions.onQuickAction?.('longer') },
                  { label: 'Translate…', icon: <Languages className="size-4" />, onSelect: () => actions.onQuickAction?.('translate') },
                  { label: 'Continue writing', icon: <StepForward className="size-4" />, onSelect: () => actions.onQuickAction?.('continue') },
                ]}
              />
            )}
            {!live && (
              <Menu
                align="start"
                trigger={(p) => (
                  <IconButton {...p} label="Message options" size="sm">
                    <MoreHorizontal className="size-3.5" />
                  </IconButton>
                )}
                items={[
                  { label: 'Translate with Cloudflare', icon: <Languages className="size-4" />, onSelect: () => setTranslateOpen(true) },
                  { label: 'Delete message', icon: <Trash2 className="size-4" />, danger: true, onSelect: () => actions.onDelete?.(m) },
                ]}
              />
            )}
            {webSources.length > 0 && <SourcesButton sources={webSources} onOpen={() => setSourcesOpen(true)} />}
            {model && <span className="ml-1.5 truncate text-[11px] text-subtle">{modelShortName(model)}</span>}
            <ContextLine used={m.contextUsed ?? (live?.context ? { ...live.context, web: live.sources.filter((x) => x.kind === 'web').length } : null)} />
          </div>
        )}
      </div>
    </div>
  );
});
