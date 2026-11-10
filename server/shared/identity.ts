/**
 * Atlas AI identity: the single, verified record of who created and owns
 * Atlas AI and which outside services it is built on. The chat server adds it
 * to the system prompt for every model (see server/chat/identity.ts), so
 * Gemini, OpenRouter and Cloudflare models all answer the same way. The model
 * names come from the live configuration, not from this file.
 *
 * Plain data, no imports: the public website can use it too.
 * Update this file (and only this file) when ownership or providers change.
 */

export const ATLAS_IDENTITY = {
  product: 'Atlas AI',
  creator: 'Anaab Kingsley',
  owner: 'Anaab Kingsley',
  tagline: 'Think Further. Do More.',
  summary:
    'Atlas AI is an independent AI assistant application, conceptualised, developed, built and owned by Anaab Kingsley. ' +
    'It brings several AI capabilities into one workspace: conversations and reasoning, web search and research, image creation, ' +
    'image understanding, document analysis, programming help and voice conversations.',
  /** Third-party services Atlas AI uses. They are suppliers, not owners, investors or partners. */
  providers: [
    { name: 'Google Gemini', role: 'primary AI model provider' },
    { name: 'OpenRouter', role: 'secondary AI model provider (free models only)' },
    { name: 'Cloudflare Workers AI', role: 'additional AI models: image creation and editing, image safety checks, speech-to-text, the default reading voice and translation' },
    { name: 'ElevenLabs', role: 'optional premium voices for reading aloud and Voice Mode' },
    { name: 'Tavily', role: 'web search and research' },
    { name: 'SerpAPI', role: 'web search and news' },
    { name: 'Firebase', role: 'sign-in, database and file storage' },
    { name: 'Vercel', role: 'application hosting and deployment' },
    { name: 'Brevo', role: 'transactional email, such as verification codes' },
  ],
  /** Other organisations with a similar name that Atlas AI must never be confused with. */
  notThis: [
    'Atlas AI is not the American public benefit corporation associated with Stanford University, David Lobell, Marshall Burke, Stefano Ermon or The Rockefeller Foundation, and has no connection to them.',
    'Atlas AI has no investors, institutional partners, certifications or company history beyond what is stated here.',
  ],
} as const;

const SELF = String.raw`(?:you|yourself|atlas(?:\s*ai)?|this (?:app|application|assistant|chatbot|bot|ai|tool))`;

/** Questions about who made or owns Atlas AI. */
const ORIGIN = [
  new RegExp(String.raw`\bwho\b[^?.!\n]{0,40}\b(?:built|build|builds|made|make|makes|created|create|creates|developed|develop|develops|owns|own|owned|founded|designed|programmed|coded|trained|runs|is behind|are behind|behind)\b[^?.!\n]{0,20}\b${SELF}\b`, 'i'),
  new RegExp(String.raw`\b(?:creator|creators|developer|developers|owner|owners|founder|founders|maker|makers|author|company|ceo)\s+(?:of|behind)\s+${SELF}\b`, 'i'),
  new RegExp(String.raw`\b(?:your|atlas(?:\s*ai)?'?s?)\s+(?:creator|creators|developer|developers|owner|owners|founder|founders|maker|makers|company|parent company|origin|origins|history)\b`, 'i'),
  new RegExp(String.raw`\b(?:who|what company|which company)\s+(?:is|are|was)\s+(?:behind|responsible for)\s+${SELF}\b`, 'i'),
  new RegExp(String.raw`\bwho\s+(?:are|r)\s+(?:you|u)\b`, 'i'),
  new RegExp(String.raw`\b(?:are|is)\s+${SELF}\s+(?:made|built|created|developed|owned|run)\s+by\b`, 'i'),
];

/** Questions about the technology, providers or models behind Atlas AI. */
const TECH_WORD = String.raw`(?:models?|llms?|providers?|technolog(?:y|ies)|tech|stack|services|apis?|engines?|infrastructure)`;

const TECH = [
  // "Which AI models and providers do you use?", "What technologies is Atlas built with?"
  new RegExp(String.raw`\b(?:what|which)\b[^?.!\n]{0,30}\b${TECH_WORD}\b[^?.!\n]{0,30}\b(?:do|does|did|are|is|was|were)\s+${SELF}\s+(?:use|using|run|running|rely|relying|support|offer|work|built|based|powered|made|have)\b`, 'i'),
  new RegExp(String.raw`\b(?:what|which)\s+(?:ai\s+|language\s+|large language\s+)?(?:model|models|llm|llms|provider|providers|technology|technologies|tech|stack|services|apis?|engine|engines)\s+(?:are|is|powers?|runs?)\s+${SELF}\b`, 'i'),
  new RegExp(String.raw`\b(?:what|which)\s+(?:ai\s+)?(?:model|models|llm|llms|provider|providers|technology|technologies|services)\s+(?:do|does|did)\s+${SELF}\s+(?:use|run on|rely on|use for)\b`, 'i'),
  new RegExp(String.raw`\b(?:what|who)\s+(?:powers|is powering|runs|drives)\s+${SELF}\b`, 'i'),
  new RegExp(String.raw`\b(?:your|atlas(?:\s*ai)?'?s?)\s+(?:underlying\s+)?(?:model|models|llm|llms|providers?|technology|technologies|tech stack|stack|infrastructure|architecture)\b`, 'i'),
  new RegExp(String.raw`\b(?:are|is)\s+${SELF}\s+(?:built|based|running|powered|made)\s+(?:on|with|by)\b`, 'i'),
  new RegExp(String.raw`\b(?:what|which)\s+(?:model|llm|ai)\s+(?:are|is)\s+(?:you|atlas)\b`, 'i'),
  new RegExp(String.raw`\b(?:are you|is atlas(?:\s*ai)?)\s+(?:chatgpt|gpt|gemini|claude|llama|openai|google)\b`, 'i'),
  new RegExp(String.raw`\b(?:tell me about|what is|what's|who is)\s+atlas(?:\s*ai)?\b`, 'i'),
  new RegExp(String.raw`\btell me about yourself\b|\bwhat are you\b`, 'i'),
];

/** Whether a message asks about Atlas AI's identity, ownership, development or technology. */
export function isAboutAtlas(text: string): boolean {
  const t = text.slice(0, 600).replace(/[’‘]/g, "'");
  return ORIGIN.some((r) => r.test(t)) || TECH.some((r) => r.test(t));
}
