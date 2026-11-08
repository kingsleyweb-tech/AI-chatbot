# Deploying

Everything here changes live infrastructure. Run each step yourself, or approve it explicitly first.

## 1. Firestore rules and indexes

**Order matters.** The rules require the `phoneVerified` claim for email/password sign-ins. Set `FIREBASE_SERVICE_ACCOUNT`, `OTP_HMAC_SECRET` and the `VYNFY_*` variables in Vercel and deploy the app **first**, so password users can verify their phone; then deploy the rules. Google and Apple users are not affected.

```bash
npx firebase deploy --only firestore:rules,firestore:indexes --project ai-app-6efa7
```

Existing email/password accounts (including administrators) are asked to verify a phone number once at their next sign-in.

The current rules also enforce account status: a suspended or deleted profile (`accountStatus`) and sessions older than `sessionsValidAfter` are refused, security events and admin logs are read-only for clients, and the new collections (`securityEvents`, `adminLogs`, `convIndex`, `projectMemory`, recovery records) are covered. Until these rules are deployed, suspension still works through Firebase Auth (the account is disabled and its tokens revoked) and the API checks, but the database itself does not refuse an already-issued token until it expires (up to an hour).

## 2. Vercel

1. In Vercel, **Add New > Project** and import the GitHub repository. The framework preset (Vite), build command and output directory come from `vercel.json`.
2. **Settings > Environment Variables** (Production and Preview):
   - `OPENROUTER_API_KEY`: mark it **Sensitive**
   - `GEMINI_API_KEY`: recommended (primary provider), Sensitive. Set `GEMINI_BILLING=paid` only if the Google project has billing enabled.
   - `SERPAPI_API_KEY` and `TAVILY_API_KEY`: optional, also Sensitive
   - `APP_URL`: for example `https://your-app.vercel.app`
   - `FIREBASE_PROJECT_ID`: `ai-app-6efa7`
   - all `VITE_FIREBASE_*` values from `.env.local` (with `VITE_FIREBASE_AUTH_DOMAIN=auto`, see below)
   - phone verification: `FIREBASE_SERVICE_ACCOUNT`, `OTP_HMAC_SECRET`, `VYNFY_API_KEY` (all Sensitive), `VYNFY_SENDER_ID`
   - account administration: `CRON_SECRET` (Sensitive, 16+ characters) for the daily purge of accounts scheduled for deletion (`crons` in `vercel.json`; Hobby allows one run a day)
3. Deploy. API routes run as Node functions with a 60-second limit (`vercel.json`). Long answers keep streaming as long as tokens keep arriving within that window. On the Hobby plan, a reply that takes more than 60 seconds in total is cut off. What streamed so far is kept, and **Continue** resumes it.
4. In Firebase **Authentication > Settings > Authorized domains**, add the Vercel domain.

### Google and Apple sign-in in Safari and the installed app (required for the PWA)

Installed apps (Home Screen / "Install app") and Safari partition third-party storage. When the sign-in handler lives on `*.firebaseapp.com` while the app is on another domain, the sign-in result can be lost and the user lands back on the login page. In the installed app, Atlas AI uses a full-page redirect (popups open outside the app), which only works reliably with a same-site handler. The app proxies `/__/auth/*` to Firebase (`vercel.json`), so:

1. Set `VITE_FIREBASE_AUTH_DOMAIN=auto` in Vercel (or the exact domain, e.g. `your-app.vercel.app`) and redeploy. `auto` uses whatever domain the app is served from.
2. Firebase **Authentication > Settings > Authorized domains**: add every domain you use.
3. Google Cloud Console > APIs & Services > Credentials > "Web client (auto created by Google Service)": add `https://your-app.vercel.app/__/auth/handler` to **Authorized redirect URIs** (one per domain).
4. Apple: add the same handler URL as a Return URL of the Service ID (below).

Email/password sign-in works without this.

### Apple accounts

Sign in with Apple has been removed from the sign-in screens. It never worked in this project (Firebase answered "Code flow is not enabled for Apple"), so no Apple accounts are expected. Nothing was deleted: the Apple provider setting in Firebase, the server's handling of `apple.com` sign-ins and any existing profile data are unchanged, and the admin **Users** page lists any Apple account under an "Apple (legacy)" filter.

If an Apple account does exist, its owner can get in by:

1. **Password reset by email.** On **Forgot password**, enter the account email and choose **Email me a reset link instead**. Firebase adds a password to the same account (same user ID and data). They then sign in with email and password, which also requires verifying a Ghana mobile number once. Accounts using Apple's private relay address receive the email through Apple's relay.
2. **Asking the administrator,** who can find the account on the **Users** page.

To bring Apple back later, complete the Apple Developer setup (Services ID, key, Team ID) in Firebase and restore the button from git history (`src/features/auth/AuthPages.tsx`, `src/lib/authProviders.ts`).

### Account administration

- **Users** (Settings > Users, administrators only) shows statistics and every account from Firebase Auth and Firestore. Suspend disables the Auth account, revokes its tokens, sets `accountStatus: suspended` and records a security event and an admin log. Delete schedules permanent deletion after 30 days (the account is disabled at once and can be restored until then); the daily cron or **Delete permanently now** (typed email, acknowledgement and a second confirmation) removes the user's data, phone mapping, allowlist entry and Auth account.
- Administrators cannot act on themselves or the owner (`ADMIN_EMAILS`), and only the owner can act on another administrator. Every decision is checked again on the server.

### Phone verification (SMS)

Email/password accounts must verify a Ghana mobile number with a 6-digit text code before using the app. Codes are generated, stored (hashed) and checked only in `/api/phone`; the browser never sees the SMS key or a code.

1. Firebase **Project settings > Service accounts > Generate new private key**. Paste the JSON (or its base64) into Vercel as `FIREBASE_SERVICE_ACCOUNT` (Sensitive), then delete the downloaded file.
2. Vercel: `OTP_HMAC_SECRET` (Sensitive, 32+ random bytes), `VYNFY_API_KEY` (Sensitive), `VYNFY_SENDER_ID`, optionally `OTP_DAILY_CAP`. Leave `VYNFY_SANDBOX` unset in production.
3. Each text costs one Vynfy SMS credit. Only allowlisted accounts can request codes, with per-account, per-number and app-wide limits.
4. **Password recovery by text** (`/api/recovery`) uses the same provider and secrets. It responds the same way whether or not an email has an account, and every reset revokes all sessions. Each recovery text is also one Vynfy credit; sending is rate limited per account, per IP address and app-wide.

## 3. Install on iPhone

1. Open the deployed URL in **Safari**. Other iOS browsers can't install web apps on every iOS version.
2. Sign in.
3. Tap **Share**, then **Add to Home Screen**, then **Add**.
4. Launch Atlas AI from the Home Screen. It opens full screen without browser chrome, keeps you signed in, and shows cached chats when offline.

Updates arrive automatically. When a new version is deployed, the service worker picks it up on the next launch.

## Rolling back

In Vercel **Deployments**, choose a previous deployment and select **Promote to Production**. Firestore rules have a history in the Firebase console (**Firestore > Rules**), where you can republish an earlier version.

## Costs

- Vercel Hobby, Firebase Spark and OpenRouter `:free` models cost nothing. Free models have per-minute and per-day rate limits. The app falls back between free models and tells you which one answered.
- Paid models (for example `google/gemini-3.8-flash`) need OpenRouter credits. Until credits are added, the picker marks them "Needs credits" and requests fall back to a free model.
- **Web search** costs credits:
  - SerpAPI free plan: 250 searches/month.
  - Tavily Researcher plan: 1,000 credits/month.

  Atlas AI enforces its own lower limits and stops before either plan runs out:
  - SerpAPI 8/day and 200/month
  - Tavily 30/day and 900/month
  - Deep Research at most 6 searches and 4 page reads per run

  It caches results, so a repeated question costs nothing. It never moves to paid usage. An admin can change the limits in **Settings > Usage**.
