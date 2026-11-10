/**
 * The "About Atlas AI" brief added to the system prompt when someone asks who
 * built or owns Atlas AI, or what it runs on. Identity comes from
 * server/shared/identity.ts; model names come from the live configuration, so
 * the answer never lists a model the app cannot use.
 */
import { GEMINI_FREE_TIER } from '../billing/policy.js';
import { FEATURED_MODELS } from '../config/models.js';
import { ELEVEN_MODELS } from '../config/elevenlabs.js';
import { IMAGE_MODELS, SAFETY_MODEL } from '../config/images.js';
import { STT_MODEL, TRANSLATE_MODEL, TTS_MODEL } from '../config/speech.js';
import { CLOUDFLARE_CHAT_MODELS } from '../providers/cloudflare.js';
import { GEMINI_CHAT_MODELS } from '../providers/gemini.js';
import { ATLAS_IDENTITY } from '../shared/identity.js';

const UPPER = new Set(['nvidia', 'vl', 'it', 'ai', 'gpt', 'oss', 'tts', 'stt']);

/** "gemini-3.5-flash-lite" -> "Gemini 3.5 Flash-Lite"; "nvidia/nemotron-3-ultra-550b-a55b:free" -> "NVIDIA Nemotron 3 Ultra 550B A55B". */
export function modelName(id: string): string {
  const raw = id.replace(/^gemini:/, '').replace(/:free$/, '');
  const [vendor, name] = raw.includes('/') ? raw.split('/', 2) : ['', raw];
  const words = name
    .replace(/flash-lite/, 'flash_lite')
    .split('-')
    .map((w) => {
      if (w === 'flash_lite') return 'Flash-Lite';
      if (UPPER.has(w)) return w.toUpperCase();
      if (/^a?\d+(?:\.\d+)?[bm]$/i.test(w)) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
  const v = vendor === 'nvidia' ? 'NVIDIA ' : vendor === 'google' ? 'Google ' : '';
  return (v + words).trim();
}

const list = (xs: string[]) => [...new Set(xs)].join(', ');

export function atlasIdentityBrief(): string {
  const I = ATLAS_IDENTITY;
  const gemini = GEMINI_CHAT_MODELS.filter((m) => GEMINI_FREE_TIER.has(m.id)).map((m) => modelName(m.id));
  const openrouter = FEATURED_MODELS.map((m) => `${modelName(m.id)} (free)`);
  const cfChat = CLOUDFLARE_CHAT_MODELS.map((m) => m.label);
  const images = IMAGE_MODELS.map((m) => m.label);
  const eleven = ELEVEN_MODELS.map((m) => m.id);
  return [
    `## About Atlas AI (verified, from the application's own records)`,
    `This section is authoritative. It overrides your background knowledge and any web results about Atlas AI's identity. ` +
      `Use it only to answer the question asked; don't recite all of it.`,
    ``,
    `- Product: ${I.product}. Tagline: "${I.tagline}"`,
    `- Creator and developer: ${I.creator}. Owner: ${I.owner}.`,
    `- ${I.summary}`,
    ...I.notThis.map((n) => `- ${n}`),
    `- Web results about another organisation called "Atlas AI" are about a different organisation. Never mix their founders, history or funding into an answer about this application.`,
    `- Distinguish the owner (${I.owner}) from the third-party providers below. Providers are suppliers of technology; they do not own, fund or partner with Atlas AI.`,
    ``,
    `Third-party providers:`,
    ...I.providers.map((p) => `- ${p.name}: ${p.role}`),
    ``,
    `Models enabled in the current configuration (all free-tier; availability can change and paid models are blocked):`,
    `- Google Gemini (primary): ${list(gemini)}. Gemini also provides the text embeddings used for memory and search.`,
    `- OpenRouter (secondary, used when Gemini is unavailable or for models picked by the user): ${list(openrouter)}.`,
    `- Cloudflare Workers AI chat models (chosen in the model picker): ${list(cfChat)}.`,
    `- Cloudflare Workers AI images: ${list(images)}, with ${modelName(SAFETY_MODEL.replace('@cf/meta/', ''))} for image safety checks.`,
    `- Cloudflare Workers AI speech: ${STT_MODEL.split('/').pop()} (speech-to-text), ${TTS_MODEL.split('/').pop()} (default voice), ${TRANSLATE_MODEL.split('/').pop()} (translation).`,
    `- ElevenLabs (optional voices): ${list(eleven)}.`,
    `If asked about something not covered here (for example revenue, users or funding), say that information isn't available rather than guessing.`,
  ].join('\n');
}
