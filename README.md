# Atlas AI

A private, single-owner AI assistant: streaming chat across multiple models, long-term memory, document Q&A with citations, cost-controlled web search (SerpAPI + Tavily) and Deep Research, projects, and an installable iPhone-friendly PWA.

- **Frontend:** React 19, TypeScript, Vite, Tailwind CSS v4, Framer Motion, Lucide
- **Data and auth:** Firebase Authentication and Cloud Firestore (with offline cache)
- **Backend:** Vercel serverless functions in `/api` (no Firebase Blaze plan required)
- **Models:** OpenRouter behind a provider abstraction (`server/providers`)

## Quick start

```bash
npm install
cp .env.example .env.local      # fill in values; never commit this file
npm run dev                     # http://localhost:5173 (serves /api too)
```

You also need a Firebase project with Email/Password and Google sign-in enabled and a Firestore database. See [docs/SETUP.md](docs/SETUP.md).

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server plus the `/api` functions |
| `npm run build` | Typecheck and production build (`dist/`) |
| `npm run typecheck` | TypeScript project references |
| `npm run lint` | ESLint |
| `npm test` | Unit tests (Vitest) |
| `npm run test:rules` | Firestore security-rules tests in the local emulator (needs Java) |
| `npm run test:e2e` | Playwright smoke tests in WebKit at iPhone sizes (run `npm run build` first) |
| `npm run check` | lint + typecheck + unit tests + build |

## Docs

- [docs/SETUP.md](docs/SETUP.md): local setup, environment variables, Firebase console steps
- [docs/DEPLOY.md](docs/DEPLOY.md): deploying rules and the app, installing on iPhone
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the pieces fit, data model, security model, limitations

## Security notes

- The OpenRouter, SerpAPI and Tavily keys exist only on the server (Vercel env vars). The browser never sees them, and `/api/config` reports only whether each provider is configured.
- The Firebase web config in `VITE_FIREBASE_*` is public by design. Access is enforced by Firestore security rules and an email allowlist.
- No service-account credentials are used or stored. The server talks to Firestore with the signed-in user's own ID token, so the same security rules apply to server-side reads and writes.
