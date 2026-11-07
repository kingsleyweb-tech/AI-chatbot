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

## Providers and model routing (`server/providers`, `server/router`)

- **Providers.** Google Gemini (`gemini:<model>`, AI Studio key) is the **primary** provider. OpenRouter (default prefix) is the **secondary**. Both implement one `ChatProvider` interface and are registered in `server/providers/registry.ts`. One catalog, one router and one conversation engine serve both, so history, memory, documents and settings are shared.
- **Default model.** `gemini:gemini-3.5-flash` when `GEMINI_API_KEY` is set. An admin can set another app default in `config/ai`, and a user's own default or per-chat choice always wins. Tessera never changes a user's chosen model.
- **Routing** (`server/router/route.ts`):
  - `detectTask` reads the request without a model call: images, document types, intent and a token estimate.
  - `routeModel` keeps the selected model when it fits. Otherwise it uses the best free model for the task, for that reply only. Ranking: preferred provider first (`config/ai.preferredProvider`, default Gemini), then the task preference list, then featured models, then context size.
  - If only a paid model fits, the server returns `approval_required` and spends nothing until the user approves that model for one request.
- **Fallbacks** (`nextInChain`):
  - Each model is tried once, only before any text has streamed, and only for recoverable errors: busy, rate limited, timeout, outage, model unavailable.
  - Errors that affect a whole provider (a rejected key, OpenRouter's free daily cap) skip straight to the other provider.
  - Bad requests, content blocks and context-too-long errors never fall back.
  - Each switch is shown as a notice ("Switching to Google Gemini ... for this reply only").
  - Admins can limit fallback to the same provider, or turn it off (`config/ai.fallback`).
- **Admin AI settings** (`config/ai`, Settings > Models, admins only): preferred provider, app default model, fallback policy. These are validated by `normalizeAiConfig` and the Firestore rules, and cached for 5 minutes on the server. Paid models always need the user's approval; that is not configurable.
- **Analytics** in `usage/{day}`:
  - `providers.<id>.requests/tokens/failed/rateLimited`
  - `routing.fallbacks`, `routing.providerSwitches`, `routing.switched`
- **OpenRouter free daily cap.** Accounts without purchased credits get 50 free-model requests per day. The cap is read from OpenRouter's key info, or learned from the first `free-models-per-day` 429. Free OpenRouter models are then marked unavailable until midnight UTC, and requests go to Gemini.
- **Gemini.** It uses the free tier (no billing on the Google project; `GEMINI_BILLING=paid` flips every Gemini model to paid). Short background calls disable thinking, so it cannot use up their small output budget. Embeddings use `gemini-embedding-001` (768 dimensions). Usage is counted per provider in `usage/{day}.providers.<id>`.
- **Image generation and editing** are not offered. The prompt tells the model so, and it says so plainly.

## Web search (`server/search`)

All searches go through one service, `SearchService` in `router.ts`. Nothing else calls a search provider.

1. **When to search: the decision engine** (`decide.ts`). Every message gets a deterministic decision before any provider is called. There is no model call and no cost. In order:
   - **Never search**, even with the Search toggle on: greetings and small talk ("Hope you're good"), arithmetic, writing and translation tasks, questions about earlier conversations or memory ("What did I tell you yesterday?"), and questions about attached documents.
   - **Deep Research**: when the Deep Research toggle is on, or the message asks for it ("conduct a comprehensive study of ..."). Not in "Only when I ask" mode unless toggled.
   - **Read a page**: when the message contains a link.
   - **Search**: when the Search toggle is on, or the message says so ("search the web for ...", "look up ...").
   - **Search automatically** (mode "Automatic", the default): only when the message needs current or verifiable facts. That covers news, prices, exchange rates, weather, scores, current office holders ("who is the president of ..."), latest versions, "latest/current/today" questions, and years at or after the model's knowledge. Programming questions such as "current directory in Python" do not count.
   - **"Whenever it may help"** mode also searches questions about named things, except plain definitions.
   - Everything else, including general knowledge, education and programming, is answered from the model.

   Users choose the mode in **Settings > Web search**: Automatic, Only when I ask, or Whenever it may help. The order of preference is conversation, memory, knowledge, documents, model, then web. Each decision is counted in `usage/{day}` under `searchDecisions.<action>` and `searchDecisions.reasons.<reason>`, by code only, never message text.

   Short follow-ups ("what about 2025?") are rewritten into a standalone query by a free utility model.
2. **Cache first** (`store.ts`):
   - Queries are normalized: case, punctuation, filler words and synonyms ("newest"/"current" → "latest", "artificial intelligence" → "ai"). The key ignores word order.
   - Lookup is in `users/{uid}/searchCache/{sha1}`, and the cache is shared across providers.
   - Lifetime depends on intent: live data (prices, weather) 1 h, news 2 h, general 24 h, reference 7 days.
   - On an exact miss, a **same-meaning** fresh entry is reused. Both conditions must hold:
     - its query embedding (free Gemini) has cosine ≥ 0.87
     - its distinctive words are identical, so "president of Ghana" never reuses "president of Nigeria"
   - Cache hits cost nothing and are shown as "from cache".
3. **De-duplication and throttling.** Identical searches in flight share one request. A user can make at most one search every 3 seconds and 10 a minute.
4. **Provider choice.** SerpAPI (Google) handles general and news questions. Tavily handles research, reference and page reading (`/extract`). The other provider is tried only when the first is over budget or fails, and a notice says so. Both are never queried for the same question.
5. **Budgets** (`config/limits.ts`, `config/limits` in Firestore). Before any request, two checks run:
   - the app's own per-provider daily and monthly counters (`usage/{day}`, `usage/m-{yyyy-mm}`, field `search.<provider>`)
   - the provider's own reported remaining quota (SerpAPI `account.json`, Tavily `/usage`, both free to call and cached for 10 minutes)

   Automatic searches cannot use the last `autoReserve` (default 2) daily credits per provider; those are kept for searches the user asks for. When everything is exhausted, the user is told and the chat continues without search. There is no switch to any other paid provider. A quota error marks the provider exhausted, so it isn't retried.
6. **Deep Research** (`research.ts`):
   1. A free model plans up to N sub-queries.
   2. Each sub-query goes through the same router within the run budget.
   3. Tavily reads the top pages.
   4. The model writes a structured report covering summary, findings, disagreements, limitations and sources.

   Progress streams to the UI as `research` events.

Duplicate requests for the same reply (double submit, retries) are rejected with 409 while the first is running, so a re-render or resend never triggers a second model call or search.

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

Secrets: `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `SERPAPI_API_KEY` and `TAVILY_API_KEY` are read only in `server/env.ts`. They are never logged and never sent to the browser.

## Known limitations

- **No OCR.** Scanned PDFs without a text layer are flagged with a clear message.
- **Original uploaded files are not stored,** only their extracted text. Images in chats are compressed (max 1600 px) and stored inline in the message, within Firestore's 1 MiB document limit.
- **Voice input** uses the Web Speech API. It works in Safari on iOS 14.5+ and Chrome, but not in Firefox. When unavailable, the microphone button is hidden. Read-aloud uses the system voices.
- **60-second function limit** on Vercel Hobby (see `vercel.json`). Very long generations may be cut off. Partial text is saved and can be continued.
- **Vector search is in-process,** fine for one person's data (hundreds of memories, thousands of chunks). Larger scale would need Firestore vector indexes or a vector database.
- **Free models are rate-limited** by OpenRouter. With no credits on the key, paid models fall back to free ones.
- **App Check is not enabled.** It needs a reCAPTCHA Enterprise site key; add `VITE_APPCHECK_SITE_KEY` and enforcement in the console if wanted.
