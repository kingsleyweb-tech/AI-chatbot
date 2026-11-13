/**
 * Atlas AI API developer pages (public): /developers (reference) and /developers/sandbox.
 *
 * Everything here describes server behaviour defined in server/apiPlatform; values such as the
 * profiles, permissions and hard ceilings are read from the shared module, so the page cannot
 * drift from what the server enforces. The sandbox calls the real API from this browser with a key
 * the developer pastes in; the key is kept in memory only (never stored, never sent anywhere else).
 */
import { ArrowRight, Check, Copy, FlaskConical, KeyRound, Play, Square } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import {
  API_PERMISSIONS,
  API_VERSION,
  HARD_CEILINGS,
  LIMIT_INFO,
  LIMIT_KEYS,
  PERMISSION_INFO,
  PROFILE_LABEL,
  PROFILE_LIMITS,
  type ApiPermission,
} from '../../../../server/shared/apiPlatform';
import { Container, PageHero } from '../layout/ui';

/** The public address developers use: the docs and code samples always show it. */
const PRODUCTION = 'https://chatatlasai.vercel.app';
const baseUrl = () => `${PRODUCTION}/api/${API_VERSION}`;
/** Where this page is served from: the sandbox sends its requests here (same site, so a local copy tests the local API). */
const origin = () => (typeof window === 'undefined' ? PRODUCTION : window.location.origin);
const sandboxBase = () => `${origin()}/api/${API_VERSION}`;
const home = { label: 'Home', href: '/' };

function useTitle(title: string) {
  useEffect(() => {
    const prev = document.title;
    document.title = title;
    return () => {
      document.title = prev;
    };
  }, [title]);
}

/* ------------------------------------------------------------------ building blocks */

function CopyBtn({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label="Copy"
      className="rounded-md p-1.5 text-white/70 hover:bg-white/10 hover:text-white"
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        })
      }
    >
      {done ? <Check className="size-4" /> : <Copy className="size-4" />}
    </button>
  );
}

function Code({ children, lang, title }: { children: string; lang?: string; title?: string }) {
  return (
    <div className="my-4 overflow-hidden rounded-xl border border-border bg-[#0d1117] text-[13px] text-[#e6edf3]">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-1.5 text-[11px] text-white/60">
        <span>{title ?? lang ?? 'code'}</span>
        <CopyBtn text={children} />
      </div>
      <pre className="overflow-x-auto p-4 leading-relaxed">
        <code>{children}</code>
      </pre>
    </div>
  );
}

/** Code in several languages, one tab each. */
function Tabs({ items }: { items: { label: string; code: string }[] }) {
  const [i, setI] = useState(0);
  return (
    <div className="my-4">
      <div className="flex gap-1">
        {items.map((it, n) => (
          <button
            key={it.label}
            type="button"
            onClick={() => setI(n)}
            className={cn('rounded-t-lg px-3 py-1.5 text-xs font-medium', n === i ? 'bg-[#0d1117] text-white' : 'text-muted hover:text-fg')}
          >
            {it.label}
          </button>
        ))}
      </div>
      <div className="-mt-4">
        <Code title={items[i].label}>{items[i].code}</Code>
      </div>
    </div>
  );
}

function H2({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2 id={id} className="t-h3 mt-16 scroll-mt-24 border-t border-border pt-10 first:mt-0 first:border-0 first:pt-0">
      {children}
    </h2>
  );
}
function P({ children }: { children: ReactNode }) {
  return <p className="mt-3 text-[15px] leading-relaxed text-muted">{children}</p>;
}
function C({ children }: { children: ReactNode }) {
  return <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-[13px] text-fg">{children}</code>;
}
function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="my-4 overflow-x-auto rounded-xl border border-border">
      <table className="w-full min-w-[560px] text-left text-[13px]">
        <thead className="bg-surface text-xs text-muted">
          <tr>
            {head.map((h) => (
              <th key={h} className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-border align-top">
              {r.map((c, j) => (
                <td key={j} className="px-3 py-2">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function Note({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' }) {
  return (
    <div
      className={cn(
        'my-4 rounded-xl border p-4 text-[14px] leading-relaxed',
        tone === 'warn' ? 'border-amber-300/60 bg-amber-50 text-amber-950 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-100' : 'border-border bg-surface',
      )}
    >
      {children}
    </div>
  );
}
const Method = ({ m }: { m: string }) => (
  <span
    className={cn(
      'inline-block rounded px-1.5 py-0.5 font-mono text-[11px] font-bold',
      m === 'GET' && 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
      m === 'POST' && 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
      m === 'DELETE' && 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
    )}
  >
    {m}
  </span>
);

/* ------------------------------------------------------------------ reference data */

interface Field {
  name: string;
  type: string;
  required?: boolean;
  desc: ReactNode;
}
interface Endpoint {
  id: string;
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  title: string;
  permission: string;
  desc: ReactNode;
  query?: Field[];
  body?: Field[];
  /** example request body (JSON) */
  example?: unknown;
  /** raw body example instead of JSON (audio) */
  raw?: string;
  response: unknown;
  stream?: boolean;
  binary?: string;
  /** sandbox preset id */
  preset?: string;
}

const CHAT_FIELDS: Field[] = [
  { name: 'message', type: 'string', required: true, desc: 'The user’s message (1 character up to the application’s input limit).' },
  { name: 'conversation_id', type: 'string', desc: <>Continue a conversation (<C>conv_…</C>). Omit it to start a new one; the new id is returned.</> },
  { name: 'model', type: 'string', desc: <><C>"auto"</C> (default) or a model id from <C>GET /models</C>. Choosing a model needs the <C>models</C> permission.</> },
  { name: 'stream', type: 'boolean', desc: <>Stream the reply as Server-Sent Events (needs <C>chat_stream</C> and streaming enabled for the application).</> },
  { name: 'web_search', type: '"off" | "auto" | "on"', desc: <>Web search for this turn. Default <C>auto</C> when the application has <C>research</C>, else <C>off</C>. <C>on</C> always searches and uses one research unit.</> },
  { name: 'deep_research', type: 'boolean', desc: <>Multi-step Deep Research report (needs <C>deep_research</C>; uses one deep-research unit).</> },
  { name: 'memory', type: 'boolean', desc: <>Use and update the end user’s memory (default: on when the application has <C>memory</C>).</> },
  { name: 'document_ids', type: 'string[]', desc: <>Up to 10 uploaded documents (<C>doc_…</C>) to answer from (needs <C>documents</C>).</> },
  { name: 'images', type: '{ data_url, name? }[]', desc: 'Up to 4 images (PNG, JPEG, WebP or GIF data URLs, about 1 MB each) for vision models.' },
  { name: 'include_reasoning', type: 'boolean', desc: <>Return the model’s reasoning text when available (needs <C>reasoning</C>).</> },
  { name: 'title', type: 'string', desc: 'Title for a new conversation (max 80 characters).' },
];

const CHAT_RESPONSE = {
  success: true,
  request_id: 'req_3f9a1c2b7d4e5f60a1b2c3d4',
  api_version: 'v1',
  app_id: 'int_7e8f9a0b1c2d3e4f',
  conversation_id: 'conv_9b8a7c6d5e4f3a21',
  data: {
    conversation_id: 'conv_9b8a7c6d5e4f3a21',
    message_id: 'msg_1a2b3c4d5e6f7a8b',
    model: 'gemini:gemini-2.5-flash',
    content: 'Accra is the capital of Ghana…',
    sources: [{ index: 1, title: 'Accra – Wikipedia', url: 'https://en.wikipedia.org/wiki/Accra', site: 'wikipedia.org' }],
    images: [],
    notices: [],
    finish_reason: 'stop',
    error: null,
  },
  usage: { tokens: { prompt_tokens: 412, completion_tokens: 96, total_tokens: 508 } },
  error: null,
  rate_limit: { limit: 60, remaining: 58, reset: 1763035260, window: 'minute' },
};

const ENDPOINTS: Endpoint[] = [
  {
    id: 'get-app',
    method: 'GET',
    path: '/app',
    title: 'Your application',
    permission: 'none',
    preset: 'app',
    desc: 'Who the key belongs to: the application, its permissions, limits, environment and the key’s own settings. Use it to check a key. It never returns the key, its hash or other applications.',
    response: {
      app_id: 'int_7e8f9a0b1c2d3e4f',
      name: 'Atlas Messenger API',
      app_name: 'Atlas Messenger',
      app_type: 'mobile',
      status: 'active',
      permissions: ['chat', 'chat_stream', 'models'],
      profile: 'standard',
      limits: { requestsPerMinute: 60, requestsPerDay: 2000, maxInputChars: 20000, streaming: true, '…': '…' },
      key: { id: 'key_1a2b3c4d5e6f7a8b', mode: 'live', display: 'atlas_live_1a2b…x9Q', limits: null, expires_at: null },
      expires_at: null,
      api_version: 'v1',
    },
  },
  {
    id: 'get-models',
    method: 'GET',
    path: '/models',
    title: 'List models',
    permission: 'chat',
    preset: 'models',
    desc: <>The free models this application may use. <C>auto_model</C> is what <C>"auto"</C> currently uses; <C>selectable</C> says whether you may pass <C>model</C> (the <C>models</C> permission). Paid models are never offered.</>,
    response: {
      default: 'auto',
      auto_model: 'gemini:gemini-2.5-flash',
      selectable: true,
      models: [{ id: 'gemini:gemini-2.5-flash', name: 'Gemini 2.5 Flash', vendor: 'google', context_length: 1048576, vision: true, reasoning: true }],
    },
  },
  {
    id: 'post-chat',
    method: 'POST',
    path: '/chat',
    title: 'Chat',
    permission: 'chat (+ chat_stream, models, research, deep_research, documents, memory, reasoning per option)',
    preset: 'chat',
    desc: 'Send a message and get Atlas AI’s reply. Conversations, history, memory, web search with sources, documents and images work exactly as in Atlas AI. Without conversation_id a new conversation is created.',
    body: CHAT_FIELDS,
    example: { message: 'What is the capital of Ghana?', web_search: 'auto' },
    response: CHAT_RESPONSE,
  },
  {
    id: 'post-chat-stream',
    method: 'POST',
    path: '/chat (stream: true)',
    title: 'Chat (streaming)',
    permission: 'chat + chat_stream',
    preset: 'chat_stream',
    stream: true,
    desc: <>The same request with <C>"stream": true</C>. The response is <C>text/event-stream</C>; each event is sent the moment it is produced. See <a href="#streaming" className="underline">Streaming</a> for every event type.</>,
    example: { message: 'Write a haiku about Kumasi', stream: true },
    response: 'event: meta\ndata: {"request_id":"req_…","api_version":"v1","app_id":"int_…","conversation_id":"conv_…","message_id":"msg_…","rate_limit":{…}}\n\nevent: start\ndata: {"conversation_id":"conv_…","message_id":"msg_…","model":"gemini:gemini-2.5-flash"}\n\nevent: delta\ndata: {"text":"Red earth, "}\n\nevent: delta\ndata: {"text":"golden stools…"}\n\nevent: usage\ndata: {"prompt_tokens":120,"completion_tokens":24,"total_tokens":144}\n\nevent: done\ndata: {"finish_reason":"stop","model":"gemini:gemini-2.5-flash","saved":null}',
  },
  {
    id: 'get-conversations',
    method: 'GET',
    path: '/conversations',
    title: 'List conversations',
    permission: 'conversations_read',
    preset: 'conversations',
    desc: 'The end user’s conversations in this application (newest first, up to 200).',
    response: { conversations: [{ id: 'conv_9b8a7c6d5e4f3a21', title: 'Capital of Ghana', message_count: 2, created_at: '2026-11-13T09:00:00.000Z', updated_at: '2026-11-13T09:00:04.000Z' }] },
  },
  {
    id: 'post-conversations',
    method: 'POST',
    path: '/conversations',
    title: 'Create a conversation',
    permission: 'chat',
    desc: 'Create an empty conversation (optional; POST /chat creates one automatically). Returns 201.',
    body: [{ name: 'title', type: 'string', desc: 'Title (max 80 characters). Default "New chat".' }],
    example: { title: 'Trip planning' },
    response: { conversation: { id: 'conv_…', title: 'Trip planning', message_count: 0 } },
  },
  {
    id: 'get-conversation',
    method: 'GET',
    path: '/conversations/{id}',
    title: 'Get a conversation with messages',
    permission: 'conversations_read',
    desc: 'One conversation and its messages, oldest first. Another application’s or another end user’s conversation answers 404.',
    query: [{ name: 'limit', type: 'number', desc: 'Messages to return, 1-200 (default 100, the most recent).' }],
    response: {
      conversation: { id: 'conv_…', title: 'Capital of Ghana', message_count: 2 },
      messages: [
        { id: 'msg_…', role: 'user', content: 'What is the capital of Ghana?', status: 'complete', model: null, sources: [], images: [], created_at: '2026-11-13T09:00:00.000Z' },
        { id: 'msg_…', role: 'assistant', content: 'Accra…', status: 'complete', model: 'gemini:gemini-2.5-flash', sources: [], images: [], created_at: '2026-11-13T09:00:01.000Z' },
      ],
    },
  },
  {
    id: 'delete-conversation',
    method: 'DELETE',
    path: '/conversations/{id}',
    title: 'Delete a conversation',
    permission: 'conversations_delete',
    desc: 'Deletes the conversation, its messages, images and the memories learned from it.',
    response: { deleted: true, id: 'conv_…', removed: { messages: 2 } },
  },
  {
    id: 'post-images',
    method: 'POST',
    path: '/images',
    title: 'Create or edit an image',
    permission: 'images',
    preset: 'images',
    desc: 'Generate a picture from a prompt, or edit one you send. Uses one image unit (given back if generation fails). Returns 201 with the image inline as a data URL.',
    body: [
      { name: 'prompt', type: 'string', required: true, desc: '3-2000 characters describing the picture or the edit.' },
      { name: 'image', type: 'string', desc: 'A PNG, JPEG or WebP data URL to edit (about 1 MB max). Omit it to create a new picture.' },
    ],
    example: { prompt: 'a small lighthouse on a cliff at sunset, watercolour' },
    response: { image: { id: 'img_…', kind: 'generate', mime: 'image/png', width: 1024, height: 1024, stored: true, data_url: 'data:image/png;base64,iVBORw0KGgo…' }, model: '@cf/black-forest-labs/flux-1-schnell' },
  },
  {
    id: 'post-research',
    method: 'POST',
    path: '/research',
    title: 'Web search and research',
    permission: 'research (deep: + deep_research)',
    preset: 'research_search',
    desc: <><C>search</C> returns sources only. <C>answer</C> (default) returns a written answer with numbered sources, like <C>/chat</C> with web search on. <C>deep</C> runs Deep Research. <C>answer</C> and <C>deep</C> can stream.</>,
    body: [
      { name: 'query', type: 'string', required: true, desc: '2-2000 characters.' },
      { name: 'mode', type: '"search" | "answer" | "deep"', desc: 'Default "answer".' },
      { name: 'stream', type: 'boolean', desc: 'Stream answer/deep as SSE (needs chat_stream).' },
      { name: 'conversation_id', type: 'string', desc: 'Keep the research in a conversation.' },
    ],
    example: { query: 'latest news about Ghana’s economy', mode: 'search' },
    response: { query: 'latest news about Ghana’s economy', provider: 'tavily', status: 'ok', sources: [{ index: 1, title: '…', url: 'https://…', snippet: '…', site: 'example.com' }] },
  },
  {
    id: 'post-documents',
    method: 'POST',
    path: '/documents',
    title: 'Upload a document',
    permission: 'documents',
    preset: 'documents_upload',
    desc: <>Index a document so chat can answer from it. Send extracted text (<C>text</C> or <C>sections</C>), or a plain-text file as <C>content_base64</C>. PDF, DOCX, XLSX and PPTX must be converted to text by your application (415 otherwise). Returns 201.</>,
    body: [
      { name: 'name', type: 'string', required: true, desc: 'File name, 1-300 characters.' },
      { name: 'mime', type: 'string', desc: 'Content type, default text/plain.' },
      { name: 'text', type: 'string', desc: 'The document’s text.' },
      { name: 'sections', type: '{ ref, text }[]', desc: 'Text in parts with a location label ("p. 3", "Sheet1") used in citations.' },
      { name: 'content_base64', type: 'string', desc: 'A base64 text file (txt, md, csv, json, html, xml).' },
    ],
    example: { name: 'menu.txt', text: 'Jollof rice – GHS 45\nWaakye – GHS 30\nKelewele – GHS 20' },
    response: { document: { id: 'doc_4c5d6e7f8a9b0c1d', name: 'menu.txt', status: 'ready', chunk_count: 1, char_count: 58, searchable: true } },
  },
  { id: 'get-documents', method: 'GET', path: '/documents', title: 'List documents', permission: 'documents', preset: 'documents', desc: 'The end user’s documents in this application.', response: { documents: [{ id: 'doc_…', name: 'menu.txt', mime: 'text/plain', status: 'ready', chunk_count: 1, char_count: 58, created_at: '…' }] } },
  { id: 'get-document', method: 'GET', path: '/documents/{id}', title: 'Get a document', permission: 'documents', desc: 'One document’s details (not its text).', response: { document: { id: 'doc_…', name: 'menu.txt', status: 'ready' } } },
  { id: 'delete-document', method: 'DELETE', path: '/documents/{id}', title: 'Delete a document', permission: 'documents', desc: 'Deletes the document and its index.', response: { deleted: true, id: 'doc_…' } },
  {
    id: 'post-document-analyze',
    method: 'POST',
    path: '/documents/{id}/analyze',
    title: 'Summarise, analyse or ask a document',
    permission: 'documents',
    desc: 'Runs a chat turn answered from that document. The response has the same shape as POST /chat (and can stream).',
    body: [
      { name: 'task', type: '"summarize" | "analyze" | "question"', desc: 'Default "summarize", or "question" when question is given.' },
      { name: 'question', type: 'string', desc: 'The question, or a focus for summarize/analyze.' },
      { name: 'stream', type: 'boolean', desc: 'Stream as SSE.' },
      { name: 'conversation_id', type: 'string', desc: 'Keep it in a conversation.' },
      { name: 'model', type: 'string', desc: 'As in /chat.' },
    ],
    example: { task: 'question', question: 'What is the cheapest dish?' },
    response: { '…': 'same as POST /chat' },
  },
  {
    id: 'post-speech',
    method: 'POST',
    path: '/voice/speech',
    title: 'Text to speech',
    permission: 'voice_tts',
    preset: 'voice_speech',
    binary: 'audio/mpeg',
    desc: <>Returns MP3 audio (not JSON). Default voice: Atlas AI’s natural voice; <C>provider: "elevenlabs"</C> uses ElevenLabs (shared credit caps apply). Counts characters against the daily TTS limit.</>,
    body: [
      { name: 'text', type: 'string', required: true, desc: 'The text to speak (long text is cut to the per-request maximum).' },
      { name: 'provider', type: '"cloudflare" | "elevenlabs"', desc: 'Default cloudflare.' },
      { name: 'voice_id', type: 'string', desc: 'An ElevenLabs voice id.' },
    ],
    example: { text: 'Akwaaba! Welcome to Atlas AI.' },
    response: '(binary) Content-Type: audio/mpeg',
  },
  {
    id: 'post-transcriptions',
    method: 'POST',
    path: '/voice/transcriptions',
    title: 'Speech to text',
    permission: 'voice_stt',
    raw: '<audio bytes>',
    desc: <>Send the recording itself as the request body with its audio content type (MP3, M4A, WAV, OGG, WebM or FLAC), up to about 2 minutes / 4 MB. <C>Idempotency-Key</C> is not supported here.</>,
    response: { text: 'Good morning, what’s the weather in Accra?', language: 'en', duration: 3.2 },
  },
  { id: 'get-memory', method: 'GET', path: '/memory', title: 'List memories', permission: 'memory', preset: 'memory', desc: 'What Atlas AI remembers about the end user in this application.', response: { memories: [{ id: 'mem_…', text: 'Prefers answers in short bullet points', category: 'preference', active: true, origin: 'auto', source_conversation_id: 'conv_…' }] } },
  { id: 'delete-memory', method: 'DELETE', path: '/memory/{id}', title: 'Delete one memory', permission: 'memory', desc: 'Forget one memory.', response: { deleted: 1 } },
  { id: 'delete-memories', method: 'DELETE', path: '/memory', title: 'Delete all memories', permission: 'memory', desc: 'Forget everything about the end user (in this application).', response: { deleted: 12 } },
];

const ERRORS: [number, string, string][] = [
  [400, 'bad_request', 'The body is not valid JSON or a field is wrong. `error.details` lists the problems.'],
  [400, 'invalid_user', 'X-Atlas-User is not 1-128 characters of letters, digits and . _ : @ -'],
  [400, 'invalid_idempotency_key', 'Idempotency-Key is not 8-128 characters of letters, digits and . _ : -'],
  [400, 'model_unavailable', 'The model does not exist, is not free or is unavailable. Use "auto".'],
  [401, 'missing_api_key', 'No key was sent.'],
  [401, 'invalid_api_key', 'The key is wrong, deleted, or a live key was sent as test (or the reverse).'],
  [401, 'key_revoked', 'The key was revoked (for example after rotation). Use the new key.'],
  [401, 'key_expired', 'The key has passed its expiry date.'],
  [403, 'key_disabled', 'The key is temporarily disabled by the administrator.'],
  [403, 'integration_suspended', 'The application’s API access is suspended.'],
  [403, 'integration_disabled', 'The application’s API access is disabled.'],
  [403, 'integration_expired', 'The application’s access has expired.'],
  [403, 'permission_denied', 'The application lacks a permission; `error.details.permission` names it.'],
  [403, 'model_not_allowed', 'The model is not in the application’s allowed list.'],
  [403, 'streaming_not_allowed', 'Streaming is switched off for the application.'],
  [403, 'origin_not_allowed', 'A browser request from a website that is not on the allowed list.'],
  [404, 'not_found', 'Unknown endpoint, or a conversation/document/memory that does not exist for this end user and application.'],
  [409, 'idempotency_in_progress', 'A request with the same Idempotency-Key is still running.'],
  [409, 'document_not_ready', 'The document is still being indexed.'],
  [413, 'input_too_large', 'The message is longer than the application’s input limit (`details.limit`).'],
  [413, 'document_too_large', 'The document is larger than the application’s document limit.'],
  [413, 'payload_too_large', 'The request body is too large.'],
  [415, 'unsupported_document', 'A binary document (PDF, DOCX, …) sent as content_base64. Send extracted text.'],
  [415, 'unsupported_audio', 'Transcription body without an audio content type.'],
  [422, 'idempotency_mismatch', 'The Idempotency-Key was already used for a different request.'],
  [422, 'no_text', 'The document contains no text.'],
  [429, 'rate_limited', 'A request limit was reached (minute, hour, day, week or month). Wait `Retry-After` seconds.'],
  [429, 'feature_limit', 'A daily feature quota (images, research, documents, voice) is used up. Resets 00:00 UTC.'],
  [429, 'concurrency_limit', 'Too many requests running at once. Retry after the others finish.'],
  [429, 'too_many_auth_failures', 'Too many failed key attempts from your address. Wait a minute.'],
  [502, 'provider_error', 'The AI provider failed. Safe to retry.'],
  [503, 'provider_capacity', 'The free AI capacity is used up for now. Retry later.'],
  [503, 'environment_not_permitted', 'The application is not allowed in the environment Atlas AI is currently using.'],
  [503, 'search_unavailable / images_unavailable / speech_unavailable', 'That service is temporarily unavailable.'],
  [500, 'internal_error', 'Unexpected error. Quote request_id when reporting it.'],
];

const STREAM_EVENTS: [string, string, string][] = [
  ['meta', '{ request_id, api_version, app_id, conversation_id, message_id, rate_limit }', 'Always first. Save conversation_id for follow-ups.'],
  ['start', '{ conversation_id, message_id, model }', 'The model that is answering.'],
  ['delta', '{ text }', 'The next piece of the reply. Append it.'],
  ['reasoning', '{ text }', 'Reasoning text (only with include_reasoning and the reasoning permission).'],
  ['sources', '{ sources: [{ index, title, url, site? }] }', 'Web sources; [1], [2] in the text refer to index.'],
  ['research', '{ step }', 'Deep Research progress (searching, reading, writing).'],
  ['notice', '{ message }', 'Something the user should know (for example a model fallback).'],
  ['image', '{ id, mime, width, height, data_url }', 'A picture created during the reply.'],
  ['usage', '{ prompt_tokens, completion_tokens, total_tokens }', 'Token counts when the provider reports them.'],
  ['error', '{ code, message, retryable }', 'The reply failed part-way. Text already received stays valid.'],
  ['done', '{ finish_reason, model, saved }', 'Always last on success. Close the stream.'],
];

/* ----------------------------------------------------------------- code samples */

const curl = (method: string, path: string, body?: unknown, extra = '') =>
  [`curl ${method === 'GET' ? '' : `-X ${method} `}"${baseUrl()}${path}" \\`, `  -H "Authorization: Bearer $ATLAS_API_KEY" \\`, `  -H "X-Atlas-User: user_123"${body !== undefined ? ' \\' : extra ? ' \\' : ''}`]
    .concat(body !== undefined ? [`  -H "Content-Type: application/json" \\`, `  -d '${JSON.stringify(body)}'${extra ? ' \\' : ''}`] : [])
    .concat(extra ? [`  ${extra}`] : [])
    .join('\n');

const node = () => `// Node.js 18+ (server side). Keep the key in an environment variable.
const BASE = "${baseUrl()}";

async function atlas(path, { method = "POST", body, user = "user_123" } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: \`Bearer \${process.env.ATLAS_API_KEY}\`,
      "X-Atlas-User": user,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!json.success) throw Object.assign(new Error(json.error.message), { status: res.status, code: json.error.code, requestId: json.request_id });
  return json;
}

const first = await atlas("/chat", { body: { message: "What is the capital of Ghana?" } });
console.log(first.data.content);

// continue the same conversation
const next = await atlas("/chat", { body: { message: "And its population?", conversation_id: first.conversation_id } });
console.log(next.data.content);`;

const python = () => `# Python 3 with requests (server side)
import os, requests

BASE = "${baseUrl()}"
HEADERS = {"Authorization": f"Bearer {os.environ['ATLAS_API_KEY']}", "X-Atlas-User": "user_123"}

r = requests.post(f"{BASE}/chat", json={"message": "What is the capital of Ghana?"}, headers=HEADERS, timeout=60)
body = r.json()
if not body["success"]:
    raise RuntimeError(f"{r.status_code} {body['error']['code']}: {body['error']['message']} ({body['request_id']})")
print(body["data"]["content"])
conversation_id = body["conversation_id"]`;

const streamJs = () => `// Read a streamed reply (Node 18+ or a browser on an allowed origin)
const res = await fetch("${baseUrl()}/chat", {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${process.env.ATLAS_API_KEY}\`,
    "X-Atlas-User": "user_123",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ message: "Tell me a short story", stream: true }),
});
if (!res.ok) throw new Error((await res.json()).error.message); // errors before streaming are JSON

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let i;
  while ((i = buffer.indexOf("\\n\\n")) >= 0) {
    const block = buffer.slice(0, i);
    buffer = buffer.slice(i + 2);
    const event = /^event: (.+)$/m.exec(block)?.[1];
    const data = JSON.parse(/^data: (.+)$/m.exec(block)?.[1] ?? "null");
    if (event === "delta") process.stdout.write(data.text);
    if (event === "error") console.error("\\n[error]", data.code, data.message);
    if (event === "done") console.log("\\n[done]", data.finish_reason);
  }
}`;

const pythonStream = () => `# Python streaming with requests
import json, os, requests

r = requests.post(
    "${baseUrl()}/chat",
    json={"message": "Tell me a short story", "stream": True},
    headers={"Authorization": f"Bearer {os.environ['ATLAS_API_KEY']}", "X-Atlas-User": "user_123"},
    stream=True, timeout=120,
)
event = None
for line in r.iter_lines(decode_unicode=True):
    if line.startswith("event: "):
        event = line[7:]
    elif line.startswith("data: "):
        data = json.loads(line[6:])
        if event == "delta":
            print(data["text"], end="", flush=True)
        elif event == "done":
            print()`;

/* ---------------------------------------------------------------------- docs page */

const NAV: { id: string; label: string; children?: { id: string; label: string }[] }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'base-url', label: 'Base URL & versioning' },
  { id: 'quickstart', label: 'Quickstart' },
  { id: 'authentication', label: 'Authentication' },
  { id: 'end-users', label: 'End users & isolation' },
  { id: 'requests', label: 'Request format' },
  { id: 'responses', label: 'Response format' },
  { id: 'errors', label: 'Errors' },
  { id: 'rate-limits', label: 'Rate limits & quotas' },
  { id: 'idempotency', label: 'Idempotency' },
  { id: 'streaming', label: 'Streaming (SSE)' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'environments', label: 'Environments' },
  { id: 'endpoints', label: 'Endpoint reference', children: ENDPOINTS.map((e) => ({ id: e.id, label: `${e.method} ${e.path}` })) },
  { id: 'cors', label: 'Browsers & CORS' },
  { id: 'best-practices', label: 'Best practices' },
  { id: 'limitations', label: 'Limitations' },
  { id: 'changelog', label: 'Changelog' },
];

function SideNav() {
  return (
    <nav aria-label="API documentation" className="sticky top-24 hidden max-h-[calc(100vh-7rem)] overflow-y-auto pr-2 text-[13px] lg:block">
      <Link to="/developers/sandbox" className="btn btn-teal btn-sm mb-4 w-full justify-center">
        <FlaskConical className="size-4" aria-hidden="true" /> Open the sandbox
      </Link>
      <ul className="space-y-1">
        {NAV.map((n) => (
          <li key={n.id}>
            <a href={`#${n.id}`} className="block rounded px-2 py-1 text-muted hover:bg-surface hover:text-fg">
              {n.label}
            </a>
            {n.children && (
              <ul className="ml-2 border-l border-border pl-2">
                {n.children.map((c) => (
                  <li key={c.id}>
                    <a href={`#${c.id}`} className="block truncate rounded px-2 py-0.5 font-mono text-[11px] text-muted hover:text-fg">
                      {c.label}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}

function FieldTable({ fields, title }: { fields: Field[]; title: string }) {
  return (
    <>
      <div className="mt-4 text-xs font-semibold tracking-wide text-muted uppercase">{title}</div>
      <Table
        head={['Field', 'Type', 'Description']}
        rows={fields.map((f) => [
          <span key="n" className="font-mono">
            {f.name}
            {f.required && <span className="ml-1 text-rose-600">*</span>}
          </span>,
          <span key="t" className="font-mono text-xs text-muted">
            {f.type}
          </span>,
          f.desc,
        ])}
      />
    </>
  );
}

function EndpointDoc({ e }: { e: Endpoint }) {
  const path = e.path.replace(' (stream: true)', '');
  const samplePath = path.replace('{id}', e.path.includes('conversations') ? 'conv_9b8a7c6d5e4f3a21' : e.path.includes('documents') ? 'doc_4c5d6e7f8a9b0c1d' : 'mem_123');
  const extra = e.binary ? '--output speech.mp3' : e.raw ? '--data-binary @recording.mp3' : '';
  const curlCode = e.raw
    ? `curl -X POST "${baseUrl()}${samplePath}" \\\n  -H "Authorization: Bearer $ATLAS_API_KEY" \\\n  -H "X-Atlas-User: user_123" \\\n  -H "Content-Type: audio/mpeg" \\\n  --data-binary @recording.mp3`
    : curl(e.method, samplePath, e.example, extra) + (e.stream ? '' : '');
  return (
    <section id={e.id} className="mt-10 scroll-mt-24 rounded-2xl border border-border p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Method m={e.method} />
        <code className="font-mono text-[14px] font-semibold">{e.path}</code>
        <span className="ml-auto text-xs text-muted">
          Permission: <span className="font-mono">{e.permission}</span>
        </span>
      </div>
      <h3 className="mt-2 text-lg font-semibold">{e.title}</h3>
      <P>{e.desc}</P>
      {e.query && <FieldTable fields={e.query} title="Query parameters" />}
      {e.body && <FieldTable fields={e.body} title="Request body (JSON)" />}
      <Code title="Request (curl)">{curlCode}</Code>
      <Code title={e.stream ? 'Response (text/event-stream)' : e.binary ? 'Response' : 'Response data (inside the envelope)'}>
        {typeof e.response === 'string' ? e.response : JSON.stringify(e.response, null, 2)}
      </Code>
      {e.preset && (
        <Link to={`/developers/sandbox?preset=${e.preset}`} className="btn btn-light btn-sm">
          Try it in the sandbox <ArrowRight className="size-3.5" aria-hidden="true" />
        </Link>
      )}
    </section>
  );
}

export function DevelopersPage() {
  useTitle('Atlas AI API – Developer documentation');
  const base = baseUrl();
  const permRows = (API_PERMISSIONS as readonly ApiPermission[]).map((p) => [<span key="p" className="font-mono">{p}</span>, PERMISSION_INFO[p].label, PERMISSION_INFO[p].explain]);
  const profiles = ['restricted', 'standard', 'premium', 'unlimited'] as const;
  const limitRows = LIMIT_KEYS.map((k) => [
    LIMIT_INFO[k].label,
    ...profiles.map((p) => {
      const v = PROFILE_LIMITS[p][k];
      return v === null ? 'No limit' : v.toLocaleString();
    }),
  ]);

  return (
    <>
      <PageHero
        crumbs={[home, { label: 'Developers' }]}
        eyebrow={`Atlas AI API · ${API_VERSION}`}
        title="Build with Atlas AI."
        lead="One REST API for Atlas AI’s chat, streaming, web research with sources, Deep Research, documents, images, voice and memory. Keys are issued by the Atlas AI administrator for each application."
      >
        <div className="flex flex-wrap gap-3">
          <a href="#quickstart" className="btn btn-dark">
            Quickstart <ArrowRight className="size-4" aria-hidden="true" />
          </a>
          <Link to="/developers/sandbox" className="btn btn-light">
            <FlaskConical className="size-4" aria-hidden="true" /> API sandbox
          </Link>
        </div>
        <div className="mt-6 flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 font-mono text-[13px]">
          <span className="text-muted">Base URL</span>
          <span className="truncate">{base}</span>
        </div>
      </PageHero>

      <Container className="py-12 sm:py-16">
        <div className="grid gap-10 lg:grid-cols-[230px_minmax(0,1fr)]">
          <SideNav />
          <article className="min-w-0 max-w-3xl">
            <H2 id="overview">Overview</H2>
            <P>
              The Atlas AI API gives your application the same intelligence as Atlas AI: model routing with automatic fallback between free models, conversations with history,
              long-term memory, web search with numbered sources, Deep Research, answers from your documents, image creation and editing, text-to-speech and transcription.
            </P>
            <Table
              head={['Property', 'Value']}
              rows={[
                ['Protocol', 'HTTPS, REST, JSON (UTF-8); streaming as Server-Sent Events'],
                ['Base URL', <C key="b">{base}</C>],
                ['Version', <C key="v">{API_VERSION}</C>],
                ['Authentication', <>API key: <C>Authorization: Bearer atlas_live_…</C></>],
                ['Response shape', <>Every JSON response uses one envelope with <C>success</C>, <C>data</C> and <C>error</C></>],
                ['Request IDs', <>Each response has <C>request_id</C> and the <C>X-Request-Id</C> header</>],
                ['Methods', 'GET, POST, DELETE (OPTIONS for browser preflight)'],
                ['Cost to your users', 'Atlas AI uses free model tiers only; no paid model is ever selected'],
              ]}
            />

            <H2 id="base-url">Base URL &amp; versioning</H2>
            <Code title="Base URL">{base}</Code>
            <P>
              Every endpoint path in this reference is relative to the base URL, so <C>GET /models</C> means <C>GET {base}/models</C>. The version is part of the path. Changes inside{' '}
              <C>v1</C> are backwards compatible: new endpoints, new optional fields and new event types may be added, so ignore fields and events you do not know. A breaking change would get
              a new version (<C>/api/v2</C>), with <C>v1</C> kept running during a transition. The <C>Atlas-Api-Version</C> response header and the <C>api_version</C> field always say which
              version answered.
            </P>

            <H2 id="quickstart">Quickstart</H2>
            <ol className="mt-3 list-decimal space-y-2 pl-5 text-[15px] text-muted">
              <li>Get an API key for your application from the Atlas AI administrator (it is shown once; store it as a server secret, e.g. <C>ATLAS_API_KEY</C>).</li>
              <li>
                Check it: <C>GET /app</C> returns your application, permissions and limits.
              </li>
              <li>
                Send a message with <C>POST /chat</C> and keep the returned <C>conversation_id</C> to continue the conversation.
              </li>
            </ol>
            <Tabs
              items={[
                { label: 'curl', code: `export ATLAS_API_KEY="atlas_live_..."\n\n${curl('GET', '/app')}\n\n${curl('POST', '/chat', { message: 'What is the capital of Ghana?' })}` },
                { label: 'Node.js', code: node() },
                { label: 'Python', code: python() },
              ]}
            />

            <H2 id="authentication">Authentication</H2>
            <P>
              Send the key on every request, either as a bearer token (recommended) or in <C>X-Atlas-Key</C>:
            </P>
            <Code title="Headers">{`Authorization: Bearer atlas_live_<key id>_<secret>\n# or\nX-Atlas-Key: atlas_live_…`}</Code>
            <Table
              head={['Prefix', 'Meaning']}
              rows={[
                [<C key="l">atlas_live_</C>, 'Production key. Uses the environment chosen for live keys.'],
                [<C key="t">atlas_test_</C>, 'Test key. Same API, its own environment choice (for example Temporary) so testing never uses production capacity.'],
              ]}
            />
            <P>
              A key looks like <C>atlas_live_&lt;16 hex key id&gt;_&lt;43 random characters&gt;</C>. Atlas AI stores only a SHA-256 hash, so a lost key cannot be recovered: ask the
              administrator to rotate it. Keys can have their own expiry and limits, be disabled temporarily, revoked, or rotated with a grace period during which both the old and new key
              work.
            </P>
            <Note tone="warn">
              <b>Keep keys on your server.</b> Never put a key in a mobile app, browser JavaScript, a public repository or a URL. Your app talks to your server; your server calls Atlas AI.
              Too many failed key attempts from one address are blocked for a minute (<C>429 too_many_auth_failures</C>).
            </Note>

            <H2 id="end-users">End users &amp; isolation</H2>
            <P>
              Tell Atlas AI which of your users a request is for with <C>X-Atlas-User</C> (1-128 characters: letters, digits and <C>. _ : @ -</C>). Use your own stable, opaque user id,
              not an email or phone number. Each end user gets a private space: conversations, memory and documents are never shared between users, and never between applications.
              Without the header, requests use one shared space for the application (<C>_app</C>).
            </P>
            <Code title="Header">{'X-Atlas-User: user_8f14e45f'}</Code>
            <Note>
              The id is scoped to your application: <C>user_1</C> in your app and <C>user_1</C> in another app are different people, and neither can reach an Atlas AI website account.
              Requesting another user’s conversation or document returns <C>404</C>, never their data.
            </Note>

            <H2 id="requests">Request format</H2>
            <Table
              head={['Rule', 'Detail']}
              rows={[
                ['Body', <>JSON with <C>Content-Type: application/json</C> (except <C>/voice/transcriptions</C>, which takes raw audio)</>],
                ['Unknown fields', 'Refused with 400 (bodies are validated strictly, so typos are caught)'],
                ['Encoding', 'UTF-8'],
                ['IDs', <>Prefixed: <C>conv_</C>, <C>msg_</C>, <C>doc_</C>, <C>req_</C>, <C>int_</C>, <C>key_</C></>],
                ['Times', 'ISO 8601 strings in UTC; rate-limit resets are Unix seconds'],
                ['Message size', `Your application’s input limit (hard maximum ${HARD_CEILINGS.maxInputChars.toLocaleString()} characters)`],
                ['Document size', `Your application’s document limit (hard maximum ${HARD_CEILINGS.maxDocumentChars.toLocaleString()} characters)`],
                ['Reply length', `Capped by your application’s output limit (hard maximum ${HARD_CEILINGS.maxOutputTokens.toLocaleString()} tokens)`],
                ['Timeout', 'Requests are cut off at about 60 seconds; use streaming for long answers'],
              ]}
            />
            <Table
              head={['Request header', 'Required', 'Purpose']}
              rows={[
                [<C key="a">Authorization</C>, 'Yes', 'Bearer API key'],
                [<C key="c">Content-Type</C>, 'With a body', 'application/json, or the audio type for transcriptions'],
                [<C key="u">X-Atlas-User</C>, 'Recommended', 'Your end user’s id'],
                [<C key="i">Idempotency-Key</C>, 'Optional', 'Make a POST/DELETE safe to retry'],
              ]}
            />

            <H2 id="responses">Response format</H2>
            <P>Every JSON response, success or failure, has the same envelope:</P>
            <Table
              head={['Field', 'Type', 'Meaning']}
              rows={[
                [<C key="s">success</C>, 'boolean', 'true when the request worked'],
                [<C key="r">request_id</C>, 'string', 'Unique id of this request (also X-Request-Id). Quote it in support requests'],
                [<C key="v">api_version</C>, 'string', '"v1"'],
                [<C key="a">app_id</C>, 'string | null', 'Your application id (null when the key was not recognised)'],
                [<C key="c">conversation_id</C>, 'string | null', 'The conversation the request used or created'],
                [<C key="d">data</C>, 'object | null', 'The result (see each endpoint); null on failure'],
                [<C key="u">usage</C>, 'object | null', 'Token usage when the provider reports it'],
                [<C key="e">error</C>, 'object | null', '{ code, message, details? } on failure; null on success'],
                [<C key="l">rate_limit</C>, 'object | null', '{ limit, remaining, reset, window } of the tightest request limit'],
              ]}
            />
            <Code title="Success">{JSON.stringify(CHAT_RESPONSE, null, 2)}</Code>
            <Code title="Failure (HTTP 403)">
              {JSON.stringify(
                {
                  success: false,
                  request_id: 'req_8d7c6b5a4f3e2d1c0b9a8f7e',
                  api_version: 'v1',
                  app_id: 'int_7e8f9a0b1c2d3e4f',
                  conversation_id: null,
                  data: null,
                  usage: null,
                  error: { code: 'permission_denied', message: 'This application is not permitted to use image generation.', details: { permission: 'images' } },
                  rate_limit: null,
                },
                null,
                2,
              )}
            </Code>
            <Table
              head={['Response header', 'Meaning']}
              rows={[
                [<C key="1">X-Request-Id</C>, 'The request id'],
                [<C key="2">Atlas-Api-Version</C>, 'v1'],
                [<C key="3">X-RateLimit-Limit / -Remaining / -Reset</C>, 'The tightest request limit, what is left and when it resets (Unix seconds)'],
                [<C key="4">Retry-After</C>, 'Seconds to wait (on 429)'],
                [<C key="5">Idempotent-Replayed: true</C>, 'This is a stored result of an earlier request with the same Idempotency-Key'],
                [<C key="6">Cache-Control: no-store</C>, 'Responses are never cached'],
              ]}
            />

            <H2 id="errors">Errors</H2>
            <P>
              The HTTP status gives the class of problem and <C>error.code</C> the exact reason (codes are stable; messages may change). Messages are safe to show to your users. 4xx
              errors are not retryable without a change; 429, 502 and 503 are, after waiting.
            </P>
            <Table head={['Status', 'error.code', 'Meaning']} rows={ERRORS.map(([s, c, m]) => [String(s), <span key="c" className="font-mono text-xs">{c}</span>, m])} />
            <Code title="Retry with backoff (Node.js)">{`async function withRetry(fn, attempts = 4) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const retryable = [429, 502, 503].includes(err.status);
      if (!retryable || i + 1 >= attempts) throw err;
      const wait = err.retryAfter ? err.retryAfter * 1000 : 500 * 2 ** i;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}`}</Code>

            <H2 id="rate-limits">Rate limits &amp; quotas</H2>
            <P>
              Limits belong to your application (and optionally to each key, applied on top). Request limits count every authenticated request; feature quotas count units of work per UTC
              day and are given back when the work fails. Usage of the API is separate from Atlas AI website users’ allowances. Your administrator assigns one of these profiles or
              custom values; <C>GET /app</C> shows yours.
            </P>
            <Table head={['Limit', ...profiles.map((p) => PROFILE_LABEL[p])]} rows={limitRows} />
            <Note>
              Always-on safeguards, also for Unlimited: {HARD_CEILINGS.requestsPerMinute} requests per minute and {HARD_CEILINGS.maxConcurrent} concurrent requests per server instance,
              the hard size maximums above, the free-tier capacity of each AI provider, and the shared ElevenLabs credit caps.
            </Note>
            <P>
              When a limit is reached you get <C>429</C> with <C>Retry-After</C>. Request limits answer <C>rate_limited</C> (<C>details.window</C> is minute, hour, day, week or month);
              feature quotas answer <C>feature_limit</C> and reset at 00:00 UTC; <C>concurrency_limit</C> means too many requests are running at once. A refused request is not counted.
            </P>

            <H2 id="idempotency">Idempotency</H2>
            <P>
              Network errors happen. To retry a POST or DELETE safely, send an <C>Idempotency-Key</C> (8-128 characters, letters, digits and <C>. _ : -</C>), for example a UUID per
              user action. Repeating the same request with the same key within 24 hours returns the stored result (header <C>Idempotent-Replayed: true</C>) instead of running it twice.
            </P>
            <Table
              head={['Situation', 'Result']}
              rows={[
                ['Same key, same request, finished', 'The stored response (not counted again)'],
                ['Same key, still running', '409 idempotency_in_progress: retry shortly'],
                ['Same key, different body or path', '422 idempotency_mismatch'],
                ['Server error (5xx)', 'Not stored: retrying runs the request again'],
                ['Streaming requests, transcriptions', 'Not replayable (the key is accepted for streams but not stored; refused for audio uploads)'],
              ]}
            />
            <Code title="Example">{curl('POST', '/chat', { message: 'Book summary please' }).replace('-H "Content-Type', '-H "Idempotency-Key: 6f1c2e0a-7d3b-4c55-9a1e-2b8f0d4c9e71" \\\n  -H "Content-Type')}</Code>

            <H2 id="streaming">Streaming (SSE)</H2>
            <P>
              With <C>"stream": true</C> the reply arrives as Server-Sent Events (<C>Content-Type: text/event-stream</C>). Each event has an <C>event:</C> line and a JSON{' '}
              <C>data:</C> line, separated by a blank line. Events are forwarded the moment Atlas AI produces them; nothing is buffered. Errors before the stream starts (authentication,
              permissions, limits, bad input) are ordinary JSON responses with an error status, so check the status first.
            </P>
            <Table head={['Event', 'Data', 'Meaning']} rows={STREAM_EVENTS.map(([e, d, m]) => [<C key="e">{e}</C>, <span key="d" className="font-mono text-xs">{d}</span>, m])} />
            <Tabs
              items={[
                { label: 'JavaScript', code: streamJs() },
                { label: 'Python', code: pythonStream() },
                { label: 'curl', code: curl('POST', '/chat', { message: 'Tell me a short story', stream: true }, '--no-buffer') },
              ]}
            />
            <P>The reply is saved to the conversation as it streams. If the connection drops, fetch the conversation later to read the saved text.</P>

            <H2 id="permissions">Permissions</H2>
            <P>
              Applications start with no permissions; the administrator grants each one. A request needing a permission you do not have gets <C>403 permission_denied</C> with{' '}
              <C>error.details.permission</C>. <C>chat_stream</C>, <C>models</C> and <C>reasoning</C> also need <C>chat</C>; <C>deep_research</C> needs <C>research</C>.
            </P>
            <Table head={['Permission', 'Name', 'Allows']} rows={permRows} />

            <H2 id="environments">Environments</H2>
            <P>
              Atlas AI runs its AI providers in three environments: <b>Main</b>, <b>Secondary</b> and <b>Temporary</b> (public testing). The administrator decides which ones your
              application may use and which one live and test keys use; requests cannot choose. If the environment Atlas AI is using is not allowed for your application, requests fail
              with <C>503 environment_not_permitted</C> instead of quietly moving to another environment. A switch never interrupts a request that is already running. Logs show which
              environment served each request.
            </P>

            <H2 id="endpoints">Endpoint reference</H2>
            <Table
              head={['Method', 'Path', 'Permission', 'Purpose']}
              rows={ENDPOINTS.map((e) => [
                <Method key="m" m={e.method} />,
                <a key="p" href={`#${e.id}`} className="font-mono text-xs underline">
                  {e.path}
                </a>,
                <span key="r" className="font-mono text-xs">
                  {e.permission.split(' ')[0]}
                </span>,
                e.title,
              ])}
            />
            {ENDPOINTS.map((e) => (
              <EndpointDoc key={e.id} e={e} />
            ))}

            <H2 id="cors">Browsers &amp; CORS</H2>
            <P>
              The API is meant to be called from servers. Browser requests (with an <C>Origin</C> header) are accepted only from website origins the administrator lists for your
              application, and from this Atlas AI site (for the sandbox); anything else gets <C>403 origin_not_allowed</C>. Preflight <C>OPTIONS</C> requests are answered for the
              headers <C>Authorization, Content-Type, X-Atlas-Key, X-Atlas-User, Idempotency-Key</C>. Even with an allowed origin, a key in browser code can be copied, so prefer a
              server.
            </P>

            <H2 id="best-practices">Best practices</H2>
            <ul className="mt-3 list-disc space-y-2 pl-5 text-[15px] text-muted">
              <li>Keep one server-side client with the key in an environment variable; never log the key.</li>
              <li>Send a stable <C>X-Atlas-User</C> for each of your users so memory and history stay personal.</li>
              <li>Store <C>conversation_id</C> per chat thread in your database and send it with every follow-up.</li>
              <li>Use streaming for chat UIs: users see text immediately and long answers do not hit the timeout.</li>
              <li>Send an <C>Idempotency-Key</C> with POST requests your app may retry (send buttons, background jobs).</li>
              <li>Respect <C>Retry-After</C>; back off exponentially on 502/503.</li>
              <li>Log <C>request_id</C> with your own errors; it lets the administrator find the request.</li>
              <li>Use <C>"model": "auto"</C> unless you need a specific model: auto follows Atlas AI’s best available free model and its fallbacks.</li>
              <li>Watch <C>X-RateLimit-Remaining</C> and slow down before reaching zero.</li>
              <li>Delete conversations, documents and memories when your users ask you to (privacy requests).</li>
            </ul>

            <H2 id="limitations">Limitations</H2>
            <ul className="mt-3 list-disc space-y-2 pl-5 text-[15px] text-muted">
              <li>Documents must be sent as text; PDF/DOCX/XLSX/PPTX parsing is not done by the API.</li>
              <li>Images are returned inline as base64 data URLs.</li>
              <li>Streamed replies cannot be replayed with an Idempotency-Key.</li>
              <li>Requests are limited to about 60 seconds each.</li>
              <li>Atlas AI uses free model tiers, so busy periods can return 503 provider_capacity; retry later.</li>
              <li>No webhooks yet: poll the conversation endpoints if you need results later.</li>
            </ul>

            <H2 id="changelog">Changelog</H2>
            <Table
              head={['Version', 'Date', 'Changes']}
              rows={[['v1', '2026-11-13', 'First release: app, models, chat (JSON and SSE), conversations, images, research, documents, voice, memory; keys, permissions, limits, idempotency.']]}
            />
            <div className="mt-12 flex flex-wrap gap-3">
              <Link to="/developers/sandbox" className="btn btn-dark">
                <FlaskConical className="size-4" aria-hidden="true" /> Try the API in the sandbox
              </Link>
              <Link to="/contact" className="btn btn-light">
                Request API access
              </Link>
            </div>
          </article>
        </div>
      </Container>
    </>
  );
}

/* ------------------------------------------------------------------------ sandbox */

interface Preset {
  id: string;
  label: string;
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  body?: unknown;
}
const PRESETS: Preset[] = [
  { id: 'app', label: 'Your application', method: 'GET', path: '/app' },
  { id: 'models', label: 'List models', method: 'GET', path: '/models' },
  { id: 'chat', label: 'Chat', method: 'POST', path: '/chat', body: { message: 'Hello! Who are you, in one sentence?' } },
  { id: 'chat_stream', label: 'Chat (streaming)', method: 'POST', path: '/chat', body: { message: 'Write a four-line poem about Accra.', stream: true } },
  { id: 'chat_web', label: 'Chat with web search', method: 'POST', path: '/chat', body: { message: 'What is in the news in Ghana today?', web_search: 'on' } },
  { id: 'research_search', label: 'Web search (sources)', method: 'POST', path: '/research', body: { query: 'Ghana cedi exchange rate', mode: 'search' } },
  { id: 'research_answer', label: 'Research answer', method: 'POST', path: '/research', body: { query: 'How does mobile money work in Ghana?', mode: 'answer' } },
  { id: 'images', label: 'Create an image', method: 'POST', path: '/images', body: { prompt: 'a small lighthouse on a cliff at sunset, watercolour' } },
  { id: 'documents_upload', label: 'Upload a document', method: 'POST', path: '/documents', body: { name: 'menu.txt', text: 'Jollof rice – GHS 45\nWaakye – GHS 30\nKelewele – GHS 20' } },
  { id: 'documents', label: 'List documents', method: 'GET', path: '/documents' },
  { id: 'conversations', label: 'List conversations', method: 'GET', path: '/conversations' },
  { id: 'memory', label: 'List memories', method: 'GET', path: '/memory' },
  { id: 'voice_speech', label: 'Text to speech', method: 'POST', path: '/voice/speech', body: { text: 'Akwaaba! Welcome to Atlas AI.' } },
];

interface Result {
  status: number;
  ms: number;
  headers: [string, string][];
  body: string;
  audio?: string;
  streaming?: boolean;
}

export function ApiSandboxPage() {
  useTitle('Atlas AI API – Sandbox');
  const initial = PRESETS.find((p) => p.id === new URLSearchParams(window.location.search).get('preset')) ?? PRESETS[0];
  const [key, setKey] = useState('');
  const [user, setUser] = useState('sandbox-user');
  const [preset, setPreset] = useState(initial.id);
  const [method, setMethod] = useState<Preset['method']>(initial.method);
  const [path, setPath] = useState(initial.path);
  const [body, setBody] = useState(initial.body ? JSON.stringify(initial.body, null, 2) : '');
  const [idem, setIdem] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const abort = useRef<AbortController | null>(null);
  const audioUrl = useRef<string | null>(null);
  useEffect(() => () => {
    abort.current?.abort();
    if (audioUrl.current) URL.revokeObjectURL(audioUrl.current);
  }, []);

  const choose = (id: string) => {
    const p = PRESETS.find((x) => x.id === id)!;
    setPreset(id);
    setMethod(p.method);
    setPath(p.path);
    setBody(p.body ? JSON.stringify(p.body, null, 2) : '');
    setResult(null);
    setError('');
  };

  const keyOk = /^atlas_(live|test)_[a-f0-9]{16}_[A-Za-z0-9_-]{43}$/.test(key.trim());
  const snippet = useMemo(() => {
    let parsed: unknown;
    try {
      parsed = body.trim() ? JSON.parse(body) : undefined;
    } catch {
      parsed = undefined;
    }
    return curl(method, path, method === 'GET' ? undefined : parsed).replace('user_123', user || '_app');
  }, [method, path, body, user]);

  const send = async () => {
    setError('');
    setResult(null);
    let payload: string | undefined;
    if (method !== 'GET' && body.trim()) {
      try {
        payload = JSON.stringify(JSON.parse(body));
      } catch {
        setError('The body is not valid JSON.');
        return;
      }
    }
    if (!/^\/[A-Za-z0-9_\-/]*(\?[\w=&.-]*)?$/.test(path)) {
      setError('The path must start with / (for example /chat).');
      return;
    }
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setBusy(true);
    const t0 = performance.now();
    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${key.trim()}` };
      if (user.trim()) headers['X-Atlas-User'] = user.trim();
      if (payload) headers['Content-Type'] = 'application/json';
      if (idem.trim()) headers['Idempotency-Key'] = idem.trim();
      const res = await fetch(`${sandboxBase()}${path}`, { method, headers, body: payload, signal: ac.signal });
      const shown = [...res.headers.entries()].filter(([h]) => /^(x-request-id|atlas-api-version|x-ratelimit|retry-after|content-type|idempotent-replayed)/i.test(h));
      const type = res.headers.get('content-type') ?? '';
      const base: Result = { status: res.status, ms: 0, headers: shown, body: '' };
      if (type.startsWith('audio/')) {
        const blob = await res.blob();
        if (audioUrl.current) URL.revokeObjectURL(audioUrl.current);
        audioUrl.current = URL.createObjectURL(blob);
        setResult({ ...base, ms: Math.round(performance.now() - t0), body: `(${type}, ${blob.size.toLocaleString()} bytes)`, audio: audioUrl.current });
      } else if (type.includes('text/event-stream') && res.body) {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let text = '';
        setResult({ ...base, ms: Math.round(performance.now() - t0), streaming: true });
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          text += dec.decode(value, { stream: true });
          setResult({ ...base, ms: Math.round(performance.now() - t0), body: text, streaming: true });
        }
        setResult({ ...base, ms: Math.round(performance.now() - t0), body: text, streaming: false });
      } else {
        const text = await res.text();
        let pretty = text;
        try {
          pretty = JSON.stringify(JSON.parse(text), null, 2).replace(/"data:image\/[a-z]+;base64,[A-Za-z0-9+/=]{200,}"/g, (m) => `"${m.slice(1, 60)}… (${m.length.toLocaleString()} characters)"`);
        } catch {
          /* not JSON */
        }
        setResult({ ...base, ms: Math.round(performance.now() - t0), body: pretty });
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError('The request could not be sent (network error, or the API is not deployed at this address yet).');
    } finally {
      setBusy(false);
    }
  };

  // the reply text of a stream, assembled from its delta events
  const streamedText = useMemo(() => {
    if (!result || !result.body.includes('event: ')) return null;
    return result.body
      .split('\n\n')
      .filter((b) => b.startsWith('event: delta'))
      .map((b) => {
        try {
          return (JSON.parse(b.split('\n').find((l) => l.startsWith('data: '))!.slice(6)) as { text: string }).text;
        } catch {
          return '';
        }
      })
      .join('');
  }, [result]);

  const field = 'w-full rounded-lg border border-border bg-bg px-3 py-2 text-[14px] outline-none focus:border-fg/40';
  return (
    <>
      <PageHero
        crumbs={[home, { label: 'Developers', href: '/developers' }, { label: 'Sandbox' }]}
        eyebrow="Atlas AI API sandbox"
        title="Try the API live."
        lead="Send real requests to the Atlas AI API with your key and see the exact response: status, headers, the JSON envelope, live streaming and audio."
      />
      <Container className="py-12 sm:py-16">
        <Note tone="warn">
          <KeyRound className="mr-1 inline size-4" aria-hidden="true" />
          Requests are real: they use your application’s permissions and count against its limits. Your key stays in this page’s memory only. It is never saved, and it is sent only
          to {origin()}. Use a test key (<C>atlas_test_</C>) where you can, and close the tab when you are done.
        </Note>
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-4">
            <div>
              <label htmlFor="sb-key" className="mb-1 block text-sm font-medium">
                API key
              </label>
              <input id="sb-key" type="password" autoComplete="off" spellCheck={false} className={cn(field, 'font-mono')} placeholder="atlas_test_…" value={key} onChange={(e) => setKey(e.target.value)} />
              {key && !keyOk && <p className="mt-1 text-xs text-rose-600">That does not look like an Atlas AI key (atlas_live_… or atlas_test_…).</p>}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="sb-user" className="mb-1 block text-sm font-medium">
                  X-Atlas-User
                </label>
                <input id="sb-user" className={cn(field, 'font-mono')} value={user} onChange={(e) => setUser(e.target.value)} />
              </div>
              <div>
                <label htmlFor="sb-idem" className="mb-1 block text-sm font-medium">
                  Idempotency-Key (optional)
                </label>
                <div className="flex gap-2">
                  <input id="sb-idem" className={cn(field, 'font-mono')} value={idem} onChange={(e) => setIdem(e.target.value)} />
                  <button type="button" className="btn btn-light btn-sm" onClick={() => setIdem(crypto.randomUUID())}>
                    New
                  </button>
                </div>
              </div>
            </div>
            <div>
              <label htmlFor="sb-preset" className="mb-1 block text-sm font-medium">
                Example
              </label>
              <select id="sb-preset" className={field} value={preset} onChange={(e) => choose(e.target.value)}>
                {PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.method} {p.path} – {p.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex gap-2">
              <select aria-label="Method" className={cn(field, 'w-28 font-mono')} value={method} onChange={(e) => setMethod(e.target.value as Preset['method'])}>
                <option>GET</option>
                <option>POST</option>
                <option>DELETE</option>
              </select>
              <div className="flex min-w-0 flex-1 items-center rounded-lg border border-border bg-bg pl-3 font-mono text-[13px]">
                <span className="hidden shrink-0 text-muted sm:inline">/api/{API_VERSION}</span>
                <input aria-label="Path" className="min-w-0 flex-1 bg-transparent px-1 py-2 outline-none" value={path} onChange={(e) => setPath(e.target.value)} />
              </div>
            </div>
            {method !== 'GET' && (
              <div>
                <label htmlFor="sb-body" className="mb-1 block text-sm font-medium">
                  Body (JSON)
                </label>
                <textarea id="sb-body" rows={9} spellCheck={false} className={cn(field, 'font-mono text-[13px]')} value={body} onChange={(e) => setBody(e.target.value)} />
              </div>
            )}
            {error && <p className="text-sm text-rose-600">{error}</p>}
            <div className="flex gap-2">
              <button type="button" className="btn btn-dark" disabled={!keyOk || busy} onClick={() => void send()}>
                <Play className="size-4" aria-hidden="true" /> {busy ? 'Sending…' : 'Send request'}
              </button>
              {busy && (
                <button type="button" className="btn btn-light" onClick={() => abort.current?.abort()}>
                  <Square className="size-4" aria-hidden="true" /> Stop
                </button>
              )}
            </div>
            <Code title="The same request with curl">{snippet}</Code>
          </div>

          <div className="min-w-0">
            <div className="mb-2 text-sm font-medium">Response</div>
            {!result ? (
              <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted">{busy ? 'Waiting for the response…' : 'Send a request to see the response here.'}</div>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <span className={cn('rounded px-2 py-0.5 font-mono font-bold', result.status < 400 ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : result.status === 429 ? 'bg-amber-500/15 text-amber-700' : 'bg-rose-500/15 text-rose-700 dark:text-rose-300')}>
                    HTTP {result.status}
                  </span>
                  <span className="text-muted">{result.ms.toLocaleString()} ms{result.streaming ? ' · streaming…' : ''}</span>
                </div>
                {result.headers.length > 0 && (
                  <div className="rounded-xl border border-border p-3 font-mono text-[12px]">
                    {result.headers.map(([h, v]) => (
                      <div key={h} className="flex gap-2">
                        <span className="text-muted">{h}:</span>
                        <span className="break-all">{v}</span>
                      </div>
                    ))}
                  </div>
                )}
                {result.audio && <audio controls src={result.audio} className="w-full" />}
                {streamedText !== null && (
                  <div className="rounded-xl border border-border bg-surface p-4 text-[14px] leading-relaxed whitespace-pre-wrap">
                    {streamedText}
                    {result.streaming && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-fg/60 align-middle" />}
                  </div>
                )}
                <Code title={streamedText !== null ? 'Raw event stream' : 'Body'}>{result.body || ' '}</Code>
              </div>
            )}
          </div>
        </div>
        <div className="mt-10">
          <Link to="/developers" className="btn btn-light">
            ← Back to the API documentation
          </Link>
        </div>
      </Container>
    </>
  );
}
