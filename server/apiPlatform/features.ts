/**
 * The non-chat endpoints of the Atlas AI API. Each one reuses the existing service (image system,
 * search service, document indexer, Cloudflare speech with its free-quota caps, ElevenLabs with its
 * credit caps, memory store) inside the end user's own data space.
 */
import { z } from 'zod';
import type { Ctx } from '../access.js';
import { cloudflareConfigured } from '../cloudflare/client.js';
import { modelNeuronsToday, reserveNeurons, userVoiceNeuronsToday } from '../cloudflare/budget.js';
import { transcribe } from '../cloudflare/speech.js';
import { MAX_AUDIO_BYTES, STT_ESTIMATE, STT_MODEL, TTS_APP_DAILY_NEURONS, TTS_MAX_CHARS, TTS_USER_DAILY_NEURONS, WHISPER_TO_LANGUAGE } from '../config/speech.js';
import { indexDocument } from '../docs/documents.js';
import { elevenSpeak } from '../elevenlabs/routes.js';
import { SERVER_TIME } from '../firestore.js';
import { HttpError } from '../http.js';
import { ImageError, runImageTurn } from '../images/generate.js';
import { deleteConversation } from '../memory/deleteConversation.js';
import { ProviderError } from '../providers/types.js';
import { gatherWebContext } from '../search/web.js';
import { ttsProvider } from '../speech/tts.js';
import { need, sizeLimit, type ApiCall } from './context.js';
import { conversationRow, CONV_ID, DOC_ID, loadConversation, loadMessages } from './chat.js';
import { newId } from './keys.js';
import { claimUnits } from './limits.js';

/** Run work that holds feature units: the units are given back when it fails before producing anything. */
async function withUnits<T>(call: ApiCall, claims: Awaited<ReturnType<typeof claimUnits>>[], run: () => Promise<T>): Promise<T> {
  call.meta.units.push(...claims);
  try {
    return await run();
  } catch (err) {
    await Promise.all(claims.map((c) => c.release()));
    throw err;
  }
}

/** A provider failure as an API error: never internal settings or credentials. */
export function providerFailure(call: ApiCall, err: unknown, what: string): never {
  if (err instanceof HttpError) throw err;
  if (err instanceof ImageError) {
    const status = err.code === 'image_daily_limit' || err.code === 'image_busy' ? 429 : err.retryable ? 503 : 422;
    if (status === 503) call.meta.providerError = true;
    throw new HttpError(status, err.code, err.message);
  }
  if (err instanceof ProviderError) {
    call.meta.providerError = true;
    if (err.code === 'daily_limit' || err.code === 'rate_limited' || err.code === 'environment_limit') {
      throw new HttpError(503, 'provider_capacity', `The free capacity for ${what} is used up for now. Please try again later.`);
    }
    throw new HttpError(502, 'provider_error', `The AI provider could not complete ${what}. Please try again.`);
  }
  throw err;
}

/* ---------------------------------------------------------------------- images */

export const imageInput = z
  .object({
    prompt: z.string().trim().min(3).max(2_000),
    /** a picture to edit (data URL); without it a new picture is created */
    image: z
      .string()
      .max(1_500_000)
      .regex(/^data:image\/(png|jpe?g|webp);base64,/)
      .optional(),
  })
  .strict();

export async function createImage(call: ApiCall, input: z.infer<typeof imageInput>, messageId = newId('msg')) {
  need(call, 'images');
  if (!cloudflareConfigured()) throw new HttpError(503, 'images_unavailable', 'Image generation is not available right now.');
  const claim = await claimUnits(call.db, call.scope, 'images');
  return withUnits(call, [claim], async () => {
    try {
      const r = await runImageTurn({
        db: call.db,
        uid: call.euid,
        conversationId: 'api_images',
        messageId,
        intent: input.image ? { kind: 'edit', prompt: input.prompt, source: 'attachment' } : { kind: 'generate', prompt: input.prompt },
        attachment: input.image ?? null,
        previousImageId: null,
        signal: call.signal,
        onStage: () => undefined,
        allowanceChecked: true,
      });
      call.meta.model = r.meta.model;
      return {
        image: {
          id: r.meta.id,
          kind: r.meta.kind,
          mime: r.meta.mime,
          width: r.meta.width,
          height: r.meta.height,
          stored: r.stored,
          data_url: `data:${r.meta.mime};base64,${Buffer.from(r.bytes).toString('base64')}`,
        },
        model: r.meta.model,
      };
    } catch (err) {
      providerFailure(call, err, 'the image');
    }
  });
}

/* -------------------------------------------------------------------- research */

export const researchInput = z
  .object({
    query: z.string().trim().min(2).max(2_000),
    /** search: sources only; answer: a sourced answer; deep: a Deep Research report */
    mode: z.enum(['search', 'answer', 'deep']).optional(),
    stream: z.boolean().optional(),
    conversation_id: z.string().regex(CONV_ID).optional(),
  })
  .strict();

/** Web search with sources only (answer and deep go through the chat engine, see router.ts). */
export async function webSearch(call: ApiCall, query: string) {
  need(call, 'research');
  const claim = await claimUnits(call.db, call.scope, 'research');
  return withUnits(call, [claim], async () => {
    const web = await gatherWebContext({
      db: call.db,
      uid: call.euid,
      turns: [],
      text: query,
      options: { webSearch: true, searchMode: 'manual' },
      signal: call.signal,
    }).catch((err) => providerFailure(call, err, 'the web search'));
    const sources = (web?.sources ?? []).filter((s) => s.kind === 'web').map((s) => ({ index: s.index, title: s.title, url: s.url, snippet: s.snippet ?? null, site: s.site ?? null }));
    if (!web || web.info.status === 'unavailable') {
      await claim.release();
      call.meta.providerError = true;
      throw new HttpError(503, 'search_unavailable', 'Web search is not available right now. Please try again later.');
    }
    // nothing found: the unit is given back
    if (web.info.status !== 'ok') await claim.release();
    return { query: web.info.query, provider: web.info.provider, status: web.info.status, sources };
  });
}

/* ------------------------------------------------------------------- documents */

const docText = z.string().max(2_500_000);
export const documentInput = z
  .object({
    name: z.string().trim().min(1).max(300),
    mime: z.string().max(200).optional(),
    /** the document's text (extracted by the application) */
    text: docText.optional(),
    /** or the text in sections with a location label ("p. 3", "Sheet1") */
    sections: z.array(z.object({ ref: z.string().max(200), text: docText })).max(5_000).optional(),
    /** a base64 plain-text file (txt, md, csv, json, html ...) instead of text */
    content_base64: z.string().max(4_000_000).optional(),
  })
  .strict();

const TEXT_MIME = /^(text\/[a-z.+-]+|application\/(json|xml|csv|x-ndjson|markdown))$/i;

export async function uploadDocument(call: ApiCall, input: z.infer<typeof documentInput>) {
  need(call, 'documents');
  let sections = input.sections ?? (input.text !== undefined ? [{ ref: 'text', text: input.text }] : null);
  if (!sections && input.content_base64 !== undefined) {
    const mime = input.mime ?? 'text/plain';
    if (!TEXT_MIME.test(mime)) {
      throw new HttpError(
        415,
        'unsupported_document',
        'Only plain-text formats can be sent as content_base64. For PDF, DOCX, XLSX or PPTX files, extract the text in your application and send it as text or sections.',
      );
    }
    const text = Buffer.from(input.content_base64, 'base64').toString('utf8');
    sections = [{ ref: 'text', text }];
  }
  if (!sections) throw new HttpError(400, 'bad_request', 'Send the document as text, sections or content_base64.');
  const chars = sections.reduce((n, s) => n + s.text.length, 0);
  const max = sizeLimit(call, 'maxDocumentChars');
  if (chars > max) throw new HttpError(413, 'document_too_large', `The document is too large (limit ${max} characters).`, { limit: max });
  if (!chars) throw new HttpError(422, 'no_text', 'The document contains no text.');

  const claim = await claimUnits(call.db, call.scope, 'documents');
  return withUnits(call, [claim], async () => {
    const id = newId('doc');
    const path = `users/${call.euid}/documents/${id}`;
    await call.db.set(path, {
      name: input.name,
      mime: input.mime ?? 'text/plain',
      size: chars,
      status: 'processing',
      error: null,
      apiIntegrationId: call.integration.id,
      createdAt: SERVER_TIME,
    });
    try {
      const r = await indexDocument({ db: call.db, uid: call.euid, documentId: id, sections });
      return { document: { id, name: input.name, status: 'ready', chunk_count: r.chunkCount, char_count: chars, searchable: r.embedded } };
    } catch (err) {
      await deleteDocumentData(call, id).catch(() => undefined);
      throw err;
    }
  });
}

async function ownDocument(call: ApiCall, id: string) {
  if (!DOC_ID.test(id)) throw new HttpError(404, 'not_found', 'Document not found.');
  const doc = await call.db.get<Record<string, unknown>>(`users/${call.euid}/documents/${id}`);
  if (!doc || doc.data.apiIntegrationId !== call.integration.id) throw new HttpError(404, 'not_found', 'Document not found.');
  return doc.data;
}

const docView = (id: string, d: Record<string, unknown>) => ({
  id,
  name: String(d.name ?? ''),
  mime: String(d.mime ?? ''),
  status: String(d.status ?? ''),
  chunk_count: typeof d.chunkCount === 'number' ? d.chunkCount : null,
  char_count: typeof d.charCount === 'number' ? d.charCount : null,
  created_at: typeof d.createdAt === 'string' ? d.createdAt : null,
});

export async function listDocuments(call: ApiCall) {
  need(call, 'documents');
  const rows = await call.db.list<Record<string, unknown>>(`users/${call.euid}/documents`, { where: [['apiIntegrationId', 'EQUAL', call.integration.id]], limit: 200 });
  return { documents: rows.map((r) => docView(r.id, r.data)) };
}

export async function getDocument(call: ApiCall, id: string) {
  need(call, 'documents');
  return { document: docView(id, await ownDocument(call, id)) };
}

async function deleteDocumentData(call: ApiCall, id: string) {
  const path = `users/${call.euid}/documents/${id}`;
  for (let page = 0; page < 5; page++) {
    const chunks = await call.db.list(`${path}/chunks`, { limit: 300 });
    if (!chunks.length) break;
    await call.db.commit(chunks.map((c) => ({ op: 'delete' as const, path: c.path })));
    if (chunks.length < 300) break;
  }
  await call.db.delete(path);
}

export async function deleteDocument(call: ApiCall, id: string) {
  need(call, 'documents');
  await ownDocument(call, id);
  await deleteDocumentData(call, id);
  return { deleted: true, id };
}

export const analyzeInput = z
  .object({
    task: z.enum(['summarize', 'analyze', 'question']).optional(),
    question: z.string().trim().min(1).max(20_000).optional(),
    stream: z.boolean().optional(),
    conversation_id: z.string().regex(CONV_ID).optional(),
    model: z.string().max(200).optional(),
  })
  .strict();

/** The chat message for a document task (the engine answers it from the document's text). */
export async function analyzeMessage(call: ApiCall, id: string, input: z.infer<typeof analyzeInput>): Promise<string> {
  need(call, 'documents');
  const d = await ownDocument(call, id);
  if (d.status !== 'ready') throw new HttpError(409, 'document_not_ready', 'The document is not ready.');
  const name = String(d.name ?? 'the document');
  const task = input.task ?? (input.question ? 'question' : 'summarize');
  if (task === 'question') {
    if (!input.question) throw new HttpError(400, 'bad_request', 'Send a question.');
    return input.question;
  }
  if (task === 'summarize') return `Summarise the attached document "${name}": the main points, then the key details.${input.question ? ` Focus: ${input.question}` : ''}`;
  return `Analyse the attached document "${name}": its purpose, structure, main findings, strengths, weaknesses and anything notable.${input.question ? ` Focus: ${input.question}` : ''}`;
}

/* ----------------------------------------------------------------------- voice */

export const speechInput = z
  .object({
    text: z.string().trim().min(1).max(TTS_MAX_CHARS * 2),
    provider: z.enum(['cloudflare', 'elevenlabs']).optional(),
    voice_id: z
      .string()
      .regex(/^[A-Za-z0-9]{8,40}$/)
      .optional(),
  })
  .strict();

export async function speech(call: ApiCall, input: z.infer<typeof speechInput>): Promise<Response> {
  need(call, 'voice_tts');
  const text = input.text.replace(/\s+/g, ' ').trim().slice(0, TTS_MAX_CHARS);
  const claim = await claimUnits(call.db, call.scope, 'tts_chars', text.length);
  return withUnits(call, [claim], async () => {
    if (input.provider === 'elevenlabs') {
      // ElevenLabs is shared (not environment-specific) and keeps its own credit caps
      call.meta.model = 'elevenlabs';
      const ctx: Ctx = {
        user: { uid: call.euid, email: null, emailVerified: false, provider: 'api', phoneVerified: false, authTime: Math.floor(Date.now() / 1000), token: '' },
        db: call.db,
        admin: false,
      };
      try {
        return await elevenSpeak(ctx, { text, voiceId: input.voice_id }, call.signal, (p) => call.background(p));
      } catch (err) {
        if (err instanceof HttpError && err.status >= 500) call.meta.providerError = true;
        if (err instanceof HttpError) throw new HttpError(err.status, err.code, err.status >= 500 ? 'The ElevenLabs voice is not available right now.' : err.message);
        providerFailure(call, err, 'speech');
      }
    }
    if (!cloudflareConfigured()) throw new HttpError(503, 'speech_unavailable', 'Speech is not available right now.');
    const tts = ttsProvider();
    call.meta.model = tts.model;
    const estimate = Math.ceil(text.length * tts.costPerChar);
    const [app, mine] = await Promise.all([modelNeuronsToday(call.db, tts.model), userVoiceNeuronsToday(call.db, call.euid, 'tts')]).catch(() => [Infinity, Infinity]);
    if (app + estimate > TTS_APP_DAILY_NEURONS || mine + estimate > TTS_USER_DAILY_NEURONS) {
      throw new HttpError(503, 'provider_capacity', 'Today’s free natural-voice capacity is used up. It resets at 00:00 UTC.');
    }
    const r = await reserveNeurons(call.db, estimate);
    if (!r.ok) {
      call.meta.providerError = true;
      throw new HttpError(503, r.reason === 'app_cap' ? 'provider_capacity' : 'speech_unavailable', 'Speech is not available right now. Please try again later.');
    }
    try {
      const out = await r.run(() => tts.speak(text, call.signal));
      await r.settle(out.neurons, { uid: call.euid, model: tts.model, type: 'tts', ok: true }).catch(() => undefined);
      return new Response(new Uint8Array(out.bytes), { headers: { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' } });
    } catch (err) {
      await r.settle((err as { neurons?: number }).neurons ?? 0, { uid: call.euid, model: tts.model, type: 'tts', ok: false, error: err instanceof ProviderError ? err.code : 'aborted' }).catch(() => undefined);
      providerFailure(call, err, 'speech');
    }
  });
}

const AUDIO_TYPES = /^audio\/(webm|ogg|mp4|m4a|x-m4a|aac|mpeg|mp3|wav|x-wav|wave|flac|x-flac)(;.*)?$/i;

export async function transcription(call: ApiCall, request: Request) {
  need(call, 'voice_stt');
  const type = request.headers.get('content-type') ?? '';
  if (!AUDIO_TYPES.test(type)) throw new HttpError(415, 'unsupported_audio', 'Send the recording as the request body with an audio content type (MP3, M4A, WAV, OGG, WebM or FLAC).');
  if (Number(request.headers.get('content-length') ?? 0) > MAX_AUDIO_BYTES) throw new HttpError(413, 'audio_too_large', 'The recording is too large (about 2 minutes / 4 MB at most).');
  const audio = new Uint8Array(await request.arrayBuffer());
  if (audio.byteLength > MAX_AUDIO_BYTES) throw new HttpError(413, 'audio_too_large', 'The recording is too large (about 2 minutes / 4 MB at most).');
  if (audio.byteLength < 200) throw new HttpError(400, 'audio_empty', 'The recording is empty.');
  if (!cloudflareConfigured()) throw new HttpError(503, 'speech_unavailable', 'Transcription is not available right now.');
  const claim = await claimUnits(call.db, call.scope, 'stt');
  return withUnits(call, [claim], async () => {
    call.meta.model = STT_MODEL;
    const r = await reserveNeurons(call.db, STT_ESTIMATE);
    if (!r.ok) {
      call.meta.providerError = true;
      throw new HttpError(503, r.reason === 'app_cap' ? 'provider_capacity' : 'speech_unavailable', 'Transcription is not available right now. Please try again later.');
    }
    try {
      const t = await r.run(() => transcribe(audio, call.signal));
      await r.settle(t.neurons, { uid: call.euid, model: STT_MODEL, type: 'stt', ok: true }).catch(() => undefined);
      return { text: t.text, language: t.language ? (WHISPER_TO_LANGUAGE[t.language] ?? t.language) : null, duration: t.duration };
    } catch (err) {
      await r.settle((err as { neurons?: number }).neurons ?? 0, { uid: call.euid, model: STT_MODEL, type: 'stt', ok: false, error: err instanceof ProviderError ? err.code : 'aborted' }).catch(() => undefined);
      providerFailure(call, err, 'the transcription');
    }
  });
}

/* ---------------------------------------------------------------------- memory */

export async function listMemories(call: ApiCall) {
  need(call, 'memory');
  const rows = await call.db.list<Record<string, unknown>>(`users/${call.euid}/memories`, { limit: 300 });
  return {
    memories: rows.map((r) => ({
      id: r.id,
      text: String(r.data.text ?? ''),
      category: String(r.data.category ?? 'fact'),
      active: r.data.active !== false,
      origin: r.data.origin === 'manual' ? 'manual' : 'auto',
      source_conversation_id: typeof r.data.sourceConversationId === 'string' ? r.data.sourceConversationId : null,
    })),
  };
}

export async function deleteMemory(call: ApiCall, id: string | null) {
  need(call, 'memory');
  const base = `users/${call.euid}`;
  if (id) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new HttpError(404, 'not_found', 'Memory not found.');
    const doc = await call.db.get(`${base}/memories/${id}`);
    if (!doc) throw new HttpError(404, 'not_found', 'Memory not found.');
    await call.db.commit([
      { op: 'delete', path: `${base}/memories/${id}` },
      { op: 'delete', path: `${base}/memoryVectors/${id}` },
    ]);
    return { deleted: 1 };
  }
  const [mems, vecs] = await Promise.all([call.db.list(`${base}/memories`, { limit: 1000 }), call.db.list(`${base}/memoryVectors`, { limit: 1000 })]);
  await call.db.commit([...mems, ...vecs].map((d) => ({ op: 'delete' as const, path: d.path })));
  return { deleted: mems.length };
}

/* --------------------------------------------------------------- conversations */

export async function listConversations(call: ApiCall) {
  need(call, 'conversations_read');
  const rows = await call.db.list<Record<string, unknown>>(`users/${call.euid}/conversations`, {
    where: [['apiIntegrationId', 'EQUAL', call.integration.id]],
    limit: 200,
  });
  const list = rows.map((r) => conversationRow(r.id, r.data)).sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')));
  return { conversations: list };
}

export async function getConversation(call: ApiCall, id: string) {
  need(call, 'conversations_read');
  const conv = await loadConversation(call, id);
  const limit = Math.min(200, Math.max(1, Number(call.query.get('limit') ?? 100) || 100));
  const messages = await loadMessages(call, id, limit);
  return { conversation: conversationRow(id, conv), messages };
}

export async function removeConversation(call: ApiCall, id: string) {
  need(call, 'conversations_delete');
  await loadConversation(call, id);
  const deleted = await deleteConversation(call.db, call.euid, id);
  return { deleted: true, id, removed: deleted };
}
