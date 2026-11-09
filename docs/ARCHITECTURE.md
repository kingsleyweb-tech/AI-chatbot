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
2. Load the user's settings, conversation, project and model catalog. Build the **fallback chain**: requested model first, then configured fallbacks. Only free models are kept (Free Models Only policy), and non-vision models are skipped when images are attached.
3. Gather context in parallel: relevant memories, related past conversations, attached-document excerpts and web results.
4. Build the system prompt (`server/chat/prompt.ts`) and trim history to the model's context budget.
5. Stream from the provider and re-emit normalized SSE events: `start`, `notice`, `sources`, `context`, `reasoning`, `delta`, `usage`, `error`, `done`. If a model fails **before** producing text (rate limit, unavailable, empty answer), the next model in the chain is tried and the UI shows a notice.
6. Persist the assistant message (see **Message persistence** below), plus usage counters.
7. After the response, in the background via `waitUntil`: generate a title, extract memories, and update the conversation summary.

The browser keeps live replies in a module-level store (`src/features/chat/engine.ts`). Navigating away doesn't interrupt a stream, and **Stop** aborts the fetch, which aborts the upstream request.

### Message persistence

Each message is its own document (`…/messages/{mid}`); nothing is ever rewritten as an array, so a new message can't overwrite an earlier one.

1. The browser stores the **user message** (`addUserMessage`) before it calls `/api/chat`. A failed reply never loses the question.
2. The server creates the **reply document** right away, with status `processing` and an ID chosen by the browser (`assistantMessageId`). A retry reuses that ID, so it replaces the failed reply instead of adding a second one.
3. When generation ends, the server writes the final content with status `complete`, `stopped` (interrupted, partial text kept) or `error`. It does this **before** closing the response stream, inside the `waitUntil` job, and retries once. It then sends a final `saved` event. (Before this fix the write ran after the stream closed and outside `waitUntil`; Vercel froze the function, the write timed out, and replies vanished when the next message replaced the live copy.)
4. If the browser doesn't get `saved: true`, it stores the reply itself (`saveAssistantFallback`). This backup is a transaction that writes only while the stored reply is missing or still `processing`, and only if the conversation still exists. It never overwrites a finished server copy or brings back a deleted conversation. When offline, it waits for the connection.
5. If `/api/chat` can't be reached at all (dropped connection before the request got through), the browser retries once with the same reply ID. The server refuses a second run of a reply it's still generating (`duplicate_request`), so a retry can't produce two replies.
6. The browser keeps every live reply (up to 20 per conversation, keyed by ID) until its stored copy arrives, so a new message never hides an earlier reply.
7. A reply still `processing` after 2 minutes (longer than a function may run) shows as interrupted, with Retry. A trailing user message without a reply offers **Generate response**.
8. A reply for a conversation deleted meanwhile is dropped (the precondition `exists: true` on the conversation fails), so deletion stays final.

The user message is written to the local Firestore cache first, so a new conversation opens and shows the message immediately, even on a slow connection ("Sending…" until the server confirms). The reply is requested only after that confirmation. A new conversation's ID is created at send time.

Signed-in persistence is tested end to end against the Firebase emulators with a scripted AI (`dev/fakeAi.ts`, dev server only): `e2e-emulator/` and `playwright.emulator.config.ts`, which describes the setup.

## Providers and model routing (`server/providers`, `server/router`)

- **Providers.** Google Gemini (`gemini:<model>`, AI Studio key) is the **primary** provider. OpenRouter (default prefix) is the **secondary**. Both implement one `ChatProvider` interface and are registered in `server/providers/registry.ts`. One catalog, one router and one conversation engine serve both, so history, memory, documents and settings are shared.
- **Default model.** `gemini:gemini-3.8-flash` when `GEMINI_API_KEY` is set. An admin can set another app default in `config/ai`, and a user's own default or per-chat choice always wins. Atlas AI never changes a user's chosen model.
- **Routing** (`server/router/route.ts`):
  - `detectTask` reads the request without a model call: images, document types, intent and a token estimate.
  - `routeModel` keeps the selected model when it fits. Otherwise it uses the best free model for the task, for that reply only. Ranking: preferred provider first (`config/ai.preferredProvider`, default Gemini), then the task preference list, then featured models, then context size.
  - If no free model fits, the reply explains that no free model can handle it. Paid models are never used or offered, and a paid model id sent by the client (even as `approvedPaidModel`) is ignored.
- **Fallbacks** (`nextInChain`):
  - Each model is tried once, only before any text has streamed, and only for recoverable errors: busy, rate limited, timeout, outage, model unavailable.
  - Errors that affect a whole provider (a rejected key, OpenRouter's free daily cap) skip straight to the other provider.
  - Bad requests, content blocks and context-too-long errors never fall back.
  - Each switch is shown as a notice ("Switching to Google Gemini ... for this reply only").
  - Admins can limit fallback to the same provider, or turn it off (`config/ai.fallback`).
- **Admin AI settings** (`config/ai`, Settings > Models, admins only): preferred provider, app default model, fallback policy. These are validated by `normalizeAiConfig` and the Firestore rules, and cached for 5 minutes on the server.
- **Free Models Only policy** (`server/billing/policy.ts`). Atlas AI never spends money on AI:
  - The provider registry wraps every provider, so every stream, completion and embedding (chat, fallbacks, titles, memory, summaries, knowledge) is checked before a request leaves the server. A refused model raises `paid_blocked`.
  - Free means: Gemini models listed as "Free of charge" on Google's Free Tier (`GEMINI_FREE_TIER`, checked against the official pricing page in November 2026; `gemini-3.5-flash` and `gemini-3.1-pro-preview` are not on it); OpenRouter `vendor/model:free` variants only (no routers, no paid embeddings); the curated Cloudflare models, inside the free daily Neuron allowance only; ElevenLabs within the subscription's included credits only.
  - The catalog lists only allowed models (`paidAvailable` is always false). Background jobs never run on Cloudflare, since they make no Neuron reservation.
  - When every free model fails with a limit error (rate limit, daily cap, no credits, refused), the user sees "Atlas AI's free AI usage limit has been reached for now. Please try again later." (`free_limit`).
  - Administrators can narrow the allowed list in Settings > Models ("Admin: Free models only", `api/admin` `billingGet`/`billingSet`, stored server-only in `config/billing`, logged as `billing_policy_changed`). The server refuses any id that is not free, so the list can never include a paid model.
  - Not visible to the app, so keep them yourself: billing disabled on the Google project, and the Cloudflare account on the Workers Free plan.
- **Analytics** in `usage/{day}`:
  - `providers.<id>.requests/tokens/failed/rateLimited`
  - `routing.fallbacks`, `routing.providerSwitches`, `routing.switched`
- **OpenRouter free daily cap.** Accounts without purchased credits get 50 free-model requests per day. The cap is read from OpenRouter's key info, or learned from the first `free-models-per-day` 429. Free OpenRouter models are then marked unavailable until midnight UTC, and requests go to Gemini.
- **Gemini.** It uses Free Tier models only (no billing on the Google project; with `GEMINI_BILLING=paid` no Gemini model is used at all). Short background calls disable thinking, so it cannot use up their small output budget. Embeddings use `gemini-embedding-001` (768 dimensions). Usage is counted per provider in `usage/{day}.providers.<id>`.
- **Cloudflare Workers AI** (`server/providers/cloudflare.ts`, `server/cloudflare/client.ts`) is an additional provider:
  - It offers five curated chat models (`CLOUDFLARE_CHAT_MODELS`: Gemma 4 26B, gpt-oss-120b, Llama 4 Scout, Mistral Small 3.1, Qwen2.5 Coder), used **only when the user selects one**.
  - `routeModel` never picks a `cloudflare` model automatically and never uses one as a fallback; Gemini and OpenRouter remain the chain.
  - Requests go to the OpenAI-compatible endpoint `.../accounts/{id}/ai/v1/chat/completions` with the token in the `Authorization` header only.
  - Errors are mapped by `mapCloudflareError`. The free daily allocation (code 4006) is remembered until 00:00 UTC and marks the models unavailable.

## Images (`server/images`, `src/features/images`)

1. **Intent** (`intent.ts`): `detectImageIntent` runs on every message when Cloudflare is configured.
   - It recognises direct requests ("Generate an image of ...", "Design a poster ..."), edits of an attached image, and follow-up edits of the image just created ("make it more realistic").
   - It ignores questions about images ("Which AI model is best for generating images?"), how-to questions and text tasks ("Create a React component").
2. **Budget** (`server/cloudflare/budget.ts`). Before any Cloudflare call:
   - one active image request per user, at least 8 s between requests, and `config/limits.images.perUserDaily` (default 10)
   - an app-wide reservation against `cloudflareUsage/{yyyy-mm-dd}`, capped at `images.appDailyNeurons` (default 9,000; at most 9,500 of the free 10,000)
   - It fails closed when the usage counter cannot be read. Text calls to Cloudflare chat models reserve 60 Neurons the same way.
   - Actual cost comes from the `cf-ai-neurons` header and is recorded per type, model and error in `cloudflareUsage/{day}` and in the user's `usage/{day}` (`providers.cloudflare.*`, `images.generated/edited/failed`).
3. **Safety** (`safety.ts`): deterministic rules first (sexual content, minors, deepfakes and face swaps of real people, forged documents and money, brand impersonation), then `@cf/meta/llama-guard-3-8b`. A failed or unreadable check refuses (fail closed).
4. **Generation** (`generate.ts`, `server/config/images.ts`):
   - Model: `@cf/black-forest-labs/flux-2-klein-4b`, multipart with `prompt`, `width` and `height` (aspect from the request: square 1024x1024, landscape 1344x768, portrait 768x1344).
   - An edit adds `input_image_0` (the attachment, or the previous image loaded from Firestore) and keeps the source's shape.
   - `CLOUDFLARE_IMAGE_MODEL` can switch to `flux-1-schnell` (generation only).
5. **Storage** (`store.ts`):
   - Metadata goes to `users/{uid}/generatedImages/{img_<messageId>}`. Bytes go to `users/{uid}/generatedImageData/{id}_{n}` as Firestore bytes, in chunks of at most 900,000 bytes.
   - Everything is written by the server in one commit, metadata last. No base64 is stored in message documents; the message stores only `images[]` metadata.
   - The id is derived from the message id, so a retried reply reuses the stored image: no second generation, no duplicate.
   - If storing fails, the image is still streamed to the browser (`image` event with a data URL) so it can be downloaded, and the reply says it was not saved.
6. **Client**:
   - `GeneratedImage` shows the image at its real aspect ratio, with a skeleton while loading and Retry on error.
   - **Download** builds a Blob of the original bytes and saves it as `atlas-image-YYYYMMDD-HHMM-<prompt>.jpg|png`. On iPhone/iPad it uses the share sheet with the file (Save Image / Save to Files), so the image is saved rather than opened in a tab.
   - `/images` is the gallery: newest first, lazy loading, prompt, Download, open the conversation, and delete.
   - Deleting a conversation deletes its images (`api/memory.ts`); the account purge deletes both collections.

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

Four layers, assembled per request in `server/chat/engine.ts`. All of it works the same whichever provider (Gemini or OpenRouter) answers, because only the prompt changes.

1. **Structured memories** (`memories/{id}`): after each exchange a utility model returns `add`/`update`/`delete` operations with category, importance (1 to 5), reason and, when it concerns one project, a project key. Near-duplicates (cosine at least 0.9) become updates; contradictions update the older memory. At query time, general instructions and preferences with importance 3 or more are always included, the focused project's memories are included, and the rest are ranked by similarity (all included when there are 25 or fewer). Memories of other projects are never included.
2. **Project memory** (`projectMemory/{p_slug}`): a brief per named project (description, aliases, stack, architecture, progress, decisions, bugs, tasks, conversations), updated in the background. The focus project is detected from the message (name or alias), the linked Atlas project, a semantic match (at least 0.72) or the conversation's `projectKey`, in that order.
3. **Conversation history index** (`convIndex/s0000...` shards of 120 entries plus `meta`): every exchange is stored as a short excerpt with an int8-packed embedding and project tag. Retrieval fuses keyword and semantic ranking (reciprocal rank fusion), keeps at most two excerpts per conversation, filters by the focus project, and skips turns already in the context window. This answers questions like "what did we decide about Project Alpha?" from older chats.
4. **Rolling summary** (`historySummary` on the conversation): turns older than the last 16 are folded into a summary that keeps instructions, decisions and open tasks. This runs even when memory is off, since it only concerns the current chat.

Users manage all of this in **Memory** (tabs for memories, projects and conversations) and can turn memory off. Deleting a conversation (`/api/memory` `deleteConversation`) removes its messages, summary vector, index entries and the automatic memories learned from it, and rebuilds or removes project briefs that used it; manual memories and saved responses are kept.

## Documents (`server/docs`)

Text is split into about 3,200-character chunks with 400-character overlap, preferring paragraph and sentence boundaries. Each chunk is embedded and stored under `documents/{id}/chunks`. At question time, a document small enough for the budget is included whole. Otherwise the top-ranked chunks are included with their page, sheet or slide reference, and the model cites them as `[D1]`.

## Firestore data model

All user data is under `users/{uid}`:

| Path | Contents |
| --- | --- |
| `users/{uid}` | `email`, `displayName`, `settings` (theme, accent, defaultModel, customInstructions, aboutMe, style, tone, level, language, memoryEnabled, webSearchDefault, sendOnEnter, voiceName) |
| `…/conversations/{cid}` | `title`, `projectId`, `saved`, `model`, `lastModel`, `documentIds[]`, `messageCount`, `summary`, timestamps |
| `…/conversations/{cid}/messages/{mid}` | `role`, `content`, `attachments[]` (compressed images, document references), `model`, `status`, `sources[]`, `usage`, `reasoning`, `error` |
| `…/memories/{id}` | `text`, `category`, `importance`, `project`, `reason`, `active`, `origin`, `sourceConversationId`, `sourceTitle` |
| `…/projectMemory/{p_slug}` | project brief (server-written) |
| `…/convIndex/{shard}` | conversation history excerpts and packed embeddings (server-written) |
| `…/securityEvents/{id}` | `type`, `at`, `device`, `provider`, `by`, `detail` (server-written, owner read-only) |
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
| `.../generatedImages/{id}` | created image metadata: `uid`, `conversationId`, `messageId`, `prompt`, `model`, `kind` (generate/edit), `sourceImageId`, `mime`, `width`, `height`, `bytes`, `chunks`, `storage`, `status`, `createdAt` (server-written; owner read/delete) |
| `.../generatedImageData/{id}_{n}` | image bytes, at most 900,000 per document (server-written; owner read/delete) |
| `config/limits` | search budgets, Deep Research budget, cache lifetimes, `images.perUserDaily` / `images.appDailyNeurons` (approved read, admin-write) |
| `cloudflareUsage/{yyyy-mm-dd}` | app-wide Workers AI Neurons and requests per type, model and error (server only) |
| `adminLogs/{id}` | administrator actions (server-written, admin read-only) |
| `recovery/{id}`, `otpRecovery/{uid}`, `rateLimits/{key}` | password-recovery state and counters (server only, no client access) |

## Knowledge base (`server/knowledge`, `src/features/knowledge`)

- Personal base under `users/{uid}` and a shared base under `kb/shared` (approved users read, admins write): `kbCollections/{id}`, `kbSources/{id}` with `chunks/{n}` and a packed `index/{n}`.
- Sources: files (text extracted in the browser), web pages (fetched by the server, or through Tavily), and typed notes. URL sources can refresh on a schedule.
- Retrieval is hybrid: BM25 keyword scoring plus cosine similarity over int8-quantised embeddings, merged with reciprocal rank fusion. Confidential sources are keyword-only and are sent to an AI provider only when the owner allows it per source.
- Answers cite knowledge excerpts as `[K#]`. Vector search runs in-process, which is fine at personal scale (thousands of chunks); a vector database would only pay off far beyond that.

## Authentication (`src/state/auth.tsx`, `src/lib/authProviders.ts`, `api/phone.ts`)

- Sign-in: Google and email/password (Firebase Auth). Apple was removed from the UI; existing `apple.com` accounts are still recognised by the server. Popups in the browser; a full-page redirect in installed apps or when a popup is blocked, completed by `getRedirectResult` at start-up. `onAuthStateChanged` is the only source of truth; access checks run with a sequence guard, and the UI shows a loading state (never the login form) while they run.
- Access states: `loading`, `signed-out`, `phone` (password account without a verified phone), `unverified` (email), `denied`, `error` (with retry), `allowed`. Flow for email sign-ups: register, verify phone, verify email, approval check, app.
- **Phone verification** (password accounts only): `/api/phone` sends a 6-digit code (crypto random, 5-minute expiry, single use) through a swappable `SmsProvider` (Vynfy). Codes are stored only as HMACs in server-only `otp/{uid}`; limits are 60 s between sends, 5 per hour and 10 per day per account and per number, an app-wide daily cap, and 5 attempts per code counted with optimistic concurrency. `phoneNumbers/{hash}` keeps one account per number. On success the server sets the `phoneVerified` custom claim (service account) and writes `phoneNumber`, `phoneVerified`, `phoneVerifiedAt` to the profile.
- Enforcement is server-side: the Firestore rules' `verified()` and every API (`requireAllowedUser`) reject password sign-ins without the claim. Only allowlisted accounts can trigger texts.
- Profiles (`users/{uid}`) hold `uid`, `email`, `displayName`, `photoURL`, `provider`, `emailVerified`, `accountCreatedAt`, `lastLoginAt` and the server-written phone fields and `accountStatus`. Name and photo are filled in, never overwritten. One Firebase account per email prevents duplicate profiles; a sign-in with a different provider for an existing email shows how to sign in instead.

## Transactional email (`server/email`, `server/auth/emailCode.ts`, `server/account/devices.ts`)

- **Provider abstraction** (`server/email/provider.ts`): the app calls an `EmailProvider`. Brevo's HTTP API is the one implemented (`BREVO_API_KEY`, server-only). Temporary failures (network, 429, 5xx) are retried up to 3 times. A second provider only needs `send` and a case in `getEmailProvider`.
- **One send path** (`server/email/service.ts`): `sendEmail()` never throws, so email trouble never breaks sign-in, reset or verification. It checks, in order:
  - the person's `users/{uid}.emailPrefs`, for optional categories only
  - a de-duplication key (`emailDedupe`)
  - a per-address limit for notifications (6 per hour)
  - an app-wide daily cap (`emailStats/{day}`, `EMAIL_DAILY_CAP`)
- **Templates** (`server/email/templates.ts`): table-based HTML plus plain text, with the logo (`/pwa-192.png` on `PUBLIC_APP_URL`) and the Atlas AI name, in deep teal and cyan. Every value is escaped.
- **Log** (`emailLog`, server-only): type, masked recipient, provider message id and status. It never holds the subject, body, code or full address.
  - *Accepted* means Brevo took the email.
  - *Delivered*, *bounced*, *blocked* and *deferred* come only from Brevo's event API, which is polled when an administrator opens Admin > Email.
- **Email codes** (`emailCodes/{uid}_{purpose}`):
  - 6 digits from `crypto.randomInt`, stored as an HMAC
  - valid for 10 minutes, single use, 5 attempts; the newest code replaces older ones
  - 60 s between sends, at most 5 per hour and 10 per day
  - `verify_email` marks the Firebase account verified through the admin API. Firebase's own verification email is not used.
  - `sensitive` gives a 10-minute step-up (`hasRecentStepUp`). No operation requires it yet.
- **Sign-in with a phone number** (`server/auth/phoneLogin.ts`, `api/recovery` action `phoneLogin`): the sign-in field takes an email or a phone number. For a number, the server finds the account that verified it (`phoneNumbers/{hash}`), checks the password with Firebase Auth, and only then returns that account's email; the browser then signs in with email and password as usual. Unknown, unverified or Google-only numbers and wrong passwords all get the same answer, padded to a similar response time. Limits: 10 attempts per number and 30 per client per hour; wrong passwords count towards the failed sign-in alert.
- **Password recovery** (`server/auth/recovery.ts`): the same flow sends the code by email (an email/password account with a **verified** address) or by SMS (verified phone). Responses and limits are uniform for both. An email code is also texted to the account's verified phone, if any (same per-number limit and daily SMS cap), so either message works. Email verification codes are never texted: they must prove the address itself. An SMS reset also emails the owner, and every reset sends a password-changed email.
- **New-device alerts** (`users/{uid}/devices`, server-only):
  - Checked once per sign-in session (new `auth_time`), never on token refresh.
  - The browser sends a random `x-atlas-device` id and its time zone.
  - Every new sign-in session sends an alert that says whether the device is recognised, except the sign-in right after registering. A new device in a country the account hasn't used before is reported as an unusual sign-in.
  - Location comes from Vercel's IP headers, and the IP is shown only partly (`102.176.x.x`).
- **Other notices:**
  - 5 failed password attempts in an hour (reported by the sign-in page)
  - password changed
  - phone number changed or removed
  - sign-in method added
  - signed out everywhere
  - device removed
  - a welcome email, sent once to new accounts that are approved and verified
- **Support updates** (`server/support/notifyOut.ts`): after an administrator replies or changes a report's status, the owner gets an email (category `support`). "Resolved" and "we need more information" also send a text to a verified phone (`supportSms` preference), limited to 2 per report and 5 per person per 24 hours and `SMS_NOTIFY_DAILY_CAP` per day for the app. Texts never contain the report's content; they are logged in `smsLog` with purpose `support`.
- **Approval notice** (`server/account/notices.ts`): when an administrator approves an account (single, from a request, or "approve all"), the person gets an email (`access_approved`) and a text to a verified phone (purpose `approval`, counted under `SMS_NOTIFY_DAILY_CAP`). Email/password sign-ups file their access request automatically right after the phone code (`api/phone.ts`); with automatic approval on, nothing is filed and they go straight to the app.
- **Admin › Messages** (`server/account/messages.ts`, `src/features/admin/MessagesPage.tsx`): administrators send a text and/or an email to all active users, approved users, users waiting for approval, chosen people, or themselves as a test, and keep up to 40 templates in `config/messageTemplates`. Emails go only to verified addresses and texts only to verified numbers, both respecting the person's Announcements switch; `{name}` becomes the first name. At most 300 people per send; texts are limited to `SMS_MESSAGE_DAILY_CAP` per day (default 100) and every send is recorded in `adminMessages` (counts only) and the administrator log.
- **Only verified addresses get mail**: alerts, support updates and reset codes are never sent to an unverified address (it could belong to someone else after a typo). The verification code is the only exception.
- **Verifying later**: an email/password account (which always has a verified phone) may choose "Skip for now" on the email step after sign-up. It can use the app, but:
  - administrator and allowlist entries match only verified addresses (`decideAccess`, and `verified()` in the rules);
  - changing or removing the phone number, the `sensitive` step-up and email recovery need a verified email on the server (`requireVerifiedEmail`); password changes, adding sign-in methods and data export are locked in the interface;
  - a reminder (`EmailReminder`) shows at most once per session, then waits 1 day after the sign-up skip, 3 days after the next skips and a week from the third (`users/{uid}.emailReminderNextAt`, `emailReminderSkips`).
- **Rules**: `member()` (verified email or the server-set `phoneVerified` claim) gives an approved account access; every new collection is server-only through the default deny and the users catch-all.

## Terms and Privacy acceptance (`server/shared/legal.ts`, `server/account/consent.ts`)

- Current versions: Terms of Use **1.2**, Privacy Policy **1.2** (published 8 November 2026; acceptances of 1.0 and 1.1 stay in the history) (`TERMS_VERSION`, `PRIVACY_VERSION`). The Firestore rules' `consentOk()` repeats them, so **change both places together** when a document changes; everyone is then asked again.
- Order for every sign-in method (Google, email/password): authentication, then phone (password accounts) and email checks, then **consent**, then approval. Consent never overrides a rejection, suspension or deletion.
- `/consent` ("Before you continue") shows links to both documents and an unticked checkbox; Continue stays disabled until it is ticked. Registration has the same checkbox and records acceptance straight after the account is created.
- `/api/account` `acceptTerms` records `users/{uid}.consent = {termsVersion, privacyVersion, acceptedAt (server time), method}` and a history entry in `users/{uid}/consents/{id}` (`userId`, `termsAccepted`, `privacyAccepted`, versions, method, server time), plus a `terms_accepted` security event. Clients cannot write either (server-only key, no client rule).
- Enforcement: `decideAccess` returns `consent`, `requireAllowedUser` answers `consent_required` (the client then re-checks and opens `/consent`), and the rules' `isAllowed()`/`isAdmin()` require current consent. The consent and legal pages stay public.
- Admin users page: accepted or not, versions, date and method.

## Automatic approval (`config/approval`, `api/admin.ts`)

- Toggle on the Access Requests page. Stored in `config/approval` `{autoApprove, updatedAt, updatedBy}`: admins can read it, only the admin API writes it, and every change is logged (`auto_approve_changed`, previous and new value).
- When on, a **new** profile is created already approved (`approvedBy: 'auto'`) in the same write by `ensureProfile` (precondition: the profile does not exist, so concurrent sign-ins cannot create two). Logged as `user_auto_approved`. Password accounts still have to verify their phone.
- Never applied to existing accounts, to rejected, suspended or deleted accounts, or to an email whose earlier request was rejected. Waiting requests are approved only with "Approve all pending" (confirmation, logged as `pending_bulk_approved`).
- Sign-in round trips: the `access` call reads config, approval setting, profile and request in parallel, creates the profile if needed and does the login bookkeeping (login fields and event) itself, so the browser no longer reads the profile or sends a separate `session` call.

## Phone reminder (`src/features/shell/PhoneReminder.tsx`)

- "Secure your account" for signed-in people without a verified number: country selector, number, Continue, Skip for now. Uses the same `/api/phone` send and verify as Settings (`PhoneVerifyFlow`); nothing is saved until the server has checked the code.
- At most once per browser session, after the first screen settles, never over another dialog, never on the auth pages or the phone settings page. Skip stores `phoneReminderDismissedAt` and `phoneReminderNextAt` (+14 days) on the profile. A verified number stops it; removing the number clears `phoneReminderNextAt`, so it can show again.
- This is account recovery and security, not two-step sign-in.

## Client monitoring (`src/lib/monitor.ts`)

Uncaught errors, failed API calls (5xx and network errors) and API calls slower than 10 s are reported to `/api/account` `clientReport`, which writes one line to the server log (Vercel runtime logs). Messages are scrubbed of emails, numbers, query strings and tokens on both sides; prompts, message text and request bodies are never sent. At most 8 reports per page load, duplicates dropped.

## Analytics consent (`src/lib/analyticsConsent.ts`, `src/components/AnalyticsConsent.tsx`)

- Google Analytics is never loaded until the visitor chooses **Allow analytics** in the banner (bottom of every page, including signed-out pages, until a choice is made; not a modal). Decline and Allow have the same weight.
- The choice is stored per browser in `localStorage` (`atlas.analyticsConsent` = `granted` | `denied`); nothing is sent to the server. It can be changed in Settings → Security → Usage analytics and on the Privacy Policy page.
- Withdrawing calls `setAnalyticsCollectionEnabled(false)` and deletes the `_ga`, `_ga_*` and `_gid` cookies. Essential storage (sign-in session, preferences, offline copy) is not covered by the choice and is listed in the Privacy Policy.
- `e2e/consent-banner.spec.ts` checks that no Google Analytics request is made before a choice or after declining.

## Retention after permanent deletion (`server/account/retention.ts`)

The daily cron (`/api/admin?job=purge`) first purges accounts whose 30-day recovery period ended, then deletes, **30 days after a purge**, the records that the purge keeps for accountability: the account's `accessRequests/{uid}` and every `adminLogs` entry whose `targetUid` is the account. The purge time is read from the `user_purged` entry's id (eventId starts with milliseconds). Accounts that exist again are skipped. Each run that deletes something logs `retention_cleanup` without personal details. Note: once an access request is gone, an earlier rejection of that email no longer blocks automatic approval.

## Security model (`firebase/firestore.rules`)

- Every read and write requires a **verified email** that is a bootstrap admin or on the allowlist, plus the `phoneVerified` claim for email/password sign-ins.
- `otp`, `otpPhones`, `otpStats` and `phoneNumbers` match no client rule, so clients can never read or write them. Clients cannot set `phoneNumber`, `phoneVerified`, `phoneVerifiedAt` or `accountStatus` on their profile.
- `users/{uid}/**` is readable and writable only by that uid. Admins cannot read other users' data.
- Message roles are restricted to `user` or `assistant`, and content and title sizes are bounded.
- `config/access` is admin-write only, with a validated shape.
- Everything else is denied.
- `config/limits` is admin-write only, with a validated shape.
- `accountActive()`: profiles with `accountStatus` `suspended` or `deleted` are refused, as are tokens issued before `sessionsValidAfter` (sign out everywhere, password reset). Clients cannot set `accountStatus`, `sessionsValidAfter`, `purgeAfter` or similar server-owned keys.
- Suspension is enforced three times: Firebase Auth (disabled account, revoked refresh tokens), these rules, and `assertAccountActive` in every API.
- Covered by `tests/rules/` (22 rules cases plus 4 end-to-end phone-verification cases, run in the Firestore and Auth emulators).

Secrets: `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `SERPAPI_API_KEY`, `TAVILY_API_KEY`, `VYNFY_API_KEY`, `OTP_HMAC_SECRET` and `FIREBASE_SERVICE_ACCOUNT` are read only in `server/env.ts`. They are never logged and never sent to the browser.

## Sessions (`src/lib/session.ts`, `src/lib/idle.ts`, `src/features/shell/SessionGuard.tsx`)

- **Sign-out** (button, inactivity, another tab, revoked session) always goes through `endSession`: it logs the event on the server (`/api/account` `signedOut`; best effort, 2.5 s cap), tells the other tabs (BroadcastChannel, with a storage-event fallback), signs out of Firebase, clears session storage and the per-session keys, clears the offline Firestore cache (IndexedDB), then does a full page load of `/login`. Stored data (conversations, projects, memory, files, preferences) is not touched.
- **Sign-in always opens New Chat.** Route guards never remember the page that was open (no `from` state), and the full reload at sign-out drops all in-memory state.
- **Route guards** (`src/App.tsx`): public pages (login, register, reset, privacy, terms); `Protected` for signed-in pages (shows the loading screen while auth and the server access check run, then routes pending, rejected, suspended, phone and email states to their pages); `AdminOnly` for `/admin/*` (only `access === 'allowed'` and the server's admin decision). The server re-checks everything: `requireAllowedUser` on every API, the admin decision for admin APIs (non-admin calls are logged as `unauthorized_access`), and the Firestore rules.
- **Website inactivity:** 60 minutes without real input (pointer, keys, touch, wheel, scroll; network activity never counts) signs out; a warning with a countdown and "Stay signed in" appears at 55 minutes. All tabs share one timestamp in localStorage, so there is one deadline. Coming back after the deadline (sleep, closed browser) signs out at once.
- **Installed app (PWA):** no inactivity sign-out. Detected with `display-mode: standalone` / `window-controls-overlay` or `navigator.standalone`, never the user agent. Account checks (suspension, revocation, approval) and explicit sign-out apply as usual. On desktop Chrome/Edge the installed app and the browser share one Firebase session, so while an installed-app window is open (heartbeat every 30 s, stale after 90 s) website tabs on that device do not sign out for inactivity either; otherwise they would sign the app out too.
- Firebase limitation: client sign-out does not revoke the ID token already issued (valid for up to an hour). "Sign out of all devices" (`revokeSessions`) revokes server-side: the server and rules reject tokens issued before `sessionsValidAfter`.

## Security headers (`vercel.json`)

CSP (scripts: self, the inline theme script by SHA-256 hash, Google sign-in and Analytics; no `unsafe-inline`/`unsafe-eval` for scripts; `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'self'`), HSTS, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options: SAMEORIGIN` and `Cross-Origin-Opener-Policy: same-origin-allow-popups` (needed for the Google popup). The proxied Firebase auth handler (`/__/auth/*`) keeps Firebase's own policy, and `frame-ancestors` is `'self'` because the app frames that handler from its own domain. **If the inline script in `index.html` changes, update its hash** (`tests/session.test.ts` fails until you do). `e2e/security.spec.ts` loads the public pages under the production CSP and fails on any violation.

## Known limitations

- **Created images use Firestore storage** (about 0.3-2 MB each, in chunks) because Firebase Storage needs the Blaze plan. Spark includes 1 GiB in total.
- **Llama Guard checks the request text only,** not an attached image that is being edited.
- **Deleting a single message keeps its image** in the gallery; deleting the conversation or the image removes it. Images that could not be stored stay available only in the open tab.
- **No OCR.** Scanned PDFs without a text layer are flagged with a clear message.
- **Original uploaded files are not stored,** only their extracted text. Images in chats are compressed (max 1600 px) and stored inline in the message, within Firestore's 1 MiB document limit.
- **Voice input** uses the Web Speech API. It works in Safari on iOS 14.5+ and Chrome, but not in Firefox. When unavailable, the microphone button is hidden. Read-aloud uses the system voices.
- **60-second function limit** on Vercel Hobby (see `vercel.json`). Very long generations may be cut off. Partial text is saved and can be continued.
- **Vector search is in-process,** fine for one person's data (hundreds of memories, thousands of chunks). Larger scale would need Firestore vector indexes or a vector database.
- **Free models are rate-limited** by every provider. When all of them are at their limit, the user is told to try again later; Atlas AI never switches to paid usage.
- **Multi-factor authentication is not offered.** Firebase MFA (SMS or TOTP second factor) needs the Identity Platform upgrade of the Firebase project. Phone verification here is a one-time check of the number, not a second factor at each sign-in.
- **App Check is not enabled.** It needs a reCAPTCHA Enterprise site key; add `VITE_APPCHECK_SITE_KEY` and enforcement in the console if wanted.
