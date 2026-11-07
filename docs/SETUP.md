# Setup

## Requirements

- Node.js 20 or newer (developed on Node 24)
- A Firebase project (the Spark free plan is enough)
- An OpenRouter API key
- Optional: a SerpAPI key and/or a Tavily API key for web search
- Optional: Java 11+ for the Firestore emulator (`npm run test:rules`)

## 1. Firebase console (one-time)

In the Firebase console for your project:

1. **Authentication > Sign-in method:** enable **Email/Password** and **Google**.
2. **Authentication > Settings > Authorized domains:** make sure `localhost` is listed, and add your Vercel domain (for example `your-app.vercel.app`) once you deploy.
3. **Firestore Database:** create a database in production mode, in the region closest to you.
4. **Project settings > General > Your apps:** register a Web app if there isn't one, and copy its config into the `VITE_FIREBASE_*` variables below.

Firebase Storage and Cloud Functions are **not** used, so the Blaze plan is not needed.

## 2. Environment variables

Copy `.env.example` to `.env.local`. It is gitignored, so never commit it.

| Variable | Where it's used | Secret? | Notes |
| --- | --- | --- | --- |
| `OPENROUTER_API_KEY` | server | **yes** | Required. Free-tier keys work with `:free` models only. |
| `GEMINI_API_KEY` | server | **yes** | Optional. Google AI Studio key. Adds Gemini models (`gemini:<model>`), Gemini embeddings and Flash-Lite for background tasks. Each Gemini model has its own free-tier quota, separate from OpenRouter's. |
| `GEMINI_BILLING` | server | no | Optional. `paid` if the Google project has billing; then Gemini models are treated as paid and need approval. Default: free tier. |
| `SERPAPI_API_KEY` | server | **yes** | Optional. Google results via SerpAPI: general and news searches. |
| `TAVILY_API_KEY` | server | **yes** | Optional. Research searches, page reading, Deep Research. |
| `APP_URL` | server | no | Public app URL, sent to OpenRouter as the referer. |
| `FIREBASE_PROJECT_ID` | server | no | Used to verify ID tokens and call Firestore. |
| `ADMIN_EMAILS` | server | no | Optional, comma separated. Defaults to the owner email. Keep in sync with `firebase/firestore.rules`. |
| `DEFAULT_MODEL`, `FALLBACK_MODELS`, `UTILITY_MODELS`, `EMBEDDING_MODELS` | server | no | Optional overrides, comma-separated model IDs. Defaults are in `server/config/models.ts`. |
| `VITE_FIREBASE_*` | browser | no | Firebase web config, public by design. |

## 3. Security rules and indexes

The app needs the rules in `firebase/firestore.rules` and the indexes in `firebase/firestore.indexes.json`. Deploying them changes your live project, so check the files first, then run:

```bash
npx firebase login
npx firebase deploy --only firestore:rules,firestore:indexes --project <your-project-id>
```

Index builds can take a few minutes. Until they finish, the Project page and the saved-conversations list show an index error.

## 4. Access control

Tessera is private. A user can use it only if their **email is verified** and it is either:

- a bootstrap admin, hard-coded in `firestore.rules` (`isBootstrapAdmin`), in `src/state/auth.tsx` (`BOOTSTRAP_ADMINS`), and in the `ADMIN_EMAILS` default; or
- listed in the Firestore document `config/access` (`allowedEmails` or `adminEmails`).

An admin manages the lists in **Settings > Access**. That screen can also turn the registration page on (`config/public.registrationOpen`). New accounts still need to be allow-listed before they can do anything.

To change the owner email, update the three places above, then redeploy the rules.

## 5. Run locally

```bash
npm install
npm run dev
```

The Vite dev server also serves the `/api/*` functions through `dev/api-plugin.ts`, so no extra process is needed. Sign in with the owner account. Email/password accounts must verify their email first.

## Tests

```bash
npm run check          # lint, typecheck, unit tests, build
npm run test:rules     # starts the Firestore emulator with a demo project; never touches live data
npm run build && npm run test:e2e   # WebKit iPhone viewports (first time: npx playwright install webkit)
```

`dev/smoke.ts` sends one real streamed request to the default model and prints the result, without printing the key:

```bash
npx tsx --env-file=.env.local dev/smoke.ts
```

`dev/smoke-search.ts` checks the search router against the real providers with an in-memory store, so it never touches Firestore. It costs about 2 SerpAPI searches and 3 Tavily credits:

```bash
npx tsx --env-file=.env.local dev/smoke-search.ts
```
