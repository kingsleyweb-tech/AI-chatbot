/**
 * Atlas AI API platform: shared definitions (pure, no secrets), used by the server
 * (server/apiPlatform) and the Super Admin dashboard (API Management).
 *
 * An *integration* is one application connected to Atlas AI. It has its own identity, permissions,
 * usage limits, allowed API environments and API keys. Nothing here grants anything by default:
 * a new integration has only the permissions the Super Admin selects.
 */
import { ENVIRONMENTS, type EnvId } from './environments.js';

export const API_VERSION = 'v1';

/* ------------------------------------------------------------------ permissions */

export const API_PERMISSIONS = [
  'chat',
  'chat_stream',
  'conversations_read',
  'conversations_delete',
  'models',
  'reasoning',
  'images',
  'research',
  'deep_research',
  'documents',
  'voice_tts',
  'voice_stt',
  'memory',
] as const;
export type ApiPermission = (typeof API_PERMISSIONS)[number];

export const PERMISSION_GROUPS: { label: string; items: ApiPermission[] }[] = [
  { label: 'AI Chat', items: ['chat', 'chat_stream'] },
  { label: 'Model Access', items: ['models'] },
  { label: 'Advanced Reasoning', items: ['reasoning'] },
  { label: 'Image Generation', items: ['images'] },
  { label: 'Web Research', items: ['research', 'deep_research'] },
  { label: 'Document Processing', items: ['documents'] },
  { label: 'Voice', items: ['voice_tts', 'voice_stt'] },
  { label: 'Conversation Management', items: ['conversations_read', 'conversations_delete'] },
  { label: 'Memory', items: ['memory'] },
];

export const PERMISSION_INFO: Record<ApiPermission, { label: string; explain: string }> = {
  chat: { label: 'Send messages and receive replies', explain: 'Chat with Atlas AI, create and continue the application’s own conversations. Automatic model routing.' },
  chat_stream: { label: 'Streaming responses', explain: 'Receive replies token by token (Server-Sent Events). Needs chat.' },
  conversations_read: { label: 'Retrieve conversation history', explain: 'List and read the application’s own conversations.' },
  conversations_delete: { label: 'Delete conversations', explain: 'Delete the application’s own conversations and what was learned from them.' },
  models: { label: 'Choose models', explain: 'Select from the permitted free models. Without it, Atlas AI always chooses the model automatically.' },
  reasoning: { label: 'Advanced reasoning', explain: 'Atlas AI may switch on step-by-step reasoning for hard questions (the normal automatic selection). Without it, replies always use the fast pathway.' },
  images: { label: 'Generate images', explain: 'Create and edit pictures with the existing image system (safety checks and the free daily allowance apply).' },
  research: { label: 'Web search', explain: 'Search the web and read pages, with sources. Uses the shared search budgets.' },
  deep_research: { label: 'Deep Research', explain: 'Multi-step research reports. Needs web search.' },
  documents: { label: 'Documents', explain: 'Upload document text, summarise and analyse it, ask questions about it.' },
  voice_tts: { label: 'Text-to-speech', explain: 'Natural voice audio (Cloudflare) and, when enabled by the administrator, ElevenLabs.' },
  voice_stt: { label: 'Speech-to-text', explain: 'Transcribe recordings.' },
  memory: { label: 'Memory', explain: 'Long-term memory per end user of this application: used in chat, listed and deleted through the API.' },
};

/** Permissions that only make sense together with another one. */
export const PERMISSION_REQUIRES: Partial<Record<ApiPermission, ApiPermission>> = {
  chat_stream: 'chat',
  deep_research: 'research',
  reasoning: 'chat',
  models: 'chat',
};

/* ------------------------------------------------------------------- app types */

export const APP_TYPES = ['internal', 'external', 'web', 'mobile', 'desktop', 'custom'] as const;
export type AppType = (typeof APP_TYPES)[number];
export const APP_TYPE_LABEL: Record<AppType, string> = {
  internal: 'Internal application',
  external: 'External application',
  web: 'Web application',
  mobile: 'Mobile application',
  desktop: 'Desktop application',
  custom: 'Custom integration',
};

export const INTEGRATION_STATUSES = ['active', 'suspended', 'disabled'] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number] | 'deleted';

export type KeyMode = 'live' | 'test';
export type KeyStatus = 'active' | 'disabled' | 'revoked';

/* ----------------------------------------------------------------------- limits */

/** null = no limit of this kind (still subject to the hard safety ceilings below). */
export interface ApiLimits {
  requestsPerMinute: number | null;
  requestsPerHour: number | null;
  requestsPerDay: number | null;
  requestsPerWeek: number | null;
  requestsPerMonth: number | null;
  maxConcurrent: number | null;
  /** characters in one message / prompt */
  maxInputChars: number | null;
  /** output tokens of one reply */
  maxOutputTokens: number | null;
  /** characters of text in one uploaded document */
  maxDocumentChars: number | null;
  streaming: boolean;
  imagesPerDay: number | null;
  researchPerDay: number | null;
  deepResearchPerDay: number | null;
  documentsPerDay: number | null;
  ttsCharsPerDay: number | null;
  sttPerDay: number | null;
}

export const LIMIT_KEYS = [
  'requestsPerMinute',
  'requestsPerHour',
  'requestsPerDay',
  'requestsPerWeek',
  'requestsPerMonth',
  'maxConcurrent',
  'maxInputChars',
  'maxOutputTokens',
  'maxDocumentChars',
  'imagesPerDay',
  'researchPerDay',
  'deepResearchPerDay',
  'documentsPerDay',
  'ttsCharsPerDay',
  'sttPerDay',
] as const satisfies readonly Exclude<keyof ApiLimits, 'streaming'>[];
export type NumericLimitKey = (typeof LIMIT_KEYS)[number];

export const LIMIT_INFO: Record<NumericLimitKey, { label: string; group: 'Requests' | 'Size' | 'Features' }> = {
  requestsPerMinute: { label: 'Requests per minute', group: 'Requests' },
  requestsPerHour: { label: 'Requests per hour', group: 'Requests' },
  requestsPerDay: { label: 'Requests per day', group: 'Requests' },
  requestsPerWeek: { label: 'Requests per week', group: 'Requests' },
  requestsPerMonth: { label: 'Requests per month', group: 'Requests' },
  maxConcurrent: { label: 'Concurrent requests', group: 'Requests' },
  maxInputChars: { label: 'Max input (characters)', group: 'Size' },
  maxOutputTokens: { label: 'Max output (tokens)', group: 'Size' },
  maxDocumentChars: { label: 'Max document (characters)', group: 'Size' },
  imagesPerDay: { label: 'Images per day', group: 'Features' },
  researchPerDay: { label: 'Web searches per day', group: 'Features' },
  deepResearchPerDay: { label: 'Deep Research per day', group: 'Features' },
  documentsPerDay: { label: 'Document uploads per day', group: 'Features' },
  ttsCharsPerDay: { label: 'Speech characters per day', group: 'Features' },
  sttPerDay: { label: 'Transcriptions per day', group: 'Features' },
};

/**
 * Hard safety ceilings that apply to every integration, Unlimited included. "Unlimited" removes the
 * application's own quotas; it never removes these, the provider safeguards (free quotas, the
 * Cloudflare and ElevenLabs caps, the Temporary ceiling) or abuse prevention.
 */
export const HARD_CEILINGS = {
  maxConcurrent: 20,
  maxInputChars: 100_000,
  maxOutputTokens: 16_384,
  maxDocumentChars: 2_500_000,
  requestsPerMinute: 600,
} as const;

export const USAGE_PROFILES = ['standard', 'premium', 'restricted', 'unlimited', 'custom'] as const;
export type UsageProfile = (typeof USAGE_PROFILES)[number];
export const PROFILE_LABEL: Record<UsageProfile, string> = {
  standard: 'Standard',
  premium: 'Premium',
  restricted: 'Restricted',
  unlimited: 'Unlimited',
  custom: 'Custom',
};

const STANDARD: ApiLimits = {
  requestsPerMinute: 30,
  requestsPerHour: 600,
  requestsPerDay: 2_000,
  requestsPerWeek: null,
  requestsPerMonth: 30_000,
  maxConcurrent: 5,
  maxInputChars: 20_000,
  maxOutputTokens: 4_096,
  maxDocumentChars: 500_000,
  streaming: true,
  imagesPerDay: 20,
  researchPerDay: 50,
  deepResearchPerDay: 5,
  documentsPerDay: 50,
  ttsCharsPerDay: 50_000,
  sttPerDay: 100,
};

export const PROFILE_LIMITS: Record<Exclude<UsageProfile, 'custom'>, ApiLimits> = {
  standard: STANDARD,
  premium: {
    ...STANDARD,
    requestsPerMinute: 120,
    requestsPerHour: 3_000,
    requestsPerDay: 10_000,
    requestsPerMonth: 200_000,
    maxConcurrent: 15,
    maxInputChars: 60_000,
    maxOutputTokens: 8_192,
    maxDocumentChars: 2_000_000,
    imagesPerDay: 100,
    researchPerDay: 300,
    deepResearchPerDay: 25,
    documentsPerDay: 300,
    ttsCharsPerDay: 300_000,
    sttPerDay: 600,
  },
  restricted: {
    ...STANDARD,
    requestsPerMinute: 5,
    requestsPerHour: 60,
    requestsPerDay: 200,
    requestsPerMonth: 3_000,
    maxConcurrent: 1,
    maxInputChars: 4_000,
    maxOutputTokens: 1_024,
    maxDocumentChars: 100_000,
    imagesPerDay: 2,
    researchPerDay: 5,
    deepResearchPerDay: 0,
    documentsPerDay: 5,
    ttsCharsPerDay: 5_000,
    sttPerDay: 10,
  },
  unlimited: {
    requestsPerMinute: null,
    requestsPerHour: null,
    requestsPerDay: null,
    requestsPerWeek: null,
    requestsPerMonth: null,
    maxConcurrent: null,
    maxInputChars: null,
    maxOutputTokens: null,
    maxDocumentChars: null,
    streaming: true,
    imagesPerDay: null,
    researchPerDay: null,
    deepResearchPerDay: null,
    documentsPerDay: null,
    ttsCharsPerDay: null,
    sttPerDay: null,
  },
};

const MAX_LIMIT = 100_000_000;

/** A stored limit made safe: integers >= 0, or null. */
export function cleanLimit(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return Math.min(MAX_LIMIT, Math.max(0, Math.floor(n)));
}

/** Limits for a profile; Custom uses the stored values (missing values fall back to Standard). */
export function normalizeLimits(profile: UsageProfile, raw: unknown): ApiLimits {
  if (profile !== 'custom') return { ...PROFILE_LIMITS[profile] };
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = { ...STANDARD };
  for (const k of LIMIT_KEYS) if (k in r) out[k] = cleanLimit(r[k]);
  if (typeof r.streaming === 'boolean') out.streaming = r.streaming;
  return out;
}

/** Key-level overrides: only the values set apply (each is checked in addition to the integration's). */
export type KeyLimits = Partial<Record<NumericLimitKey, number | null>>;

export function normalizeKeyLimits(raw: unknown): KeyLimits | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const out: KeyLimits = {};
  for (const k of LIMIT_KEYS) {
    if (!(k in r)) continue;
    const v = cleanLimit(r[k]);
    if (v !== null) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** The smaller of two optional limits (null = no limit). */
export function stricter(a: number | null | undefined, b: number | null | undefined): number | null {
  const x = a ?? null;
  const y = b ?? null;
  if (x === null) return y;
  if (y === null) return x;
  return Math.min(x, y);
}

/** A size limit with the hard ceiling applied. */
export function withCeiling(limit: number | null, key: keyof typeof HARD_CEILINGS): number {
  return limit === null ? HARD_CEILINGS[key] : Math.min(limit, HARD_CEILINGS[key]);
}

/* ------------------------------------------------------------------ environments */

/** Which environment a key uses: the live global configuration ('active') or a fixed one. */
export type EnvChoice = 'active' | EnvId;
export const ENV_CHOICES: readonly EnvChoice[] = ['active', ...ENVIRONMENTS];

/* ------------------------------------------------------------------ integration */

export interface IntegrationConfig {
  id: string;
  name: string;
  appName: string;
  appDescription: string;
  appType: AppType;
  status: IntegrationStatus;
  permissions: ApiPermission[];
  profile: UsageProfile;
  limits: ApiLimits;
  /** null = never */
  expiresAt: number | null;
  allowedEnvironments: EnvId[];
  environment: { live: EnvChoice; test: EnvChoice };
  /** null = every approved free model; otherwise only these ids */
  allowedModels: string[] | null;
  /** browser origins allowed to call the API directly (empty = server-to-server only) */
  allowedOrigins: string[];
  createdAt: number | null;
  createdBy: string | null;
  updatedAt: number | null;
  updatedBy: string | null;
  version: number;
  lastUsedAt: number | null;
}

export interface ApiKeyView {
  id: string;
  integrationId: string;
  name: string;
  mode: KeyMode;
  /** e.g. "atlas_live_3f9a1c…7Q2x": enough to recognise a key, never enough to use it */
  display: string;
  status: KeyStatus;
  expiresAt: number | null;
  limits: KeyLimits | null;
  createdAt: number | null;
  createdBy: string | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
  rotatedFrom: string | null;
  rotatedTo: string | null;
}

const isEnv = (v: unknown): v is EnvId => typeof v === 'string' && (ENVIRONMENTS as readonly string[]).includes(v);
const isChoice = (v: unknown): v is EnvChoice => v === 'active' || isEnv(v);
const time = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
};
const str = (v: unknown, max: number, d = '') => (typeof v === 'string' ? v.slice(0, max) : d);

/** Every permission whose prerequisite is missing is dropped (never granted implicitly). */
export function cleanPermissions(raw: unknown): ApiPermission[] {
  const list = Array.isArray(raw) ? raw : [];
  const set = new Set(API_PERMISSIONS.filter((p) => list.includes(p)));
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of [...set]) {
      const req = PERMISSION_REQUIRES[p];
      if (req && !set.has(req)) {
        set.delete(p);
        changed = true;
      }
    }
  }
  return API_PERMISSIONS.filter((p) => set.has(p));
}

export function normalizeIntegration(id: string, raw: unknown): IntegrationConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const profile = (USAGE_PROFILES as readonly string[]).includes(r.profile as string) ? (r.profile as UsageProfile) : 'standard';
  const allowed = Array.isArray(r.allowedEnvironments) ? ENVIRONMENTS.filter((e) => (r.allowedEnvironments as unknown[]).includes(e)) : ['main' as EnvId];
  const env = (r.environment ?? {}) as Record<string, unknown>;
  const status = r.status === 'deleted' ? 'deleted' : (INTEGRATION_STATUSES as readonly string[]).includes(r.status as string) ? (r.status as IntegrationStatus) : 'disabled';
  return {
    id,
    name: str(r.name, 80, id),
    appName: str(r.appName, 80),
    appDescription: str(r.appDescription, 500),
    appType: (APP_TYPES as readonly string[]).includes(r.appType as string) ? (r.appType as AppType) : 'custom',
    status,
    permissions: cleanPermissions(r.permissions),
    profile,
    limits: normalizeLimits(profile, r.limits),
    expiresAt: time(r.expiresAt),
    allowedEnvironments: allowed,
    environment: { live: isChoice(env.live) ? env.live : 'active', test: isChoice(env.test) ? env.test : 'active' },
    allowedModels: Array.isArray(r.allowedModels) ? (r.allowedModels as unknown[]).filter((m): m is string => typeof m === 'string').slice(0, 50) : null,
    allowedOrigins: Array.isArray(r.allowedOrigins) ? (r.allowedOrigins as unknown[]).filter((o): o is string => typeof o === 'string').slice(0, 20) : [],
    createdAt: time(r.createdAt),
    createdBy: typeof r.createdBy === 'string' ? r.createdBy : null,
    updatedAt: time(r.updatedAt),
    updatedBy: typeof r.updatedBy === 'string' ? r.updatedBy : null,
    version: typeof r.version === 'number' ? r.version : 0,
    lastUsedAt: time(r.lastUsedAt),
  };
}

/** A browser origin as stored: scheme://host[:port], lower case, no path. */
export function normalizeOrigin(v: string): string | null {
  try {
    const u = new URL(v.trim());
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname))) return null;
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------- request features */

/** What a request is counted as in analytics and logs. */
export const API_FEATURES = ['chat', 'models', 'conversations', 'images', 'research', 'documents', 'voice', 'memory', 'app'] as const;
export type ApiFeature = (typeof API_FEATURES)[number];

export const API_FEATURE_LABEL: Record<ApiFeature, string> = {
  chat: 'Chat',
  models: 'Models',
  conversations: 'Conversations',
  images: 'Images',
  research: 'Research',
  documents: 'Documents',
  voice: 'Voice',
  memory: 'Memory',
  app: 'Application info',
};

/** A request log row (never prompts, documents, raw keys, tokens or provider credentials). */
export interface ApiLogRow {
  id: string;
  at: number;
  integrationId: string;
  keyId: string | null;
  mode: KeyMode | null;
  method: string;
  endpoint: string;
  feature: ApiFeature;
  status: number;
  code: string | null;
  ms: number;
  environment: EnvId | 'mixed' | null;
  model: string | null;
  requestId: string;
  source: 'api' | 'admin_test';
}
