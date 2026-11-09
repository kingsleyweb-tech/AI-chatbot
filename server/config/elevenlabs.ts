/**
 * ElevenLabs: an additional, optional voice provider (Gemini, OpenRouter and Cloudflare are unchanged).
 *
 * Verified against the live API with this project's key on 2026-11-08:
 *  - Text-to-speech streaming (POST /v1/text-to-speech/{voice}/stream) works; 41 characters with
 *    eleven_flash_v2_5 cost 19 credits (the `character-cost` response header), first audio in ~1.2 s.
 *  - The key has no voices_read, models_read, user_read, speech_history_read or convai_read
 *    permission, so the voice list is curated here (ElevenLabs' default voices) and subscription
 *    figures are not available; Atlas AI counts the credits each response reports instead.
 *  - Image and video generation (/v1/flows/*) answer 402 paid_plan_required (Pro plan or above),
 *    so they are not offered.
 *
 * Costs (ElevenLabs credits, from the API's own `character-cost` header and the model docs):
 *  Flash v2.5 about 0.5 credit per character; Multilingual v2 1 credit per character.
 * Nothing here ever buys credits or turns on usage-based billing: every request is checked against
 * the daily and monthly credit caps below (an administrator can lower or raise them, within the maxima).
 */

export const ELEVEN_API = 'https://api.elevenlabs.io';

export interface ElevenModel {
  id: string;
  label: string;
  description: string;
  /** credits per character (estimate used for reservations; the exact figure comes from the response) */
  creditsPerChar: number;
  /** whether the model accepts voice_settings.speed */
  speed: boolean;
  maxChars: number;
}

export const ELEVEN_MODELS: ElevenModel[] = [
  {
    id: 'eleven_flash_v2_5',
    label: 'Fast',
    description: 'Lowest delay and cost (about half a credit per character); best for Voice Mode.',
    creditsPerChar: 0.5,
    speed: true,
    maxChars: 1_000,
  },
  {
    id: 'eleven_multilingual_v2',
    label: 'High quality',
    description: 'Richer, steadier voice for reading aloud (one credit per character).',
    creditsPerChar: 1,
    speed: true,
    maxChars: 1_000,
  },
];
export const ELEVEN_DEFAULT_MODEL = 'eleven_flash_v2_5';
export const elevenModel = (id: string | undefined | null) => ELEVEN_MODELS.find((m) => m.id === id) ?? ELEVEN_MODELS[0];

export interface ElevenVoice {
  id: string;
  name: string;
  description: string;
  /** 'default' = one of ElevenLabs' own voices; 'designed' = made with Voice Design by an administrator */
  source: 'default' | 'designed';
}

/**
 * ElevenLabs' default voices (premade voices offered on every account). George was verified with a
 * live request on 2026-11-08; the others are ElevenLabs' published default voice IDs. The account's
 * own list can only be read from the API once the key has the voices_read permission. A voice that
 * stopped existing answers 404, which Atlas AI reports and then falls back to the Cloudflare voice.
 */
export const ELEVEN_VOICES: ElevenVoice[] = [
  { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', description: 'Warm British storyteller', source: 'default' },
  { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah', description: 'Soft, confident American', source: 'default' },
  { id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel', description: 'Steady British broadcaster', source: 'default' },
  { id: 'Xb7hH8MSUJpSbSDYk0k2', name: 'Alice', description: 'Clear British educator', source: 'default' },
  { id: 'FGY2WhTYpPnrIDTdsKH5', name: 'Laura', description: 'Bright, upbeat American', source: 'default' },
  { id: 'TX3LPaxmHKxFdv7VOQHJ', name: 'Liam', description: 'Energetic young American', source: 'default' },
  { id: 'XrExE9yKIg1WjnnlVkGX', name: 'Matilda', description: 'Friendly, professional American', source: 'default' },
  { id: 'nPczCjzI2devNBz1zQrb', name: 'Brian', description: 'Deep, comforting American', source: 'default' },
];
export const ELEVEN_DEFAULT_VOICE = ELEVEN_VOICES[0].id;

/** Speaking speed accepted by the API (voice_settings.speed). */
export const ELEVEN_SPEED_MIN = 0.7;
export const ELEVEN_SPEED_MAX = 1.2;

/** Sample sentence for voice previews (short, so a preview costs about 30 credits on Flash). */
export const ELEVEN_PREVIEW_TEXT = 'Hello, I’m Atlas. This is how I sound when I read to you.';

/** Characters per speech request (a long reply is spoken in several parts, like the Cloudflare voice). */
export const ELEVEN_MAX_CHARS = 600;

/* ------------------------------ Voice Design ------------------------------ */

/** Voice Design models (POST /v1/text-to-voice/design). */
export const ELEVEN_DESIGN_MODEL = 'eleven_multilingual_ttv_v2';
/** Sample text length the API requires for Voice Design previews. */
export const ELEVEN_DESIGN_TEXT_MIN = 100;
export const ELEVEN_DESIGN_TEXT_MAX = 1_000;
/**
 * Least credits reserved for one Voice Design request before the exact figure is known (ElevenLabs
 * does not publish the price; the reservation is the sample length, at least this much).
 */
export const ELEVEN_DESIGN_ESTIMATE = 300;
/** Voices an administrator may keep from Voice Design (custom voice slots are limited by the plan). */
export const ELEVEN_DESIGNED_VOICES_MAX = 10;

/* ------------------------------ admin settings ------------------------------ */

export interface ElevenSettings {
  /** off until an administrator turns it on; the Cloudflare voice stays the default either way */
  enabled: boolean;
  /** app-wide credits per UTC day */
  appDailyCredits: number;
  /** app-wide credits per calendar month (UTC) */
  appMonthlyCredits: number;
  /** one person's credits per UTC day */
  userDailyCredits: number;
  /** model used when the person has not chosen one */
  defaultModel: string;
}

export const ELEVEN_DEFAULTS: ElevenSettings = {
  enabled: false,
  appDailyCredits: 2_000,
  appMonthlyCredits: 9_000,
  userDailyCredits: 500,
  defaultModel: ELEVEN_DEFAULT_MODEL,
};

/** Hard ceilings an administrator cannot pass from the app (protects against a typo draining credits). */
export const ELEVEN_MAXIMA = { appDailyCredits: 50_000, appMonthlyCredits: 1_000_000, userDailyCredits: 20_000 };

function clampInt(v: unknown, fallback: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.min(max, Math.max(0, n));
}

/** Merge stored settings over the defaults, clamping every number. */
export function normalizeElevenSettings(raw: unknown): ElevenSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = ELEVEN_DEFAULTS;
  return {
    enabled: r.enabled === true,
    appDailyCredits: clampInt(r.appDailyCredits, d.appDailyCredits, ELEVEN_MAXIMA.appDailyCredits),
    appMonthlyCredits: clampInt(r.appMonthlyCredits, d.appMonthlyCredits, ELEVEN_MAXIMA.appMonthlyCredits),
    userDailyCredits: clampInt(r.userDailyCredits, d.userDailyCredits, ELEVEN_MAXIMA.userDailyCredits),
    defaultModel: ELEVEN_MODELS.some((m) => m.id === r.defaultModel) ? (r.defaultModel as string) : d.defaultModel,
  };
}
