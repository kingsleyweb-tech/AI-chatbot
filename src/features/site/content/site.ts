/**
 * Public website configuration: navigation, footer, announcement and the
 * metadata of every public route. Plain data with no React or path aliases,
 * so the build-time prerender (dev/site-prerender.ts) can import it too.
 *
 * Accuracy rule: describe only what Atlas AI does today. No invented
 * customers, numbers, partnerships, prices or certifications.
 */

export const SITE_URL = 'https://chatatlasai.vercel.app';
export const SITE_NAME = 'Atlas AI';
export const SITE_TAGLINE = 'Think further. Do more.';
export const SITE_DESCRIPTION =
  'Atlas AI is an AI assistant for thinking, creating and discovering: chat, live web search with sources, Deep Research, documents, images and voice in one workspace.';
/** Public contact address (already published in the Privacy Policy). */
export const SITE_EMAIL = 'kingsleyanaab99@gmail.com';
export const OG_IMAGE = '/og/atlas-og.png';

/** Announcement bar. Set `text` to an empty string to hide it (hidden for now). */
export const ANNOUNCEMENT = {
  text: '',
  linkLabel: 'See what changed',
  href: '/changelog',
};

export interface NavLink {
  label: string;
  href: string;
  description?: string;
  /** lucide icon name, resolved in the header */
  icon?: string;
}
export interface NavGroup {
  label: string;
  columns: { heading: string; links: NavLink[] }[];
}

export const NAV: (NavGroup | NavLink)[] = [
  {
    label: 'Product',
    columns: [
      {
        heading: 'Product',
        links: [
          { label: 'Features', href: '/features', description: 'Everything Atlas AI can do today', icon: 'Sparkles' },
          { label: 'Integrations', href: '/integrations', description: 'The services that power Atlas AI', icon: 'Blocks' },
          { label: 'Changelog', href: '/changelog', description: 'Every release, with dates', icon: 'History' },
        ],
      },
      {
        heading: 'Capabilities',
        links: [
          { label: 'Web search & Deep Research', href: '/features#research', description: 'Current answers with their sources', icon: 'Globe' },
          { label: 'Documents', href: '/features#documents', description: 'Ask questions about your files', icon: 'FileText' },
          { label: 'Voice Mode', href: '/features#voice', description: 'A spoken, hands-free conversation', icon: 'AudioLines' },
          { label: 'Images', href: '/features#images', description: 'Create, edit and understand images', icon: 'ImageIcon' },
        ],
      },
    ],
  },
  {
    label: 'Resources',
    columns: [
      {
        heading: 'Learn',
        links: [
          { label: 'Documentation', href: '/docs', description: 'Guides for every part of Atlas AI', icon: 'BookOpen' },
          { label: 'Help Centre', href: '/help-centre', description: 'Quick answers to common questions', icon: 'LifeBuoy' },
          { label: 'Blog', href: '/blog', description: 'Articles about how Atlas AI works', icon: 'Newspaper' },
        ],
      },
      {
        heading: 'Company',
        links: [
          { label: 'About', href: '/about', description: 'Who builds Atlas AI and why', icon: 'Compass' },
          { label: 'Status', href: '/status', description: 'Services Atlas AI depends on', icon: 'Activity' },
          { label: 'Contact', href: '/contact', description: 'Questions, feedback and security reports', icon: 'Mail' },
        ],
      },
    ],
  },
  { label: 'Trust', href: '/trust' },
  { label: 'Docs', href: '/docs' },
];

export const FOOTER: { heading: string; links: NavLink[] }[] = [
  {
    heading: 'Product',
    links: [
      { label: 'Features', href: '/features' },
      { label: 'Integrations', href: '/integrations' },
      { label: 'Changelog', href: '/changelog' },
      { label: 'Pricing', href: '/pricing' },
      { label: 'Status', href: '/status' },
    ],
  },
  {
    heading: 'Resources',
    links: [
      { label: 'Documentation', href: '/docs' },
      { label: 'Help Centre', href: '/help-centre' },
      { label: 'Blog', href: '/blog' },
      { label: 'Getting started', href: '/docs/getting-started' },
    ],
  },
  {
    heading: 'Company',
    links: [
      { label: 'About', href: '/about' },
      { label: 'Contact', href: '/contact' },
      { label: 'Trust & security', href: '/trust' },
      { label: 'Accessibility', href: '/accessibility' },
    ],
  },
  {
    heading: 'Legal',
    links: [
      { label: 'Privacy Policy', href: '/privacy' },
      { label: 'Terms of Use', href: '/terms' },
      { label: 'Cookie Policy', href: '/cookies' },
      { label: 'Acceptable Use', href: '/acceptable-use' },
      { label: 'AI Transparency', href: '/ai-transparency' },
    ],
  },
];

export interface PageMeta {
  path: string;
  title: string;
  description: string;
  /** keep out of search engines and the sitemap */
  noindex?: boolean;
  /** breadcrumb label, defaults to the title */
  crumb?: string;
}

/** Static public routes. Docs and blog articles are added from their own data. */
export const PAGES: PageMeta[] = [
  { path: '/', title: 'Atlas AI: Think further. Do more.', description: SITE_DESCRIPTION, crumb: 'Home' },
  {
    path: '/about',
    title: 'About Atlas AI',
    description: 'Why Atlas AI exists, how it is built and the principles behind it: accuracy, privacy and honest answers.',
    crumb: 'About',
  },
  {
    path: '/features',
    title: 'Features',
    description: 'Chat, live web search with sources, Deep Research, documents, images, voice, memory and projects. Everything Atlas AI can do today.',
  },
  {
    path: '/integrations',
    title: 'Integrations',
    description: 'The AI models, search providers and infrastructure that power Atlas AI, and what each one is used for.',
  },
  { path: '/docs', title: 'Documentation', description: 'Guides for getting started, chatting, research, documents, voice, account security and privacy in Atlas AI.' },
  { path: '/blog', title: 'Blog', description: 'Articles about Atlas AI: how its features work, practical guides and how it is built.' },
  {
    path: '/trust',
    title: 'Trust & Security',
    description: 'How Atlas AI protects accounts and data today, and what is planned. No invented certifications.',
    crumb: 'Trust',
  },
  { path: '/accessibility', title: 'Accessibility', description: 'Our accessibility approach for Atlas AI, known limitations and how to report a barrier.' },
  { path: '/privacy', title: 'Privacy Policy', description: 'How Atlas AI collects, uses, stores and protects personal information.' },
  { path: '/terms', title: 'Terms of Use', description: 'The terms that apply when you use Atlas AI.' },
  { path: '/cookies', title: 'Cookie Policy', description: 'Which cookies and browser storage Atlas AI uses, and how to control analytics.' },
  { path: '/acceptable-use', title: 'Acceptable Use Policy', description: 'What you may and may not do with Atlas AI.', crumb: 'Acceptable Use' },
  {
    path: '/ai-transparency',
    title: 'AI Transparency',
    description: 'Which AI models Atlas AI uses, how requests are routed, the limits of AI answers and how sources are shown.',
  },
  { path: '/contact', title: 'Contact', description: 'How to reach Atlas AI for support, feedback, privacy requests and security reports.' },
  { path: '/help-centre', title: 'Help Centre', description: 'Quick answers about accounts, chat, search, documents, voice and privacy in Atlas AI.' },
  { path: '/changelog', title: 'Changelog', description: 'Every Atlas AI release, with real dates and what changed.' },
  { path: '/status', title: 'Status', description: 'Service status information for Atlas AI and the providers it depends on.' },
  { path: '/pricing', title: 'Pricing', description: 'Atlas AI pricing has not been published yet.' },
];

export const APP_LINKS = { register: '/register', login: '/login' };

/** "Page · Atlas AI", except the home page title which already names the product. */
export function fullTitle(title: string): string {
  return title.includes('Atlas AI') ? title : `${title} · Atlas AI`;
}
