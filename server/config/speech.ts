/**
 * Cloudflare Workers AI speech and translation models (verified against the live API, 2026-11).
 *
 * Costs (Cloudflare pricing page, $0.011 per 1,000 Neurons, free 10,000 Neurons/day):
 *  - Whisper large v3 turbo: 46.63 Neurons per audio minute (a 3 s phrase measured 2.6)
 *  - Deepgram Aura-1:        1,363.64 Neurons per 1,000 characters (61 characters measured 83.2)
 *  - m2m100 1.2B:            31,050 Neurons per million tokens (one sentence measured about 1.5)
 *
 * Aura-1 is by far the most expensive call Atlas AI makes, so the natural voice has its own,
 * much smaller share of the daily allowance; the device's own voice is free and always available.
 * MeloTTS (cheaper) is not used: Cloudflare schedules it for removal on 2026-11-20.
 */

export const STT_MODEL = '@cf/openai/whisper-large-v3-turbo';
export const TTS_MODEL = '@cf/deepgram/aura-1';
export const TRANSLATE_MODEL = '@cf/meta/m2m100-1.2b';
/**
 * End-of-turn detection for Voice Mode (Pipecat Smart Turn v2): from the sound of the last few seconds
 * of speech it tells whether the speaker has finished or is only pausing. $0.000338 per audio minute
 * (about 0.03 Neurons per second; live calls on 2026-11-08 reported 0). Tested live: a finished
 * question scored 0.91, a sentence cut off mid-way 0.009. Used only as a hint next to silence timing.
 */
export const TURN_MODEL = '@cf/pipecat-ai/smart-turn-v2';
/** Seconds of the most recent speech sent for an end-of-turn check (16 kHz mono, 16-bit). */
export const TURN_MAX_SECONDS = 8;
/** End-of-turn checks one person may make per day (each is a fraction of a Neuron). */
export const TURN_USER_DAILY_REQUESTS = 3_000;

/** Largest recording accepted (raw bytes; Vercel request bodies stop at 4.5 MB). */
export const MAX_AUDIO_BYTES = 4_000_000;
/** Longest single recording the app sends (the browser stops recording at this point). */
export const MAX_RECORDING_SECONDS = 120;
/** Neurons reserved per transcription before the exact cost is known (2 minutes of audio). */
export const STT_ESTIMATE = 95;

/** Characters per natural-voice request (a long reply is spoken in several parts). */
export const TTS_MAX_CHARS = 400;
export const TTS_NEURONS_PER_CHAR = 1.3637;
/** App-wide share of the daily allowance for the natural voice; the device voice takes over after it. */
export const TTS_APP_DAILY_NEURONS = 2_500;
/** One person's share of the natural voice per day. */
export const TTS_USER_DAILY_NEURONS = 1_000;

/** Characters per translation request (longer text is translated in parts). */
export const TRANSLATE_MAX_CHARS = 12_000;
export const TRANSLATE_CHUNK_CHARS = 900;

/**
 * Languages offered for translation: only the ones that passed live round-trip tests
 * (English -> language -> English kept the meaning) on 2026-11-08 with dev/smoke-cloudflare.ts.
 * Removed after testing because the model changed the meaning: Arabic, Hausa, Yoruba, Igbo, Zulu.
 * Swahili and Turkish passed with small wording differences (basic quality).
 * The model accepts more names, but Atlas AI only offers what was verified.
 */
export const TRANSLATE_LANGUAGES: { code: string; name: string }[] = [
  { code: 'english', name: 'English' },
  { code: 'french', name: 'French' },
  { code: 'spanish', name: 'Spanish' },
  { code: 'portuguese', name: 'Portuguese' },
  { code: 'german', name: 'German' },
  { code: 'italian', name: 'Italian' },
  { code: 'dutch', name: 'Dutch' },
  { code: 'chinese', name: 'Chinese' },
  { code: 'japanese', name: 'Japanese' },
  { code: 'korean', name: 'Korean' },
  { code: 'hindi', name: 'Hindi' },
  { code: 'russian', name: 'Russian' },
  { code: 'turkish', name: 'Turkish' },
  { code: 'swahili', name: 'Swahili' },
];

export const TRANSLATE_CODES = new Set(TRANSLATE_LANGUAGES.map((l) => l.code));

/** Whisper's language codes for the languages above (to label a transcription). */
export const WHISPER_TO_LANGUAGE: Record<string, string> = {
  en: 'english', fr: 'french', es: 'spanish', pt: 'portuguese', de: 'german', it: 'italian', nl: 'dutch',
  ar: 'arabic', zh: 'chinese', ja: 'japanese', ko: 'korean', hi: 'hindi', ru: 'russian', tr: 'turkish',
  sw: 'swahili', ha: 'hausa', yo: 'yoruba', zu: 'zulu',
};
