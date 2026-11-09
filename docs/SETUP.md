# Setup

## Requirements

- Node.js 20 or newer (developed on Node 24)
- A Firebase project (the Spark free plan is enough)
- An OpenRouter API key
- Optional: a SerpAPI key and/or a Tavily API key for web search
- Optional: Java 11+ for the Firestore emulator (`npm run test:rules`)

## 1. Firebase console (one-time)

In the Firebase console for your project:

1. **Authentication > Sign-in method:** enable **Email/Password** and **Google**. Sign in with Apple has been removed from the app; leave the Apple provider as it is (see [DEPLOY.md](DEPLOY.md#apple-accounts)).
2. **Authentication > Settings > Authorized domains:** make sure `localhost` is listed, and add your Vercel domain (for example `your-app.vercel.app`) once you deploy.
3. **Firestore Database:** create a database in production mode, in the region closest to you.
4. **Project settings > General > Your apps:** register a Web app if there isn't one, and copy its config into the `VITE_FIREBASE_*` variables below.

Firebase Storage and Cloud Functions are **not** used, so the Blaze plan is not needed.

## 2. Environment variables

Copy `.env.example` to `.env.local`. It is gitignored, so never commit it.

| Variable | Where it's used | Secret? | Notes |
| --- | --- | --- | --- |
| `OPENROUTER_API_KEY` | server | **yes** | Required. Free-tier keys work with `:free` models only. |
| `GEMINI_API_KEY` | server | **yes** | Recommended. Google AI Studio key. Gemini is the primary provider: it becomes the default model (`gemini:gemini-3.5-flash`), with Gemini embeddings and Flash-Lite for background tasks. Without it, Atlas AI runs on OpenRouter alone. Each Gemini model has its own free-tier quota, separate from OpenRouter's. |
| `GEMINI_BILLING` | server | no | Optional. `paid` if the Google project has billing; then no Gemini model is used (free models only). Default: Free Tier models only. |
| `SERPAPI_API_KEY` | server | **yes** | Optional. Google results via SerpAPI: general and news searches. |
| `TAVILY_API_KEY` | server | **yes** | Optional. Research searches, page reading, Deep Research. |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | server | **yes** | Optional. Cloudflare Workers AI: image creation and editing, and the Cloudflare chat models. The token needs only the **Workers AI** permission. Never use a `VITE_` prefix. Without them, image requests are answered as unavailable. |
| `CLOUDFLARE_IMAGE_MODEL` | server | no | Optional. Image model id; default `@cf/black-forest-labs/flux-2-klein-4b`. |
| `APP_URL` | server | no | Public app URL, sent to OpenRouter as the referer. |
| `FIREBASE_PROJECT_ID` | server | no | Used to verify ID tokens and call Firestore. |
| `ADMIN_EMAILS` | server | no | Optional, comma separated. Defaults to the owner email. Keep in sync with `firebase/firestore.rules`. |
| `DEFAULT_MODEL`, `FALLBACK_MODELS`, `UTILITY_MODELS`, `EMBEDDING_MODELS` | server | no | Optional overrides, comma-separated model IDs. Defaults are in `server/config/models.ts`. |
| `FIREBASE_SERVICE_ACCOUNT` | server | **yes** | Required for phone verification, SMS password recovery, account security events, the admin **Users** page (suspend, delete, restore) and signing out all sessions. Service account JSON (raw or base64) from Firebase **Project settings > Service accounts > Generate new private key**. Never commit the file; paste it into `.env.local` / Vercel and delete the download. Without it these features report that they are not configured; chat keeps working. |
| `CRON_SECRET` | server | **yes** | 16+ random characters. Vercel Cron sends it to `/api/admin?job=purge` daily to permanently delete accounts whose 30-day recovery period has ended. |
| `OTP_HMAC_SECRET` | server | **yes** | Required for phone verification. 32+ random bytes, e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Codes are stored only as HMACs with this key. |
| `SMS_PROVIDER` | server | no | `vynfy` (default). New providers implement `SmsProvider` in `server/sms/provider.ts`. |
| `VYNFY_API_KEY`, `VYNFY_SENDER_ID` | server | key: **yes** | Vynfy SMS (Ghana). The sender ID must be approved in Vynfy **and accepted by the networks**: test delivery to a real phone after changing it (NEXORA was listed as approved but was not delivered to MTN; ATLAS is delivered). |
| `VYNFY_SANDBOX` | server | no | `1` sends to Vynfy's sandbox: nothing is delivered or charged. Use it for testing. |
| `VYNFY_OTP` | server | no | `1` (default): verification codes are generated, texted and checked by Vynfy's OTP service (`/otp/generate`, `/otp/verify`); the app never sees the code. `0`: app codes (HMAC-stored) sent as ordinary SMS. The OTP service uses a separate balance in the Vynfy dashboard. |
| `VYNFY_OTP_LENGTH`, `VYNFY_OTP_EXPIRY` | server | no | Code length 4-8 (default 6) and lifetime 1-60 minutes (default 5). |
| `VYNFY_OTP_FALLBACK` | server | no | `1` (default): when the OTP balance is empty, fall back to an app code sent as ordinary SMS. `0` disables. |
| `VYNFY_WEBHOOK_SECRET` | server | no | Secret for Vynfy delivery webhooks (HMAC-SHA256, `X-Webhook-Signature`). Set the same secret and the URL `https://<domain>/api/phone?webhook=vynfy` in the Vynfy dashboard. Without it, delivery reports are fetched from Vynfy's status endpoint instead. Webhooks cover ordinary SMS only; Vynfy's OTP service publishes no delivery reports. |
| `OTP_DAILY_CAP` | server | no | App-wide maximum verification texts per day (default 200). |
| `VITE_FIREBASE_AUTH_DOMAIN` | browser | no | `ai-app-6efa7.firebaseapp.com`, or `auto` in production to serve sign-in from the app's own domain (needed for reliable Google/Apple sign-in in Safari and installed apps; see DEPLOY.md). |
| `VITE_FIREBASE_*` | browser | no | Firebase web config, public by design. |

## 3. Security rules and indexes

The app needs the rules in `firebase/firestore.rules` and the indexes in `firebase/firestore.indexes.json`. Deploying them changes your live project, so check the files first, then run:

```bash
npx firebase login
npx firebase deploy --only firestore:rules,firestore:indexes --project <your-project-id>
```

Index builds can take a few minutes. Until they finish, the Project page and the saved-conversations list show an index error.

## 4. Access control

Atlas AI is private. A user can use it only if their **email is verified** and it is either:

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
