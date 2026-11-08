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
    appUrl: e.APP_URL ?? 'http://localhost:5173',
    projectId: e.FIREBASE_PROJECT_ID ?? e.VITE_FIREBASE_PROJECT_ID ?? '',
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
    vynfyKey: e.VYNFY_API_KEY ?? '',
    vynfySender: e.VYNFY_SENDER_ID ?? '',
    /** '1' sends through Vynfy's sandbox (never delivered, never charged). */
    vynfySandbox: e.VYNFY_SANDBOX === '1',
    /** App-wide cap on verification texts per day (protects the SMS balance). */
    otpDailyCap: Number(e.OTP_DAILY_CAP ?? 200) || 200,
  };
}
