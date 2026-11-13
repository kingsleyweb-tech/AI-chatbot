import { unlockAudio } from '@/lib/speech';
import { primeVoiceAudio } from '@/lib/voiceEngine';
import { VoiceMode } from './VoiceMode';
import { getDocs, limit, orderBy, query } from 'firebase/firestore';
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
import { planSend, withoutSent, type PendingUpload } from './attachments';
import { Composer } from './Composer';
import { clearLiveReply, generate, isGenerating, setSending, stopGeneration, toTurns, useLiveReplies, useSending, type LiveReply } from './engine';
import { AssistantMessage, UserMessage, type MessageActions } from './MessageItem';
import { ModelPicker } from './ModelPicker';
import { Welcome } from './Welcome';
import { UsageIndicator } from '../usage/UsageIndicator';

const PAGE = 60;
/** A reply still 'processing' this long after it started was interrupted (longer than the server may run). */
const STALE_PROCESSING_MS = 2 * 60_000;

const isActive = (r: LiveReply) => r.status === 'streaming' || r.status === 'connecting';

/** A live reply as a message, for the history sent to the model. */
function replyAsMessage(r: LiveReply): Message {
  return { id: r.id, role: 'assistant', content: r.content, model: r.model, sources: r.sources, status: r.status === 'error' ? 'error' : 'complete' };
}

/** Show a reply whose generation died without a final status as interrupted, with Retry. */
function withInterruption(m: Message): Message {
  if (m.role !== 'assistant' || m.status !== 'processing') return m;
  const started = m.createdAt?.toMillis?.() ?? 0;
  if (!started || Date.now() - started < STALE_PROCESSING_MS) return m;
  return {
    ...m,
    status: m.content ? 'stopped' : 'error',
    error: m.content ? null : { code: 'interrupted', message: 'This response was interrupted before it finished.', suggestion: null },
  };
}

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

  // Documents waiting in the composer of an existing conversation (they move into the next
  // message once it is stored). A new chat uses draftDocs for the same purpose.
  const [tray, setTray] = useState<Record<string, string[]>>({});
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  // the file behind each document added here, so a failed upload or read can be retried
  const files = useRef(new Map<string, File>());
  // A message that could not be stored: its text, images and documents go back into the composer.
  const [restore, setRestore] = useState<{ key: string; text: string; images: ImageAttachment[]; seq: number } | null>(null);
  const restoreDocs = useRef<string[] | null>(null);

  useEffect(() => {
    if (!conversationId) {
      const back = restoreDocs.current;
      restoreDocs.current = null;
      setDraftDocs(back ?? (docParam ? [docParam] : []));
    }
    setCount(PAGE);
  }, [conversationId, docParam]);

  const convState = useDocument<Conversation>(conversationId ? paths.conversation(uid, conversationId) : null, [uid, conversationId]);
  const conv = convState.data;
  /** Exports cover the whole conversation, not only the messages loaded on screen. */
  const exportAll = async (fn: (c: Conversation, m: Message[]) => unknown) => {
    if (!conv) return;
    try {
      const snap = await getDocs(query(paths.messages(uid, conv.id), orderBy('createdAt', 'asc')));
      await fn(conv, snap.docs.map((d) => ({ ...(d.data() as Omit<Message, 'id'>), id: d.id })));
    } catch {
      toast('The export could not be created. Try again.', 'error');
    }
  };
  const messagesState = useQuery<Message>(
    conversationId ? query(paths.messages(uid, conversationId), orderBy('createdAt', 'desc'), limit(count)) : null,
    [uid, conversationId, count],
  );
  const messages = useMemo(() => [...messagesState.data].reverse(), [messagesState.data]);
  // Replies being generated or not yet confirmed by Firestore (oldest first).
  // Each stays visible until its stored copy arrives: a new message never hides an earlier reply.
  const liveReplies = useLiveReplies(conversationId);
  const live = liveReplies[liveReplies.length - 1];
  const generating = Boolean(live && isActive(live));
  const liveById = new Map(liveReplies.map((r) => [r.id, r]));
  const storedIds = new Set(messages.map((m) => m.id));
  const unsavedReplies = liveReplies.filter((r) => !storedIds.has(r.id));
  // a user message is on its way to Firestore (shown from the local copy until confirmed)
  const sending = useSending(conversationId);
  const sendingRef = useRef(false);
  const [voiceOpen, setVoiceOpen] = useState(false);

  // once a reply's final stored copy arrives, show that instead of the live copy
  useEffect(() => {
    if (!conversationId) return;
    for (const r of liveReplies) {
      if (isActive(r)) continue;
      const m = messages.find((x) => x.id === r.id);
      if (m && m.status !== 'processing' && (r.status === 'error' || (m.content ?? '').length >= r.content.length)) {
        clearLiveReply(conversationId, r.id);
      }
    }
  }, [liveReplies, live?.status, messages, conversationId]);

  /** The whole conversation as the user sees it: stored messages, live replies in place, unsaved replies last. */
  const currentThread = (): Message[] => [
    ...messages.map((m) => {
      const r = liveById.get(m.id);
      return r ? { ...m, ...replyAsMessage(r) } : m;
    }),
    ...unsavedReplies.map(replyAsMessage),
  ];

  const { data: savedList } = useQuery<SavedResponse>(query(paths.saved(uid), limit(500)), [uid]);
  const savedIds = useMemo(() => new Set(savedList.map((s) => s.messageId)), [savedList]);
  const { data: projects } = useQuery<Project>(query(paths.projects(uid), orderBy('name'), limit(100)), [uid]);

  const convDocs = conv?.documentIds;
  const docIds = useMemo(() => (conversationId ? convDocs ?? [] : draftDocs), [conversationId, convDocs, draftDocs]);
  const { data: allDocs } = useQuery<DocumentMeta>(
    docIds.length ? query(paths.documents(uid), orderBy('createdAt', 'desc'), limit(200)) : null,
    [uid, docIds.join(',')],
  );
  const convKey = conversationId ?? 'new';
  const pendingIds = useMemo(() => (conversationId ? tray[conversationId] ?? [] : draftDocs), [conversationId, tray, draftDocs]);
  const pendingDocs = useMemo(
    () => pendingIds.map((id) => allDocs.find((d) => d.id === id)).filter((d): d is DocumentMeta => Boolean(d)),
    [allDocs, pendingIds],
  );
  // documents this conversation already searches that are not waiting in the composer
  const chatDocs = useMemo(
    () => (conversationId ? allDocs.filter((d) => docIds.includes(d.id) && !pendingIds.includes(d.id)) : []),
    [allDocs, docIds, pendingIds, conversationId],
  );
  const visibleUploads = useMemo(() => uploads.filter((u) => u.key === convKey), [uploads, convKey]);
  // a restored draft belongs to one composer: forget it once the user goes elsewhere
  useEffect(() => {
    setRestore((r) => (r && r.key !== convKey ? null : r));
  }, [convKey]);

  // ----- model -----
  const fallbackDefault = catalog?.defaultModel ?? 'gemini:gemini-3.6-flash';
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
    (cid: string, history: Message[], extraDocs?: string[], approvedPaidModel?: string, replyId?: string, voice?: boolean) => {
      void generate({
        uid,
        conversationId: cid,
        replyId,
        model: modelId,
        history: toTurns(history),
        options: {
          webSearch: webSearch && Boolean(caps?.searchAvailable),
          autoSearch: settings.autoSearch && Boolean(caps?.searchAvailable),
          searchMode: settings.searchMode ?? (settings.autoSearch === false ? 'manual' : 'auto'),
          deepResearch: deepResearch && Boolean(caps?.searchAvailable),
          memory: settings.memoryEnabled,
          documentIds: extraDocs ?? docIds,
          projectId,
          // explicit, one-request approval of a paid model (never remembered)
          approvedPaidModel: approvedPaidModel ?? null,
          // spoken in Voice Mode: the reply is written to be heard
          ...(voice ? { voice: true } : {}),
        },
      });
      // Deep Research spends search credits, so it applies to one message at a time.
      if (deepResearch) setDeepResearch(false);
    },
    [uid, modelId, webSearch, deepResearch, caps?.searchAvailable, settings.memoryEnabled, settings.autoSearch, settings.searchMode, docIds, projectId],
  );

  const [sendingMsg, setSendingMsg] = useState<string | null>(null);
  const send = async (text: string, images: ImageAttachment[], opts: { voice?: boolean } = {}) => {
    if (!online) {
      toast('You are offline. Reconnect to send messages.', 'error');
      if (!opts.voice) setRestore({ key: convKey, text, images, seq: Date.now() });
      return;
    }
    // one message at a time: a double tap must not send twice or start two replies
    if (sendingRef.current || sending || generating) return;
    const plan = planSend(opts.voice ? [] : pendingDocs, opts.voice ? [] : visibleUploads);
    if (plan.waiting) {
      toast('Wait until your documents have finished uploading and processing.', 'info');
      setRestore({ key: convKey, text, images, seq: Date.now() });
      return;
    }
    sendingRef.current = true;
    const draftBefore = draftDocs;
    const isNew = !conversationId;
    // a new conversation gets its ID now, so it can never reuse the previous conversation's ID
    const cid = conversationId ?? newId();
    setSending(cid, true);
    try {
      // Both writes go to the local cache first, so the conversation and the message appear at
      // once, even on a slow connection. The reply is requested only after the server confirms them.
      const writes: Promise<unknown>[] = [];
      if (isNew) {
        writes.push(
          createConversation(uid, {
            id: cid,
            title: text.split('\n')[0].slice(0, 60) || (images.length ? 'Image' : 'New chat'),
            projectId: projectParam,
            model: draftModel ?? settings.defaultModel ?? fallbackDefault,
            documentIds: draftDocs,
          }),
        );
      }
      // the ready documents in the composer are referenced by this message
      const attachments = [...images, ...plan.attachments];
      const mid = newId();
      setSendingMsg(mid);
      writes.push(addUserMessage(uid, cid, text, attachments, mid));
      if (isNew) navigate(`/c/${cid}`, { replace: false });
      stick.current = true;
      // resolves once the server has stored the message (and the new conversation)
      await Promise.all(writes);
      // stored: the sent documents leave the composer; failed ones stay for a retry
      if (isNew) {
        const left = withoutSent(draftBefore, plan.sentIds);
        if (left.length) setTray((t) => ({ ...t, [cid]: left }));
      } else if (plan.sentIds.length) {
        setTray((t) => ({ ...t, [cid]: withoutSent(t[cid] ?? [], plan.sentIds) }));
      }
      const userMsg: Message = { id: mid, role: 'user', content: text, attachments };
      runGeneration(cid, [...currentThread(), userMsg], isNew ? draftBefore : docIds, undefined, undefined, opts.voice);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not send the message.', 'error');
      // nothing was sent: put the message back into the composer, documents included
      if (!opts.voice) {
        if (isNew) {
          restoreDocs.current = draftBefore;
          navigate(projectParam ? `/?project=${projectParam}` : '/', { replace: true });
        }
        setRestore({ key: isNew ? 'new' : cid, text, images, seq: Date.now() });
      }
    } finally {
      sendingRef.current = false;
      setSendingMsg(null);
      setSending(cid, false);
    }
  };

  // Voice Mode: a spoken message may arrive just after the user interrupted a reply; wait (briefly)
  // until that reply has stopped, then send with the newest state of the page.
  const sendLatest = useRef(send);
  sendLatest.current = send;
  const stateRef = useRef({ conversationId, generating, sending, online });
  stateRef.current = { conversationId, generating, sending, online };
  const sendSpoken = async (text: string): Promise<boolean> => {
    for (let i = 0; i < 60; i++) {
      const st = stateRef.current;
      const busy = sendingRef.current || st.sending || st.generating || (st.conversationId ? isGenerating(st.conversationId) : false);
      if (!busy) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const st = stateRef.current;
    if (!st.online || sendingRef.current || st.sending || st.generating) return false;
    await sendLatest.current(text, [], { voice: true });
    return true;
  };

  /** Explicit "Regenerate" or "Retry" on a stored reply: the new reply replaces it under the same ID. */
  const regenerate = async (m: Message, approvedPaidModel?: string) => {
    if (!conversationId || generating) return;
    const thread = currentThread();
    const idx = thread.findIndex((x) => x.id === m.id);
    if (idx < 0) return;
    // only replies after this one are removed (Regenerate is offered on the last reply, so normally none)
    const after = thread.slice(idx + 1).map((x) => x.id);
    const storedAfter = after.filter((id) => storedIds.has(id));
    if (storedAfter.length) await deleteMessages(uid, conversationId, storedAfter).catch(() => undefined);
    after.forEach((id) => clearLiveReply(conversationId, id));
    runGeneration(conversationId, thread.slice(0, idx), undefined, approvedPaidModel, m.id);
  };

  /** Retry a reply that failed while live: same ID, so the failed copy is replaced, never duplicated. */
  const retry = () => {
    if (!conversationId || !live || generating) return;
    const id = live.id;
    runGeneration(conversationId, currentThread().filter((x) => x.id !== id), undefined, undefined, id);
  };

  /** A user message whose reply was never stored: generate one without adding the message again. */
  const generateMissing = () => {
    if (!conversationId || generating || sending || sendingRef.current) return;
    runGeneration(conversationId, currentThread());
  };

  const edit = async (m: Message, text: string) => {
    if (!conversationId) return;
    const thread = currentThread();
    const idx = thread.findIndex((x) => x.id === m.id);
    const after = thread.slice(idx + 1).map((x) => x.id);
    await editUserMessage(uid, conversationId, m.id, text);
    await deleteMessages(uid, conversationId, after.filter((id) => storedIds.has(id))).catch(() => undefined);
    after.forEach((id) => clearLiveReply(conversationId, id));
    runGeneration(conversationId, [...thread.slice(0, idx), { ...m, content: text }]);
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
    onRegenerate: (m) => void regenerate(m),
    onApprovePaid: (m, model) => void regenerate(m, model),
    onEdit: edit,
    onRetry: retry,
    onDelete: (m) => conversationId && deleteMessages(uid, conversationId, [m.id]).catch(() => toast('Could not delete.', 'error')),
    onToggleSave: (m, s) => conv && toggleSavedResponse(uid, conv, m, s).catch(() => toast('Could not update bookmark.', 'error')),
    onQuickAction: quickAction,
    // the same description again, as a new message (one at a time: send() ignores repeats)
    onGenerateAnother: (prompt) => void send(prompt, []),
  };

  /** Upload one file into the composer of `cid` (undefined: the new chat). Each file is uploaded once. */
  const uploadOne = async (f: File, cid: string | undefined, uploadId: string) => {
    const key = cid ?? 'new';
    setUploads((u) => [...u.filter((x) => x.id !== uploadId), { id: uploadId, key, name: f.name, status: 'uploading' }]);
    try {
      const id = await uploadDocument(uid, f);
      files.current.set(id, f);
      if (cid) {
        await attachDocument(uid, cid, id, true);
        setTray((t) => ({ ...t, [cid]: [...(t[cid] ?? []), id] }));
      } else setDraftDocs((d) => [...d, id]);
      setUploads((u) => u.filter((x) => x.id !== uploadId));
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Upload failed.';
      // keep the file for Retry
      files.current.set(uploadId, f);
      setUploads((u) => u.map((x) => (x.id === uploadId ? { ...x, status: 'failed', error } : x)));
    }
  };
  const uploadDocs = async (list: File[]) => {
    for (const f of list) await uploadOne(f, conversationId, newId());
  };
  const retryUpload = (uploadId: string) => {
    const u = uploads.find((x) => x.id === uploadId);
    const f = files.current.get(uploadId);
    // one upload at a time per file: a second tap while it runs does nothing
    if (!u || u.status === 'uploading' || !f) return;
    files.current.delete(uploadId);
    void uploadOne(f, u.key === 'new' ? undefined : u.key, uploadId);
  };
  const dismissUpload = (uploadId: string) => {
    files.current.delete(uploadId);
    setUploads((u) => u.filter((x) => x.id !== uploadId));
  };
  /** A document that could not be read: upload the same file again in its place. */
  const retryDocument = (id: string) => {
    const f = files.current.get(id);
    if (!f) return;
    files.current.delete(id);
    removeDoc(id);
    void uploadOne(f, conversationId, newId());
  };
  const canRetryDocument = (id: string) => files.current.has(id);
  /** Stop searching a document this conversation was given earlier. */
  const detachChatDoc = (id: string) => {
    if (conversationId) attachDocument(uid, conversationId, id, false).catch(() => toast('Could not remove the document.', 'error'));
  };
  const removeDoc = (id: string) => {
    if (conversationId) {
      const cid = conversationId;
      attachDocument(uid, cid, id, false).catch(() => undefined);
      setTray((t) => ({ ...t, [cid]: (t[cid] ?? []).filter((x) => x !== id) }));
    } else setDraftDocs((d) => d.filter((x) => x !== id));
    if (docParam === id) {
      params.delete('doc');
      setParams(params, { replace: true });
    }
  };
  const pickDoc = (id: string) => {
    if (conversationId) {
      const cid = conversationId;
      attachDocument(uid, cid, id, true)
        .then(() => setTray((t) => ({ ...t, [cid]: (t[cid] ?? []).includes(id) ? t[cid] : [...(t[cid] ?? []), id] })))
        .catch(() => toast('Could not attach the document.', 'error'));
    } else setDraftDocs((d) => (d.includes(id) ? d : [...d, id]));
  };

  const notFound = conversationId && !convState.loading && !convState.exists;
  const showWelcome = !conversationId || (!messagesState.loading && messages.length === 0 && !liveReplies.length);
  const threadOrder = [...messages.map((m) => ({ id: m.id, role: m.role })), ...unsavedReplies.map((r) => ({ id: r.id, role: 'assistant' as const }))];
  const lastAssistantId = [...threadOrder].reverse().find((m) => m.role === 'assistant')?.id;
  // the last message is the user's and no reply is on its way (e.g. the browser closed before it was sent)
  const missingReply = Boolean(conversationId && !messagesState.loading && threadOrder.at(-1)?.role === 'user' && !generating && !sending);

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
              { label: 'Export as Markdown', icon: <Download className="size-4" />, onSelect: () => void exportAll(exportMarkdown) },
              { label: 'Export as text', icon: <Download className="size-4" />, onSelect: () => void exportAll(exportText) },
              { label: 'Export as PDF', icon: <Download className="size-4" />, onSelect: () => void exportAll(exportPdf) },
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
      <div ref={scroller} onScroll={onScroll} className="scroll-thin touch-scroll relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        {notFound ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="text-sm text-muted">This conversation doesn’t exist or was deleted.</p>
            <Button variant="primary" onClick={() => navigate('/')}>
              Start a new chat
            </Button>
          </div>
        ) : showWelcome ? (
          <Welcome projectName={project?.name} />
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
              {messages.map((m) => {
                if (m.role === 'user') return <UserMessage key={m.id} m={m} actions={actions} canEdit={!generating} delivery={m.id === sendingMsg ? 'sending' : 'sent'} />;
                const r = liveById.get(m.id);
                return (
                  <AssistantMessage
                    key={m.id}
                    m={r ? { ...m, content: r.content } : withInterruption(m)}
                    live={r}
                    isLast={m.id === lastAssistantId}
                    saved={savedIds.has(m.id)}
                    actions={actions}
                    busy={generating}
                  />
                );
              })}
              {unsavedReplies.map((r) => (
                <AssistantMessage
                  key={r.id}
                  m={{ id: r.id, role: 'assistant', content: r.content }}
                  live={r}
                  isLast={r.id === lastAssistantId}
                  saved={false}
                  actions={actions}
                  busy={generating}
                />
              ))}
              {sending && <p className="animate-pulse text-right text-xs text-subtle">Sending…</p>}
              {missingReply && (
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
                  <span>No response was saved for this message.</span>
                  <Button size="sm" variant="outline" onClick={generateMissing} disabled={!online}>
                    Generate response
                  </Button>
                </div>
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
        {!notFound && <UsageIndicator focus={deepResearch ? 'research' : docIds.length ? 'documents' : undefined} />}
        {!notFound && (
          <Composer
            key={`${convKey}:${restore?.key === convKey ? restore.seq : 0}`}
            initialText={restore?.key === convKey ? restore.text : undefined}
            initialImages={restore?.key === convKey ? restore.images : undefined}
            sending={Boolean(sendingMsg)}
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
                ? 'Web search is on: informational messages are searched (greetings and similar are not)'
                : settings.searchMode === 'manual' || settings.autoSearch === false
                  ? 'Search is off unless you ask. Tap to search the web for your messages.'
                  : 'Auto: searches only when a message needs current information. Tap to always search.'
            }
            deepResearch={deepResearch}
            onDeepResearch={setDeepResearch}
            documents={pendingDocs}
            uploads={visibleUploads}
            onRetryUpload={retryUpload}
            onDismissUpload={dismissUpload}
            onRetryDocument={retryDocument}
            canRetryDocument={canRetryDocument}
            chatDocuments={chatDocs}
            onDetachChatDocument={detachChatDoc}
            onUploadDocuments={uploadDocs}
            onRemoveDocument={removeDoc}
            onPickFromLibrary={() => setLibraryOpen(true)}
            sendOnEnter={settings.sendOnEnter}
            autoFocus={!conversationId}
            placeholder={project ? `Message Atlas AI in ${project.name}` : undefined}
            onStartVoice={() => {
              unlockAudio();
              primeVoiceAudio();
              setVoiceOpen(true);
            }}
          />
        )}
        <VoiceMode
          open={voiceOpen}
          onClose={() => setVoiceOpen(false)}
          onSend={sendSpoken}
          onStop={() => conversationId && stopGeneration(conversationId)}
          live={live}
        />
        <p className="mx-auto mt-1.5 hidden max-w-3xl px-4 text-center text-[11px] text-subtle sm:block">
          Atlas AI can make mistakes. Verify important information.
        </p>
      </div>

      <LibraryPicker open={libraryOpen} onClose={() => setLibraryOpen(false)} selected={conversationId ? docIds : draftDocs} onPick={pickDoc} />

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
