# Atlas AI

An invitation-only AI assistant delivered as an installable, iPhone-friendly PWA. Chat across multiple models with streaming answers, long-term memory, document and knowledge-base Q&A with citations, web search with source links, Deep Research, image generation and natural voice. Accounts are protected by phone and email verification, administrator approval and live session control.

## Features

**Assistant**
- Streaming chat with automatic model routing (OpenRouter and Gemini behind one provider layer)
- Web search (SerpAPI and Tavily) with a Sources button, site logos and inline citations; news answers and Deep Research
- Long-term memory the user can review and edit
- Documents (PDF, Word, Excel and more) and a knowledge base with cited answers
- Projects, saved messages and chat search
- Image generation (Cloudflare Workers AI) with safety checks
- Voice: natural text-to-speech and a hands-free Voice Mode (ElevenLabs)

**Accounts and security**
- Email/password and Google sign-in, with phone verification by SMS code (Vynfy)
- Email verification by code, which users can postpone; sensitive actions stay locked until it is done
- Administrator approval of new accounts (or automatic approval), Terms and Privacy acceptance
- Recognised devices: alerts for sign-ins from a new device or an unusual country, and removing a device signs it out at once
- Sign out everywhere, inactivity sign-out, password recovery by SMS or email, account suspension and deletion with a 30-day restore window

**Notifications**
- Branded transactional email through Brevo: codes, sign-in alerts, security changes and support updates
- Per-user notification settings, per-account and daily limits, and a reserve that keeps codes working when the daily limit is nearly used
- Support reports with replies by email and, for key updates, SMS

**Administration**
- Users, access requests, support reports, and SMS and email delivery dashboards with usage meters
- Central knowledge with a verification pipeline and audit log

## Tech stack

| Area | Technology |
| --- | --- |
| Frontend | React 19, TypeScript, Vite, Tailwind CSS v4, Framer Motion, Lucide |
| Data and auth | Firebase Authentication, Cloud Firestore (offline cache) |
| Backend | Vercel serverless functions in `/api` (no Firebase Blaze plan needed) |
| AI | OpenRouter, Gemini, Cloudflare Workers AI, ElevenLabs |
| Search | SerpAPI, Tavily |
| Messaging | Brevo (email), Vynfy (SMS) |

## Quick start

```bash
npm install
cp .env.example .env.local      # fill in your own values; never commit this file
npm run dev                     # http://localhost:5173 (serves /api too)
```

You also need a Firebase project with Email/Password and Google sign-in enabled and a Firestore database. See [docs/SETUP.md](docs/SETUP.md) for every environment variable and the Firebase console steps.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server plus the `/api` functions |
| `npm run build` | Typecheck and production build (`dist/`) |
| `npm run typecheck` | TypeScript project references |
| `npm run lint` | ESLint |
| `npm test` | Unit tests (Vitest) |
| `npm run test:rules` | Security-rules and end-to-end account tests on the Firebase emulators (needs Java) |
| `npm run test:e2e` | Playwright smoke tests in WebKit at iPhone sizes (run `npm run build` first) |
| `npm run check` | Lint, typecheck, unit tests and build |

## Project layout

```
api/        Vercel functions: account, admin, chat, phone, recovery, speech, support…
server/     Server logic: access control, providers, search, memory, email, SMS, images
src/        React app: features/, components/, state/, lib/
firebase/   Firestore security rules
tests/      Unit tests; tests/rules runs against the Firebase emulators
docs/       Setup, deployment and architecture
```

## Deployment

A push to `main` deploys to Vercel automatically. Server secrets live only in Vercel environment variables. Firestore rules in `firebase/firestore.rules` are published separately from the Firebase console or CLI; see [docs/DEPLOY.md](docs/DEPLOY.md).

## Docs

- [docs/SETUP.md](docs/SETUP.md): local setup, environment variables, Firebase console steps
- [docs/DEPLOY.md](docs/DEPLOY.md): deploying rules and the app, installing on iPhone
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the pieces fit, data model, security model, known limitations
- [docs/PROVIDER_COMPLIANCE.md](docs/PROVIDER_COMPLIANCE.md): provider terms and data handling

## Security notes

- Every API key (OpenRouter, Gemini, SerpAPI, Tavily, Cloudflare, ElevenLabs, Brevo, Vynfy) exists only on the server as a Vercel environment variable. The browser never receives them, and `/api/config` reports only whether each provider is configured.
- The Firebase web config in `VITE_FIREBASE_*` is public by design. Access is enforced by Firestore security rules and server-side checks on every request.
- A Firebase service account (`FIREBASE_SERVICE_ACCOUNT`, server only) is used for administration, approvals, sign-out and the delivery logs. User data requests still go through the signed-in user's own ID token, so the security rules apply.
- Verification codes are checked on the server with attempt limits, and SMS and email have daily caps to prevent abuse and unexpected costs.
