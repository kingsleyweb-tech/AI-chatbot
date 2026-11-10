/** Release notes built from the project's commit history. Dates are real. */
export interface Release {
  date: string; // ISO
  version?: string;
  title: string;
  tag: 'New' | 'Improved' | 'Fixed' | 'Security';
  items: string[];
}

export const RELEASES: Release[] = [
  {
    date: '2026-11-09',
    title: 'Messages to users, approval notices and sign-in with phone',
    tag: 'New',
    items: [
      'Sign in with your email address or your phone number',
      'New accounts go straight to the verification code, then the dashboard',
      'Approval notices by SMS and email when your account is approved',
      'Administrators can message users with ready-made templates',
    ],
  },
  {
    date: '2026-11-09',
    title: 'Free models only',
    tag: 'Security',
    items: ['Every AI request is checked on the server so only free models are used', 'No automatic paid usage'],
  },
  {
    date: '2026-11-09',
    version: '1.21.0',
    title: 'Codes that verify themselves',
    tag: 'Improved',
    items: [
      'Verification codes are checked as soon as you finish typing',
      'Password reset codes are also sent by SMS to a verified phone',
      'Email verification uses Atlas codes only',
    ],
  },
  {
    date: '2026-11-09',
    title: 'Email, sign-in alerts and device security',
    tag: 'Security',
    items: [
      'Transactional email through Brevo: codes, sign-in alerts and support notices',
      'Alerts only for sign-ins from a new device',
      'Removing a device signs out only that device',
    ],
  },
  {
    date: '2026-11-09',
    title: 'Sources button',
    tag: 'New',
    items: ['A Sources button with site logos opens every source behind a web answer', 'No repeated source list at the end of answers'],
  },
  {
    date: '2026-11-09',
    title: 'Current news and Atlas knowledge',
    tag: 'New',
    items: [
      'Current news from several sources with strict publication dates',
      'A verified central knowledge base that administrators manage',
      'Sports tables and follow-up questions search the web',
    ],
  },
  {
    date: '2026-11-09',
    title: 'Voice Mode, natural voices and translation',
    tag: 'New',
    items: [
      'Voice Mode: a hands-free spoken conversation you can interrupt',
      'ElevenLabs voices as an option alongside the default natural voice',
      'Translate replies while keeping their formatting',
      'Replies keep generating when you leave the page',
    ],
  },
  {
    date: '2026-11-08',
    title: 'Image creation and editing',
    tag: 'New',
    items: ['Create and edit images with Cloudflare Workers AI', 'Clear explanations when a picture is blocked by a safety filter', 'Terms and Privacy 1.3'],
  },
  {
    date: '2026-11-08',
    version: '1.20.0',
    title: 'Consent, automatic approval and analytics choice',
    tag: 'Improved',
    items: [
      'Terms and Privacy acceptance with version history',
      'Automatic approval for verified accounts',
      'Google Analytics only after you allow it',
      'Every reply is stored permanently so none disappear',
    ],
  },
  {
    date: '2026-11-08',
    version: '1.19.0',
    title: 'Sessions and security headers',
    tag: 'Security',
    items: ['Session management and sign-out after inactivity', 'Route guards on every signed-in page', 'Content Security Policy'],
  },
  {
    date: '2026-11-08',
    version: '1.18.0',
    title: 'SMS verification and support',
    tag: 'New',
    items: [
      'Phone verification codes by SMS with delivery tracking',
      'Report an issue, follow your reports and get replies in the app',
      'Notifications and a Help Centre',
    ],
  },
  {
    date: '2026-11-08',
    title: 'Accounts, approval and mobile polish',
    tag: 'New',
    items: [
      'Google and email sign-in with phone verification',
      'Administrator-approved access and an account security page',
      'Memory management, finger-sized tap targets and no sideways scrolling on phones',
    ],
  },
  {
    date: '2026-11-07',
    title: 'Atlas AI is born',
    tag: 'New',
    items: [
      'Streaming chat with memory, projects, documents and saved items',
      'Web search through SerpAPI and Tavily, with Deep Research',
      'Capability-aware model routing, with Google Gemini as the primary provider',
      'A knowledge base with hybrid retrieval',
    ],
  },
];
