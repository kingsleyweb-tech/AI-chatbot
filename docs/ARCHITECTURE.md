# Architecture

```
Browser (React PWA)                                  Vercel functions (/api)                 Providers
───────────────────                                  ───────────────────────                 ─────────
Firebase Auth ──ID token──┐
Firestore SDK (offline) ──┼─ realtime reads/writes ─────────────────────────────► Firestore (rules enforced)
                          │                                          ▲
                          └─ fetch + SSE ───► /api/chat ─────────────┤ REST with the user's ID token
                                              /api/models            │
                                              /api/config            ├──► OpenRouter (chat, embeddings, catalog)
                                              /api/memory            ├──► SerpAPI (general / news search)
                                                                     └──► Tavily (research, page reading)
                                              /api/documents
```

## Key decisions

- **No service account.** The server verifies Firebase ID tokens against Google's public keys (`server/auth.ts`, using `jose`). It then calls the Firestore REST API with that same token (`server/firestore.ts`), so security rules apply to server writes too. A leaked server environment cannot read other users' data.
- **Vercel instead of Cloud Functions,** so no Firebase Blaze plan is needed. Server code is plain web-standard `Request`/`Response` handlers and can be ported.
- **Documents are parsed in the browser** (pdf.js, mammoth, SheetJS, JSZip). Only extracted text is sent to `/api/documents`. This avoids serverless body limits and the need for Firebase Storage. Original files are not stored.
- **Provider abstraction:** `server/providers/types.ts` defines `ChatProvider` (`stream`, `complete`, `embed`, `listModels`). `registry.ts` routes model IDs to providers. Adding a direct Gemini, OpenAI or Anthropic adapter means implementing that interface and registering it.

## Chat request lifecycle (`server/chat/engine.ts`)

1. Validate the body (zod) and check the allowlist (`server/access.ts`, cached for 5 minutes).
2. Load the user's settings, conversation, project and model catalog. Build the **fallback chain**: requested model first, then configured fallbacks. Paid models are skipped when the key has no credits, and non-vision models are skipped when images are attached.
3. Gather context in parallel: relevant memories, related past conversations, attached-document excerpts and web results.
4. Build the system prompt (`server/chat/prompt.ts`) and trim history to the model's context budget.
5. Stream from the provider and re-emit normalized SSE events: `start`, `notice`, `sources`, `context`, `reasoning`, `delta`, `usage`, `error`, `done`. If a model fails **before** producing text (rate limit, unavailable, empty answer), the next model in the chain is tried and the UI shows a notice.
6. Persist the assistant message even if the client disconnected, plus usage counters.
7. After the response, in the background via `waitUntil`: generate a title, extract memories, and update the conversation summary.

The browser keeps live replies in a module-level store (`src/features/chat/engine.ts`). Navigating away doesn't interrupt a stream, and **Stop** aborts the fetch, which aborts the upstream request.

## Web search (`server/search`)

All searches go through one service, `SearchService` in `router.ts`. Nothing else calls a search provider.

1. **When to search** (`web.ts`, `heuristics.ts`). Search runs only when:
   - the user turns on **Search** (every message), or
   - **Auto** is on (the default) and the message clearly needs current information: news, prices, weather, "latest/today", a year at or after the model's knowledge, or a link, or
   - the user turns on **Deep Research**.

   Ordinary chat never searches. Short follow-ups ("what about 2025?") are rewritten into a standalone query by a free utility model.
2. **Cache first** (`store.ts`). Queries are normalized (case, punctuation, filler words) and looked up in `users/{uid}/searchCache/{sha1}`. The cache is shared across providers. Lifetime depends on intent: news 2 h, general 24 h, reference 7 days. A cache hit costs nothing and is shown as "from cache".
3. **De-duplication and throttling.** Identical searches in flight share one request. A user can make at most one search every 3 seconds and 10 a minute.
4. **Provider choice.** SerpAPI (Google) handles general and news questions. Tavily handles research, reference and page reading (`/extract`). The other provider is tried only when the first is over budget or fails, and a notice says so. Both are never queried for the same question.
5. **Budgets** (`config/limits.ts`, `config/limits` in Firestore). Before any request, two checks run:
   - the app's own per-provider daily and monthly counters (`usage/{day}`, `usage/m-{yyyy-mm}`, field `search.<provider>`)
   - the provider's own reported remaining quota (SerpAPI `account.json`, Tavily `/usage`, both free to call and cached for 10 minutes)

   When everything is exhausted, the user is told and the chat continues without search. A quota error marks the provider exhausted, so it isn't retried.
6. **Deep Research** (`research.ts`):
   1. A free model plans up to N sub-queries.
   2. Each sub-query goes through the same router within the run budget.
   3. Tavily reads the top pages.
   4. The model writes a structured report covering summary, findings, disagreements, limitations and sources.

   Progress streams to the UI as `research` events.

Sources carry title, site, URL, snippet and a publication date only when the provider reported one. Each answer stores what happened (`message.search`: provider, cached or fresh, trigger, query) so the UI can show it.

## Memory (`server/memory`)

- After each exchange, a small utility model returns JSON operations (`add`, `update`, `delete`) with a category and a reason, given the new exchange and the most similar existing memories. Near-duplicates (cosine ≥ 0.9) become updates.
- Memories are embedded (`memoryVectors/{id}`). At query time, all memories are included if there are 25 or fewer. Otherwise they are ranked by similarity to the message, with a lexical fallback when embeddings are unavailable.
- Conversation summaries (`convVectors/{cid}`) enable "related earlier conversations" recall.
- Users can view, search, edit, disable and delete memories, or turn memory off entirely, in **Memory** or **Settings**.

## Documents (`server/docs`)

Text is split into about 3,200-character chunks with 400-character overlap, preferring paragraph and sentence boundaries. Each chunk is embedded and stored under `documents/{id}/chunks`. At question time, a document small enough for the budget is included whole. Otherwise the top-ranked chunks are included with their page, sheet or slide reference, and the model cites them as `[D1]`.

## Firestore data model

All user data is under `users/{uid}`:

| Path | Contents |
| --- | --- |
| `users/{uid}` | `email`, `displayName`, `settings` (theme, accent, defaultModel, customInstructions, aboutMe, style, tone, level, language, memoryEnabled, webSearchDefault, sendOnEnter, voiceName) |
| `…/conversations/{cid}` | `title`, `projectId`, `saved`, `model`, `lastModel`, `documentIds[]`, `messageCount`, `summary`, timestamps |
| `…/conversations/{cid}/messages/{mid}` | `role`, `content`, `attachments[]` (compressed images, document references), `model`, `status`, `sources[]`, `usage`, `reasoning`, `error` |
| `…/memories/{id}` | `text`, `category`, `reason`, `active`, `origin`, `sourceConversationId`, `sourceTitle` |
| `…/memoryVectors/{id}`, `…/convVectors/{cid}` | embeddings and the model that produced them |
| `…/projects/{id}` | `name`, `instructions` |
| `…/documents/{id}` | `name`, `mime`, `size`, `status`, `error`, `chunkCount`, `pageCount`, `warning` |
| `…/documents/{id}/chunks/{n}` | `text`, `ref`, `embedding` |
| `…/savedResponses/{messageId}` | bookmarked answer snapshot |
| `…/usage/{yyyy-mm-dd}` | request and token counters, per-model breakdown, `search.<provider>.{requests,cached,failed,credits}` |
| `…/usage/m-{yyyy-mm}` | monthly search counters (budget checks) |
| `…/searchCache/{hash}` | cached search results or page extracts, with `expiresAt` |
| `config/access` | `allowedEmails[]`, `adminEmails[]` (admin-write) |
| `config/public` | `registrationOpen` (public read, admin-write) |
| `config/limits` | search budgets, Deep Research budget, cache lifetimes (approved read, admin-write) |

## Security model (`firebase/firestore.rules`)

- Every read and write requires a **verified email** that is a bootstrap admin or on the allowlist.
- `users/{uid}/**` is readable and writable only by that uid. Admins cannot read other users' data.
- Message roles are restricted to `user` or `assistant`, and content and title sizes are bounded.
- `config/access` is admin-write only, with a validated shape.
- Everything else is denied.
- `config/limits` is admin-write only, with a validated shape.
- Covered by `tests/rules/firestore.rules.test.ts` (15 cases, run in the emulator).

Secrets: `OPENROUTER_API_KEY`, `SERPAPI_API_KEY` and `TAVILY_API_KEY` are read only in `server/env.ts`. They are never logged and never sent to the browser.

## Known limitations

- **No OCR.** Scanned PDFs without a text layer are flagged with a clear message.
- **Original uploaded files are not stored,** only their extracted text. Images in chats are compressed (max 1600 px) and stored inline in the message, within Firestore's 1 MiB document limit.
- **Voice input** uses the Web Speech API. It works in Safari on iOS 14.5+ and Chrome, but not in Firefox. When unavailable, the microphone button is hidden. Read-aloud uses the system voices.
- **60-second function limit** on Vercel Hobby (see `vercel.json`). Very long generations may be cut off. Partial text is saved and can be continued.
- **Vector search is in-process,** fine for one person's data (hundreds of memories, thousands of chunks). Larger scale would need Firestore vector indexes or a vector database.
- **Free models are rate-limited** by OpenRouter. With no credits on the key, paid models fall back to free ones.
- **App Check is not enabled.** It needs a reCAPTCHA Enterprise site key; add `VITE_APPCHECK_SITE_KEY` and enforcement in the console if wanted.
