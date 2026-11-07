import { limit, orderBy, query } from 'firebase/firestore';
import { ArrowDown, Bookmark, Download, FileText, FolderInput, Menu as MenuIcon, MoreHorizontal, PanelLeftOpen, Pencil, SquarePen, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { QUICK_ACTIONS, type ImageAttachment, type ModelInfo, type QuickAction } from '@shared/types';
import { Button, Dialog, IconButton, Input, Menu, Spinner } from '@/components/ui';
import {
  addUserMessage,
  attachDocument,
  createConversation,
  deleteMessages,
  editUserMessage,
  paths,
  toggleSavedResponse,
  updateConversation,
} from '@/lib/db';
import { exportMarkdown, exportPdf, exportText } from '@/lib/export';
import { useDocument, useQuery } from '@/lib/hooks';
import type { Conversation, DocumentMeta, Message, Project, SavedResponse } from '@/lib/types';
import { newId } from '@/lib/utils';
import { useOnline } from '@/lib/viewport';
import { useUid } from '@/state/auth';
import { useCatalog } from '@/state/catalog';
import { useSettings } from '@/state/settings';
import { useToast } from '@/state/toast';
import { uploadDocument } from '../documents/upload';
import { useShell } from '../shell/AppShell';
import { useDeleteConversation, useRenameDialog } from '../shell/Sidebar';
import { Composer } from './Composer';
import { clearLiveReply, generate, stopGeneration, toTurns, useLiveReply } from './engine';
import { AssistantMessage, UserMessage, type MessageActions } from './MessageItem';
import { ModelPicker } from './ModelPicker';
import { Welcome } from './Welcome';

const PAGE = 60;

function LibraryPicker({
  open,
  onClose,
  selected,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  selected: string[];
  onPick: (id: string) => void;
}) {
  const uid = useUid();
  const { data, loading } = useQuery<DocumentMeta>(open ? query(paths.documents(uid), orderBy('createdAt', 'desc'), limit(100)) : null, [open, uid]);
  return (
    <Dialog open={open} onClose={onClose} title="Attach from your documents" description="Attached documents are searched when you ask questions in this chat.">
      {loading ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : !data.length ? (
        <p className="py-8 text-center text-sm text-muted">Your document library is empty. Upload a file with the paperclip button.</p>
      ) : (
        <div className="space-y-1">
          {data.map((d) => {
            const on = selected.includes(d.id);
            return (
              <button
                key={d.id}
                disabled={d.status !== 'ready' || on}
                onClick={() => {
                  onPick(d.id);
                  onClose();
                }}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-surface-2 disabled:opacity-50"
              >
                <FileText className="size-4 shrink-0 text-accent" />
                <span className="min-w-0 flex-1 truncate text-sm">{d.name}</span>
                <span className="text-xs text-muted">{on ? 'Attached' : d.status === 'ready' ? `${d.chunkCount ?? 0} sections` : d.status}</span>
              </button>
            );
          })}
        </div>
      )}
    </Dialog>
  );
}

export default function ChatPage() {
  const { conversationId } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const uid = useUid();
  const toast = useToast();
  const online = useOnline();
  const { settings } = useSettings();
  const { catalog, caps, getModel } = useCatalog();
  const shell = useShell();
  const rename = useRenameDialog();
  const del = useDeleteConversation();

  // ----- draft state for a brand-new chat -----
  const [draftId, setDraftId] = useState(() => newId());
  const [draftModel, setDraftModel] = useState<string | null>(null);
  const [draftDocs, setDraftDocs] = useState<string[]>([]);
  const [webSearch, setWebSearch] = useState(settings.webSearchDefault);
  const [deepResearch, setDeepResearch] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [translateOpen, setTranslateOpen] = useState(false);
  const [translateLang, setTranslateLang] = useState('English');
  const [moveOpen, setMoveOpen] = useState(false);
  const [count, setCount] = useState(PAGE);

  const projectParam = params.get('project');
  const docParam = params.get('doc');

  useEffect(() => {
    if (!conversationId) {
      setDraftId(newId());
      setDraftDocs(docParam ? [docParam] : []);
    }
    setCount(PAGE);
  }, [conversationId, docParam]);

  const convState = useDocument<Conversation>(conversationId ? paths.conversation(uid, conversationId) : null, [uid, conversationId]);
  const conv = convState.data;
  const messagesState = useQuery<Message>(
    conversationId ? query(paths.messages(uid, conversationId), orderBy('createdAt', 'desc'), limit(count)) : null,
    [uid, conversationId, count],
  );
  const messages = useMemo(() => [...messagesState.data].reverse(), [messagesState.data]);
  const live = useLiveReply(conversationId);
  const generating = Boolean(live && (live.status === 'streaming' || live.status === 'connecting'));

  // once the server-persisted message arrives, drop the live copy
  useEffect(() => {
    if (!live || !conversationId) return;
    if (live.status !== 'streaming' && live.status !== 'connecting' && messages.some((m) => m.id === live.id)) {
      clearLiveReply(conversationId);
    }
  }, [live, messages, conversationId]);

  const { data: savedList } = useQuery<SavedResponse>(query(paths.saved(uid), limit(500)), [uid]);
  const savedIds = useMemo(() => new Set(savedList.map((s) => s.messageId)), [savedList]);
  const { data: projects } = useQuery<Project>(query(paths.projects(uid), orderBy('name'), limit(100)), [uid]);

  const convDocs = conv?.documentIds;
  const docIds = useMemo(() => (conversationId ? convDocs ?? [] : draftDocs), [conversationId, convDocs, draftDocs]);
  const { data: allDocs } = useQuery<DocumentMeta>(
    docIds.length ? query(paths.documents(uid), orderBy('createdAt', 'desc'), limit(200)) : null,
    [uid, docIds.join(',')],
  );
  const attachedDocs = useMemo(() => allDocs.filter((d) => docIds.includes(d.id)), [allDocs, docIds]);

  // ----- model -----
  const fallbackDefault = catalog?.defaultModel ?? 'nvidia/nemotron-3-ultra-550b-a55b:free';
  const modelId = (conversationId ? conv?.model : draftModel) ?? settings.defaultModel ?? fallbackDefault;
  const model = getModel(modelId);
  const visionAlternative = useMemo<ModelInfo | undefined>(() => {
    const models = catalog?.models ?? [];
    const paidOk = catalog?.paidAvailable !== false;
    const ok = (m?: ModelInfo) => m && m.capabilities.vision && (m.free || paidOk);
    const fromFallbacks = catalog?.fallbackModels.map((id) => getModel(id)).find(ok);
    return fromFallbacks ?? models.find((m) => m.featured && ok(m)) ?? models.find((m) => ok(m));
  }, [catalog, getModel]);

  const setModel = (id: string) => {
    if (conversationId) updateConversation(uid, conversationId, { model: id }).catch(() => toast('Could not change model.', 'error'));
    else setDraftModel(id);
  };

  const projectId = conversationId ? conv?.projectId ?? null : projectParam;
  const project = projects.find((p) => p.id === projectId);

  // ----- scrolling -----
  const scroller = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const stick = useRef(true);
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    stick.current = near;
    setAtBottom(near);
  };
  const scrollToBottom = useCallback((smooth = false) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    stick.current = true;
  }, []);
  useLayoutEffect(() => {
    if (stick.current) scrollToBottom();
  }, [messages.length, live?.content, live?.status, scrollToBottom]);
  useEffect(() => {
    stick.current = true;
    requestAnimationFrame(() => scrollToBottom());
  }, [conversationId, scrollToBottom]);

  // ----- actions -----
  const runGeneration = useCallback(
    (cid: string, history: Message[], extraDocs?: string[]) => {
      void generate({
        uid,
        conversationId: cid,
        model: modelId,
        history: toTurns(history),
        options: {
          webSearch: webSearch && Boolean(caps?.searchAvailable),
          autoSearch: settings.autoSearch && Boolean(caps?.searchAvailable),
          deepResearch: deepResearch && Boolean(caps?.searchAvailable),
          memory: settings.memoryEnabled,
          documentIds: extraDocs ?? docIds,
          projectId,
        },
      });
      // Deep Research spends search credits, so it applies to one message at a time.
      if (deepResearch) setDeepResearch(false);
    },
    [uid, modelId, webSearch, deepResearch, caps?.searchAvailable, settings.memoryEnabled, settings.autoSearch, docIds, projectId],
  );

  const send = async (text: string, images: ImageAttachment[]) => {
    if (!online) {
      toast('You are offline. Reconnect to send messages.', 'error');
      return;
    }
    let cid = conversationId;
    try {
      if (!cid) {
        cid = await createConversation(uid, {
          id: draftId,
          title: text.split('\n')[0].slice(0, 60) || (images.length ? 'Image' : 'New chat'),
          projectId: projectParam,
          model: draftModel ?? settings.defaultModel ?? fallbackDefault,
          documentIds: draftDocs,
        });
        navigate(`/c/${cid}`, { replace: false });
      }
      const docAttachments = attachedDocs
        .filter((d) => d.status === 'ready')
        .map((d) => ({ kind: 'document' as const, documentId: d.id, name: d.name, mime: d.mime }));
      const isFirstDocMention = messages.length === 0;
      const attachments = [...images, ...(isFirstDocMention ? docAttachments : [])];
      const mid = await addUserMessage(uid, cid, text, attachments);
      stick.current = true;
      const userMsg: Message = { id: mid, role: 'user', content: text, attachments };
      runGeneration(cid, [...messages, userMsg], docIds);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not send the message.', 'error');
    }
  };

  const regenerate = async (m: Message) => {
    if (!conversationId) return;
    const idx = messages.findIndex((x) => x.id === m.id);
    if (idx < 0) return;
    const after = messages.slice(idx).map((x) => x.id);
    await deleteMessages(uid, conversationId, after).catch(() => undefined);
    runGeneration(conversationId, messages.slice(0, idx));
  };

  const retry = () => {
    if (!conversationId) return;
    clearLiveReply(conversationId);
    runGeneration(conversationId, messages);
  };

  const edit = async (m: Message, text: string) => {
    if (!conversationId) return;
    const idx = messages.findIndex((x) => x.id === m.id);
    const after = messages.slice(idx + 1).map((x) => x.id);
    await editUserMessage(uid, conversationId, m.id, text);
    await deleteMessages(uid, conversationId, after).catch(() => undefined);
    runGeneration(conversationId, [...messages.slice(0, idx), { ...m, content: text }]);
  };

  const quickAction = (action: QuickAction) => {
    if (action === 'translate') {
      setTranslateLang(settings.language && settings.language !== 'auto' ? settings.language : 'English');
      setTranslateOpen(true);
      return;
    }
    void send(QUICK_ACTIONS[action], []);
  };

  const actions: MessageActions = {
    onRegenerate: regenerate,
    onEdit: edit,
    onRetry: retry,
    onDelete: (m) => conversationId && deleteMessages(uid, conversationId, [m.id]).catch(() => toast('Could not delete.', 'error')),
    onToggleSave: (m, s) => conv && toggleSavedResponse(uid, conv, m, s).catch(() => toast('Could not update bookmark.', 'error')),
    onQuickAction: quickAction,
  };

  const uploadDocs = async (files: File[]) => {
    for (const f of files) {
      try {
        const id = await uploadDocument(uid, f);
        if (conversationId) await attachDocument(uid, conversationId, id, true);
        else setDraftDocs((d) => [...d, id]);
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Upload failed.', 'error');
      }
    }
  };
  const removeDoc = (id: string) => {
    if (conversationId) attachDocument(uid, conversationId, id, false).catch(() => undefined);
    else setDraftDocs((d) => d.filter((x) => x !== id));
    if (docParam === id) {
      params.delete('doc');
      setParams(params, { replace: true });
    }
  };
  const pickDoc = (id: string) => {
    if (conversationId) attachDocument(uid, conversationId, id, true).catch(() => undefined);
    else setDraftDocs((d) => (d.includes(id) ? d : [...d, id]));
  };

  const notFound = conversationId && !convState.loading && !convState.exists;
  const showWelcome = !conversationId || (!messagesState.loading && messages.length === 0 && !live);
  const lastAssistantId = [...messages].reverse().find((m) => m.role === 'assistant')?.id;
  const liveIsNew = live && !messages.some((m) => m.id === live.id);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="flex shrink-0 items-center gap-1 px-2 pt-safe sm:px-3">
        <div className="flex h-14 min-w-0 flex-1 items-center gap-1">
          {!shell.isDesktop ? (
            <IconButton label="Open menu" onClick={shell.openNav}>
              <MenuIcon className="size-5" />
            </IconButton>
          ) : (
            shell.sidebarCollapsed && (
              <>
                <IconButton label="Open sidebar" onClick={shell.toggleSidebar}>
                  <PanelLeftOpen className="size-[18px]" />
                </IconButton>
                <IconButton label="New chat" onClick={() => navigate('/')}>
                  <SquarePen className="size-[18px]" />
                </IconButton>
              </>
            )
          )}
          <ModelPicker value={modelId} onChange={setModel} />
          {project && (
            <button
              onClick={() => navigate(`/projects/${project.id}`)}
              className="hidden truncate rounded-md px-2 py-1 text-xs text-muted hover:bg-surface-2 sm:block"
            >
              in {project.name}
            </button>
          )}
        </div>
        {conv && (
          <Menu
            trigger={(p) => (
              <IconButton {...p} label="Conversation options">
                <MoreHorizontal className="size-5" />
              </IconButton>
            )}
            items={[
              { label: 'Rename', icon: <Pencil className="size-4" />, onSelect: () => rename.open(conv) },
              {
                label: conv.saved ? 'Remove from saved' : 'Save conversation',
                icon: <Bookmark className="size-4" />,
                onSelect: () => updateConversation(uid, conv.id, { saved: !conv.saved }),
              },
              { label: 'Move to project', icon: <FolderInput className="size-4" />, onSelect: () => setMoveOpen(true) },
              'separator',
              { label: 'Export as Markdown', icon: <Download className="size-4" />, onSelect: () => exportMarkdown(conv, messages) },
              { label: 'Export as text', icon: <Download className="size-4" />, onSelect: () => exportText(conv, messages) },
              { label: 'Export as PDF', icon: <Download className="size-4" />, onSelect: () => void exportPdf(conv, messages) },
              'separator',
              { label: 'Delete', icon: <Trash2 className="size-4" />, danger: true, onSelect: () => del.open(conv) },
            ]}
          />
        )}
        {!shell.isDesktop && (
          <IconButton label="New chat" onClick={() => navigate(projectId ? `/?project=${projectId}` : '/')}>
            <SquarePen className="size-5" />
          </IconButton>
        )}
      </header>

      {!online && (
        <div className="mx-auto mb-1 rounded-full bg-warn-soft px-3 py-1 text-xs text-warn">Offline: history is available, sending is paused.</div>
      )}

      {/* Body */}
      <div ref={scroller} onScroll={onScroll} className="scroll-thin touch-scroll relative min-h-0 flex-1 overflow-y-auto">
        {notFound ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="text-sm text-muted">This conversation doesn’t exist or was deleted.</p>
            <Button variant="primary" onClick={() => navigate('/')}>
              Start a new chat
            </Button>
          </div>
        ) : showWelcome ? (
          <Welcome projectName={project?.name} onPrompt={(t) => void send(t, [])} />
        ) : (
          <div className="mx-auto w-full max-w-3xl px-4 pb-6 pt-2 sm:px-6">
            {messages.length >= count && (
              <div className="mb-4 flex justify-center">
                <Button size="sm" variant="ghost" onClick={() => setCount((c) => c + PAGE)}>
                  Load earlier messages
                </Button>
              </div>
            )}
            {messagesState.loading && !messages.length && (
              <div className="flex justify-center py-10">
                <Spinner />
              </div>
            )}
            <div className="space-y-7">
              {messages.map((m) =>
                m.role === 'user' ? (
                  <UserMessage key={m.id} m={m} actions={actions} canEdit={!generating} />
                ) : (
                  <AssistantMessage
                    key={m.id}
                    m={m}
                    isLast={m.id === lastAssistantId && !liveIsNew}
                    saved={savedIds.has(m.id)}
                    actions={actions}
                    busy={generating}
                  />
                ),
              )}
              {live && liveIsNew && (
                <AssistantMessage
                  m={{ id: live.id, role: 'assistant', content: live.content }}
                  live={live}
                  isLast
                  saved={false}
                  actions={actions}
                  busy={generating}
                />
              )}
            </div>
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="relative shrink-0 composer-safe pt-1">
        {!atBottom && !showWelcome && (
          <button
            onClick={() => scrollToBottom(true)}
            className="absolute -top-11 left-1/2 flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-elevated text-muted shadow-md hover:text-fg"
            aria-label="Scroll to bottom"
          >
            <ArrowDown className="size-4" />
          </button>
        )}
        {!notFound && (
          <Composer
            key={conversationId ?? draftId}
            onSend={send}
            onStop={() => conversationId && stopGeneration(conversationId)}
            generating={generating}
            model={model}
            visionAlternative={visionAlternative}
            onSwitchModel={setModel}
            webSearch={webSearch}
            onWebSearch={setWebSearch}
            searchAvailable={Boolean(caps?.searchAvailable)}
            searchHint={
              webSearch
                ? 'Web search is on for every message'
                : settings.autoSearch
                  ? 'Auto: searches only when a message needs current information. Tap to search every message.'
                  : 'Search the web for every message'
            }
            deepResearch={deepResearch}
            onDeepResearch={setDeepResearch}
            documents={attachedDocs}
            onUploadDocuments={uploadDocs}
            onRemoveDocument={removeDoc}
            onPickFromLibrary={() => setLibraryOpen(true)}
            sendOnEnter={settings.sendOnEnter}
            autoFocus={!conversationId}
            placeholder={project ? `Message Tessera in ${project.name}` : undefined}
          />
        )}
        <p className="mx-auto mt-1.5 hidden max-w-3xl px-4 text-center text-[11px] text-subtle sm:block">
          Tessera can make mistakes. Verify important information.
        </p>
      </div>

      <LibraryPicker open={libraryOpen} onClose={() => setLibraryOpen(false)} selected={docIds} onPick={pickDoc} />

      <Dialog
        open={translateOpen}
        onClose={() => setTranslateOpen(false)}
        title="Translate answer"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setTranslateOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!translateLang.trim()}
              onClick={() => {
                setTranslateOpen(false);
                void send(QUICK_ACTIONS.translate.replace('{language}', translateLang.trim()), []);
              }}
            >
              Translate
            </Button>
          </>
        }
      >
        <Input autoFocus value={translateLang} onChange={(e) => setTranslateLang(e.target.value)} placeholder="Language, e.g. French" />
      </Dialog>

      <Dialog open={moveOpen} onClose={() => setMoveOpen(false)} title="Move to project" size="sm">
        <div className="space-y-1">
          <button
            onClick={() => {
              if (conv) updateConversation(uid, conv.id, { projectId: null });
              setMoveOpen(false);
            }}
            className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-2"
          >
            No project
          </button>
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => {
                if (conv) updateConversation(uid, conv.id, { projectId: p.id });
                setMoveOpen(false);
              }}
              className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-2"
            >
              {p.name} {conv?.projectId === p.id && <span className="text-xs text-accent">(current)</span>}
            </button>
          ))}
          {!projects.length && <p className="px-3 py-2 text-sm text-muted">No projects yet. Create one from the Projects page.</p>}
        </div>
      </Dialog>
      {rename.dialog}
      {del.dialog}
    </div>
  );
}
