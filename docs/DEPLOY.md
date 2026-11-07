# Deploying

Everything here changes live infrastructure. Run each step yourself, or approve it explicitly first.

## 1. Firestore rules and indexes

```bash
npx firebase deploy --only firestore:rules,firestore:indexes --project ai-app-6efa7
```

## 2. Vercel

1. In Vercel, **Add New > Project** and import the GitHub repository. The framework preset (Vite), build command and output directory come from `vercel.json`.
2. **Settings > Environment Variables** (Production and Preview):
   - `OPENROUTER_API_KEY`: mark it **Sensitive**
   - `GEMINI_API_KEY`: optional, Sensitive. Set `GEMINI_BILLING=paid` only if the Google project has billing enabled.
   - `SERPAPI_API_KEY` and `TAVILY_API_KEY`: optional, also Sensitive
   - `APP_URL`: for example `https://your-app.vercel.app`
   - `FIREBASE_PROJECT_ID`: `ai-app-6efa7`
   - all `VITE_FIREBASE_*` values from `.env.local`
3. Deploy. API routes run as Node functions with a 60-second limit (`vercel.json`). Long answers keep streaming as long as tokens keep arriving within that window. On the Hobby plan, a reply that takes more than 60 seconds in total is cut off. What streamed so far is kept, and **Continue** resumes it.
4. In Firebase **Authentication > Settings > Authorized domains**, add the Vercel domain.

### Google sign-in on iPhone (recommended)

Safari blocks third-party storage, which can break Google sign-in when the auth domain differs from the app domain. The app proxies `/__/auth/*` to Firebase (see `vercel.json`), so you can serve sign-in from your own domain:

1. Set `VITE_FIREBASE_AUTH_DOMAIN` to your app domain (for example `your-app.vercel.app`) in Vercel, then redeploy.
2. In Google Cloud Console > APIs & Services > Credentials > the "Web client (auto created by Google Service)" OAuth client, add `https://your-app.vercel.app/__/auth/handler` as an authorized redirect URI.

Email/password sign-in works without this.

## 3. Install on iPhone

1. Open the deployed URL in **Safari**. Other iOS browsers can't install web apps on every iOS version.
2. Sign in.
3. Tap **Share**, then **Add to Home Screen**, then **Add**.
4. Launch Tessera from the Home Screen. It opens full screen without browser chrome, keeps you signed in, and shows cached chats when offline.

Updates arrive automatically. When a new version is deployed, the service worker picks it up on the next launch.

## Rolling back

In Vercel **Deployments**, choose a previous deployment and select **Promote to Production**. Firestore rules have a history in the Firebase console (**Firestore > Rules**), where you can republish an earlier version.

## Costs

- Vercel Hobby, Firebase Spark and OpenRouter `:free` models cost nothing. Free models have per-minute and per-day rate limits. The app falls back between free models and tells you which one answered.
- Paid models (for example `google/gemini-3.8-flash`) need OpenRouter credits. Until credits are added, the picker marks them "Needs credits" and requests fall back to a free model.
- **Web search** costs credits:
  - SerpAPI free plan: 250 searches/month.
  - Tavily Researcher plan: 1,000 credits/month.

  Tessera enforces its own lower limits and stops before either plan runs out:
  - SerpAPI 8/day and 200/month
  - Tavily 30/day and 900/month
  - Deep Research at most 6 searches and 4 page reads per run

  It caches results, so a repeated question costs nothing. It never moves to paid usage. An admin can change the limits in **Settings > Usage**.
