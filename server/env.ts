const DEFAULT_ADMIN = 'kingsleyanaab604@gmail.com';

function list(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

export function env() {
  const e = process.env;
  return {
    openRouterKey: e.OPENROUTER_API_KEY ?? '',
    geminiKey: e.GEMINI_API_KEY ?? '',
    tavilyKey: e.TAVILY_API_KEY ?? '',
    serpApiKey: e.SERPAPI_API_KEY ?? '',
    /** Cloudflare Workers AI (server-only; never sent to the browser). */
    cloudflareAccountId: (e.CLOUDFLARE_ACCOUNT_ID ?? '').trim(),
    cloudflareApiToken: (e.CLOUDFLARE_API_TOKEN ?? '').trim(),
    /** optional override of the default image model (must be listed in server/config/images.ts) */
    cloudflareImageModel: (e.CLOUDFLARE_IMAGE_MODEL ?? '').trim(),
    appUrl: e.APP_URL ?? 'http://localhost:5173',
    projectId: e.FIREBASE_PROJECT_ID ?? e.VITE_FIREBASE_PROJECT_ID ?? '',
    /** Firebase web API key (public); the server uses it to sign in as its own identity. */
    firebaseApiKey: e.FIREBASE_WEB_API_KEY ?? e.VITE_FIREBASE_API_KEY ?? '',
    adminEmails: (list(e.ADMIN_EMAILS) ?? [DEFAULT_ADMIN]).map((s) => s.toLowerCase()),
    defaultModel: e.DEFAULT_MODEL,
    fallbackModels: list(e.FALLBACK_MODELS),
    utilityModels: list(e.UTILITY_MODELS),
    embeddingModels: list(e.EMBEDDING_MODELS),
    /** Firestore emulator host for local testing, e.g. 127.0.0.1:8080 */
    firestoreEmulator: e.FIRESTORE_EMULATOR_HOST,
    /** Auth emulator host for local testing, e.g. 127.0.0.1:9099 */
    authEmulator: e.FIREBASE_AUTH_EMULATOR_HOST,
    /** Service account JSON (raw or base64). Server-only; enables phone verification (custom claims, private records). */
    serviceAccount: e.FIREBASE_SERVICE_ACCOUNT ?? '',
    /** HMAC key for one-time codes (32+ random bytes). */
    otpSecret: e.OTP_HMAC_SECRET ?? '',
    smsProvider: (e.SMS_PROVIDER ?? 'vynfy').toLowerCase(),
    vynfyKey: (e.VYNFY_API_KEY ?? '').trim(),
    /** Approved sender ID (max 11 characters). Only an approved sender that the networks accept is delivered. */
    vynfySender: (e.VYNFY_SENDER_ID ?? '').trim(),
    /** '1' sends through Vynfy's sandbox (never delivered, never charged). */
    vynfySandbox: e.VYNFY_SANDBOX === '1',
    /** Verification codes through Vynfy's OTP service (default). '0' = app-generated codes sent as ordinary SMS. */
    vynfyOtp: (e.VYNFY_OTP ?? '1') !== '0',
    /** Code length for the OTP service (4-8, default 6). */
    otpLength: Math.min(8, Math.max(4, Number(e.VYNFY_OTP_LENGTH ?? 6) || 6)),
    /** Code lifetime in minutes for the OTP service (1-60, default 5). */
    otpExpiryMin: Math.min(60, Math.max(1, Number(e.VYNFY_OTP_EXPIRY ?? 5) || 5)),
    /** When the OTP balance is empty, fall back to app codes sent as ordinary SMS (default on; '0' disables). */
    otpSmsFallback: (e.VYNFY_OTP_FALLBACK ?? '1') !== '0',
    /** Shared secret for Vynfy delivery webhooks (HMAC-SHA256, X-Webhook-Signature). */
    vynfyWebhookSecret: (e.VYNFY_WEBHOOK_SECRET ?? '').trim(),
    /** App-wide cap on verification texts per day (protects the SMS balance). */
    otpDailyCap: Number(e.OTP_DAILY_CAP ?? 200) || 200,
    /** Transactional email (server-only). Only 'brevo' is implemented. */
    emailProvider: (e.EMAIL_PROVIDER ?? 'brevo').toLowerCase(),
    brevoKey: (e.BREVO_API_KEY ?? '').trim(),
    /** Verified sender address in the provider account. */
    emailFrom: (e.EMAIL_FROM_ADDRESS ?? '').trim(),
    emailFromName: (e.EMAIL_FROM_NAME ?? 'Atlas AI').trim() || 'Atlas AI',
    /** App-wide cap on emails per day (Brevo's free plan allows 300). */
    emailDailyCap: Number(e.EMAIL_DAILY_CAP ?? 250) || 250,
    /** app-wide daily limit for notification texts (support updates); verification codes have their own */
    smsNotifyDailyCap: Number(e.SMS_NOTIFY_DAILY_CAP ?? 50) || 50,
    /** Public address of the app used for links and the logo in emails (must be reachable from the internet). */
    publicUrl: (e.PUBLIC_APP_URL ?? (e.APP_URL && !/localhost|127\.0\.0\.1/.test(e.APP_URL) ? e.APP_URL : 'https://chatatlasai.vercel.app')).replace(/\/+$/, ''),
  };
}
