import {
  AlertCircle,
  Bookmark,
  Brain,
  Check,
  ChevronDown,
  CircleDollarSign,
  Copy,
  FileText,
  Globe,
  Languages,
  ListCollapse,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Shuffle,
  Sparkles,
  StepForward,
  Telescope,
  Trash2,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { memo, useState } from 'react';
import type { ApprovalRequest, QuickAction, ResearchStep, RouteInfo, SearchInfo, Source } from '@shared/types';
import { LogoMark } from '@/components/Logo';
import { Markdown } from '@/components/Markdown';
import { Button, IconButton, Menu, Textarea } from '@/components/ui';
import { speak, stopSpeaking, ttsSupported, useSpeaking } from '@/lib/speech';
import type { Message } from '@/lib/types';
import { cn, copyText, domainOf, modelShortName, relativeTime } from '@/lib/utils';
import { useSettings } from '@/state/settings';
import { useToast } from '@/state/toast';
import type { LiveReply } from './engine';

function Sources({ sources }: { sources: Source[] }) {
  const [open, setOpen] = useState(false);
  const web = sources.filter((s) => s.kind === 'web');
  const docs = sources.filter((s) => s.kind === 'document');
  const shown = open ? web : web.slice(0, 4);
  return (
    <div className="mt-3 space-y-2">
      {web.length > 0 && (
        <div>
          <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-subtle">Sources</div>
          <div className="flex flex-wrap gap-1.5">
            {shown.map((s) => (
              <a
                key={s.index}
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                title={[s.title, s.site && s.site !== domainOf(s.url) ? s.site : '', s.publishedDate ? `Published: ${s.publishedDate}` : '', s.snippet ?? '']
                  .filter(Boolean)
                  .join('\n')}
                className="flex max-w-[260px] items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1 text-xs transition-colors hover:border-border-strong hover:bg-surface-2"
              >
                <span className="flex size-4 shrink-0 items-center justify-center rounded bg-surface-2 text-[10px] font-semibold text-muted">
                  {s.index}
                </span>
                <span className="truncate">{s.title || domainOf(s.url)}</span>
                <span className="shrink-0 text-subtle">{s.site || domainOf(s.url)}</span>
                {s.publishedDate && <span className="shrink-0 text-subtle">· {s.publishedDate}</span>}
              </a>
            ))}
            {web.length > 4 && (
              <button onClick={() => setOpen((o) => !o)} className="rounded-lg px-2 py-1 text-xs text-muted hover:bg-surface-2">
                {open ? 'Show less' : `+${web.length - 4} more`}
              </button>
            )}
          </div>
        </div>
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

const PROVIDER: Record<string, string> = { serpapi: 'SerpAPI', tavily: 'Tavily' };

function SearchStatus({ info, steps, live }: { info?: SearchInfo | null; steps: ResearchStep[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  if (!info && !steps.length) return null;
  const provider = info?.provider ? PROVIDER[info.provider] : null;
  let label: string;
  if (!info) label = 'Researching…';
  else if (info.status === 'unavailable') label = info.message ? `Web search not used: ${info.message}` : 'Web search not used';
  else if (info.mode === 'research') label = `Deep research${info.message ? ` · ${info.message}` : ''}`;
  else if (info.mode === 'extract') label = `Read the linked page${info.cached ? ' (from cache)' : ''}`;
  else if (info.cached) label = `Web results from cache${info.cachedAt ? `, fetched ${relativeTime(info.cachedAt)}` : ''}`;
  else label = info.trigger === 'auto' ? 'Searched the web automatically (current information needed)' : 'Searched the web';
  const Icon = info?.mode === 'research' || (!info && steps.length) ? Telescope : Globe;
  const expandable = steps.length > 0;
  return (
    <div className="mb-2 text-xs text-muted">
      <button
        type="button"
        disabled={!expandable}
        onClick={() => setOpen((o) => !o)}
        className={cn('flex max-w-full items-center gap-1.5 text-left', expandable && 'hover:text-fg')}
        title={info?.query ? `Query: ${info.query}` : undefined}
      >
        <Icon className={cn('size-3.5 shrink-0', info?.status === 'unavailable' ? 'text-warn' : 'text-accent', live && !info && 'animate-pulse')} />
        <span className="min-w-0">
          {label}
          {provider && info?.status === 'ok' && <span className="text-subtle"> · {provider}</span>}
        </span>
        {expandable && <ChevronDown className={cn('size-3 shrink-0 transition-transform', (open || live) && 'rotate-180')} />}
      </button>
      {expandable && (open || (live && !info)) && (
        <ol className="mt-1.5 space-y-1 border-l-2 border-border pl-3">
          {steps.map((s, i) => (
            <li key={i} className={cn(s.kind === 'skip' && 'text-warn')}>
              {s.kind === 'search' ? 'Searched: ' : s.kind === 'read' ? '' : s.kind === 'skip' ? 'Skipped: ' : ''}
              {s.text}
              {s.provider && <span className="text-subtle"> · {PROVIDER[s.provider]}{s.cached ? ' (cache)' : ''}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Reasoning({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-3">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 text-[13px] text-muted hover:text-fg">
        <Brain className={cn('size-3.5', live && 'animate-pulse text-accent')} />
        {live ? 'Thinking…' : 'Reasoning'}
        <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
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
              The OpenRouter account has no credits, so this model cannot run until credits are added. Tessera never buys credits for you.
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
}: {
  m: Message;
  actions: MessageActions;
  canEdit: boolean;
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
            <span key={i} className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1 text-xs">
              <FileText className="size-3.5 text-accent" />
              {d.name}
            </span>
          ))}
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
  const speakingId = useSpeaking();
  const [copied, setCopied] = useState(false);
  const streaming = live ? live.status === 'streaming' || live.status === 'connecting' : false;
  const content = live?.content ?? m.content;
  const reasoning = live?.reasoning ?? m.reasoning ?? '';
  const sources = live?.sources ?? m.sources ?? [];
  const notices = live?.notices ?? m.notices ?? [];
  const search = live ? live.search : m.search;
  const researchSteps = live?.researchSteps ?? m.researchSteps ?? [];
  const model = live?.model ?? m.model;
  const error = live?.error ?? m.error;
  const status = live ? live.status : m.status;
  const route = live ? live.route : m.route;
  const approval = live ? live.approval : m.approval;

  return (
    <div className="group flex gap-3">
      <div className="hidden shrink-0 pt-0.5 sm:block">
        <div className="flex size-7 items-center justify-center rounded-full border border-border bg-bg">
          <LogoMark className="size-4" />
        </div>
      </div>
      <div className="min-w-0 flex-1">
        {route && <RouteNote route={route} />}
        <SearchStatus info={search} steps={researchSteps} live={streaming} />
        {notices.map((n, i) => (
          <div key={i} className="mb-2 rounded-lg bg-surface px-3 py-1.5 text-xs text-muted">
            {n}
          </div>
        ))}
        {reasoning && <Reasoning text={reasoning} live={streaming && !content} />}
        {live && live.status === 'connecting' && !content && (
          <div className="flex items-center gap-2 py-1.5 text-sm text-muted">
            <span className="flex gap-1">
              <span className="size-1.5 animate-bounce rounded-full bg-accent [animation-delay:-0.3s]" />
              <span className="size-1.5 animate-bounce rounded-full bg-accent [animation-delay:-0.15s]" />
              <span className="size-1.5 animate-bounce rounded-full bg-accent" />
            </span>
            {live.researchSteps.length && !live.search ? 'Researching…' : live.sources.length ? 'Reading sources…' : 'Thinking…'}
          </div>
        )}
        {content && (
          <div className={cn('text-[15px] leading-[1.65]', streaming && 'caret-host')}>
            <Markdown content={content} sources={sources} streaming={streaming} />
          </div>
        )}
        {status === 'stopped' && <p className="mt-2 text-xs text-subtle">Stopped</p>}
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
        {sources.length > 0 && !streaming && <Sources sources={sources} />}
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
            {ttsSupported() && (
              <IconButton
                label={speakingId === m.id ? 'Stop reading' : 'Read aloud'}
                size="sm"
                active={speakingId === m.id}
                onClick={() => (speakingId === m.id ? stopSpeaking() : speak(m.id, content, settings.voiceName))}
              >
                {speakingId === m.id ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
              </IconButton>
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
                items={[{ label: 'Delete message', icon: <Trash2 className="size-4" />, danger: true, onSelect: () => actions.onDelete?.(m) }]}
              />
            )}
            {model && <span className="ml-1.5 truncate text-[11px] text-subtle">{modelShortName(model)}</span>}
            {live?.context && (live.context.memories > 0 || live.context.conversations > 0) && (
              <span className="ml-1.5 text-[11px] text-subtle" title="Context used for this answer">
                · used {live.context.memories} memor{live.context.memories === 1 ? 'y' : 'ies'}
                {live.context.conversations ? `, ${live.context.conversations} past chat${live.context.conversations > 1 ? 's' : ''}` : ''}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
