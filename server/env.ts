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
  };
}
