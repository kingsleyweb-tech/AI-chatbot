/**
 * Services Atlas AI uses today, checked against the code (server/*). These are
 * providers Atlas AI calls, not partners or endorsements.
 */

export type IntegrationCategory = 'AI models' | 'Search' | 'Voice & media' | 'Infrastructure' | 'Messaging' | 'Analytics';

export interface Integration {
  name: string;
  /** /brands/*.svg, or null for a lettered tile */
  logo: string | null;
  /** single-colour black logo: inverted in dark mode so it stays visible */
  mono?: boolean;
  category: IntegrationCategory;
  role: string;
  usedFor: string[];
  status: 'In use' | 'Optional';
  site: string;
  statusPage?: string;
}

export const INTEGRATIONS: Integration[] = [
  {
    name: 'Google Gemini',
    logo: '/brands/gemini.svg',
    category: 'AI models',
    role: 'Primary AI provider',
    usedFor: ['Chat answers by default', 'Reading images', 'Long documents'],
    status: 'In use',
    site: 'https://ai.google.dev',
    statusPage: 'https://aistudio.google.com/status',
  },
  {
    name: 'OpenRouter',
    logo: '/brands/openrouter.svg',
    category: 'AI models',
    role: 'Secondary AI provider (free models only)',
    usedFor: ['Models you pick from the model list', 'Fallback when Gemini is unavailable', 'Embeddings for search over your files'],
    status: 'In use',
    site: 'https://openrouter.ai',
    statusPage: 'https://status.openrouter.ai',
  },
  {
    name: 'Cloudflare Workers AI',
    logo: '/brands/cloudflare.svg',
    category: 'Voice & media',
    role: 'Images, speech and translation',
    usedFor: ['Creating and editing images', 'Speech to text (Whisper)', 'The default natural voice', 'Translation that keeps formatting'],
    status: 'In use',
    site: 'https://developers.cloudflare.com/workers-ai/',
    statusPage: 'https://www.cloudflarestatus.com',
  },
  {
    name: 'ElevenLabs',
    logo: '/brands/elevenlabs.svg',
    mono: true,
    category: 'Voice & media',
    role: 'Optional premium voice',
    usedFor: ['Natural voice for replies, when you choose it', 'Voice Mode speech'],
    status: 'Optional',
    site: 'https://elevenlabs.io',
    statusPage: 'https://status.elevenlabs.io',
  },
  {
    name: 'Tavily',
    logo: '/brands/tavily.svg',
    mono: true,
    category: 'Search',
    role: 'Web search',
    usedFor: ['Live web search', 'Deep Research page reading', 'Current news'],
    status: 'In use',
    site: 'https://tavily.com',
  },
  {
    name: 'SerpAPI',
    logo: '/brands/serpapi.svg',
    category: 'Search',
    role: 'Web search',
    usedFor: ['Live web search results', 'News results'],
    status: 'In use',
    site: 'https://serpapi.com',
    statusPage: 'https://serpapi.com/status',
  },
  {
    name: 'Firebase',
    logo: '/brands/firebase.svg',
    category: 'Infrastructure',
    role: 'Accounts and data',
    usedFor: ['Sign-in (Authentication)', 'Your conversations and settings (Firestore)', 'Security rules that keep each account to its own data'],
    status: 'In use',
    site: 'https://firebase.google.com',
    statusPage: 'https://status.firebase.google.com',
  },
  {
    name: 'Vercel',
    logo: '/brands/vercel.svg',
    mono: true,
    category: 'Infrastructure',
    role: 'Hosting and server functions',
    usedFor: ['Serving the website and app', 'The Atlas server that calls AI providers'],
    status: 'In use',
    site: 'https://vercel.com',
    statusPage: 'https://www.vercel-status.com',
  },
  {
    name: 'Brevo',
    logo: '/brands/brevo.svg',
    category: 'Messaging',
    role: 'Transactional email',
    usedFor: ['Verification codes', 'Sign-in alerts', 'Account notices'],
    status: 'In use',
    site: 'https://www.brevo.com',
    statusPage: 'https://status.brevo.com',
  },
  {
    name: 'Vynfy',
    logo: null,
    category: 'Messaging',
    role: 'SMS (Ghana)',
    usedFor: ['Phone verification codes', 'Password reset codes', 'Approval notices'],
    status: 'In use',
    site: 'https://sms.vynfy.com',
  },
  {
    name: 'Google Analytics',
    logo: '/brands/google-analytics.svg',
    category: 'Analytics',
    role: 'Usage analytics, only with your consent',
    usedFor: ['Anonymous page usage, after you allow it', 'Off by default; withdraw any time'],
    status: 'Optional',
    site: 'https://marketingplatform.google.com/about/analytics/',
  },
];

export const INTEGRATION_CATEGORIES: IntegrationCategory[] = ['AI models', 'Search', 'Voice & media', 'Infrastructure', 'Messaging', 'Analytics'];
