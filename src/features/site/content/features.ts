import {
  AudioLines,
  BookMarked,
  Brain,
  FileText,
  FolderKanban,
  Globe,
  ImageIcon,
  Languages,
  MessageSquare,
  Newspaper,
  ScanSearch,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';

/** Shipped features only (checked against src/features and server/). */
export interface Feature {
  id: string;
  icon: LucideIcon;
  title: string;
  /** short label for the on-page navigation */
  short: string;
  summary: string;
  points: string[];
  doc?: string;
}

export const FEATURES: Feature[] = [
  {
    id: 'chat',
    short: 'Conversations',
    icon: MessageSquare,
    title: 'Conversations that keep context',
    summary: 'Ask, follow up and refine. Atlas AI keeps the thread so every answer builds on the last.',
    points: [
      'Google Gemini answers by default; pick another free model from the model list at any time',
      'If your model cannot handle a request, Atlas uses a capable one for that message and tells you',
      'Rename, save, search (Ctrl K) and delete conversations',
      'Code blocks with syntax highlighting and a copy button',
    ],
    doc: '/docs/chatting',
  },
  {
    id: 'research',
    short: 'Web search',
    icon: Globe,
    title: 'Live web search with sources',
    summary: 'When a question needs current information, Atlas searches the web and shows where each fact came from.',
    points: [
      'Automatic search when a question needs it, or force it for one message',
      'Numbered sources with the site and, where known, the date',
      'Deep Research runs several searches and page reads, then writes a structured report',
      'Daily limits apply; when they are reached Atlas says so and answers without searching',
    ],
    doc: '/docs/web-search',
  },
  {
    id: 'news',
    short: 'News',
    icon: Newspaper,
    title: 'Current news, with dates checked',
    summary: 'Ask what is happening and Atlas gathers recent reporting from news feeds and search, with publication dates checked.',
    points: ['Recent articles from several sources', 'Each date marked as confirmed, reported or unknown', 'Links to the original reporting'],
    doc: '/docs/news',
  },
  {
    id: 'documents',
    short: 'Documents',
    icon: FileText,
    title: 'Documents you can question',
    summary: 'Upload a report, spreadsheet or slide deck and ask about it in plain language.',
    points: [
      'PDF, Word (.docx), Excel, CSV, PowerPoint (.pptx), text, Markdown, JSON and HTML up to 25 MB',
      'Text is extracted in your browser, then searched for the most relevant sections',
      'Atlas tells you whether it read the whole document or only parts of it',
      'A document library you can reuse across conversations',
    ],
    doc: '/docs/documents',
  },
  {
    id: 'vision',
    short: 'Image understanding',
    icon: ScanSearch,
    title: 'Image understanding',
    summary: 'Attach photos, screenshots or charts and ask Atlas to describe, read or analyse them.',
    points: ['Up to 6 images per message', 'Images are compressed before upload', 'Switches to an image-capable model when needed'],
    doc: '/docs/images',
  },
  {
    id: 'images',
    short: 'Image creation',
    icon: ImageIcon,
    title: 'Image creation and editing',
    summary: 'Describe a picture and Atlas creates it, or edit an image you attach.',
    points: ['Powered by Cloudflare Workers AI image models', 'Every prompt passes a safety check first', 'Your images are private to your account'],
    doc: '/docs/images',
  },
  {
    id: 'voice',
    short: 'Voice',
    icon: AudioLines,
    title: 'Voice and Voice Mode',
    summary: 'Dictate, listen to replies, or talk with Atlas hands-free in a continuous spoken conversation.',
    points: [
      'Voice Mode listens, answers aloud while it writes and lets you interrupt naturally',
      'Speech to text with Whisper; turn audio files into text',
      'A natural voice by default, with ElevenLabs voices as an option',
    ],
    doc: '/docs/voice',
  },
  {
    id: 'translate',
    short: 'Translation',
    icon: Languages,
    title: 'Translation that keeps formatting',
    summary: 'Translate any reply into another language while headings, lists, tables and code stay intact.',
    points: ['Pick the target language, or let Atlas detect the source', 'Markdown structure and code are preserved'],
    doc: '/docs/voice',
  },
  {
    id: 'memory',
    short: 'Memory',
    icon: Brain,
    title: 'Memory and personalization',
    summary: 'Tell Atlas your preferences once. It remembers what you allow and forgets what you delete.',
    points: ['Review, edit or delete every memory', 'Standing instructions in Personalization', 'Turn memory off at any time'],
    doc: '/docs/memory',
  },
  {
    id: 'projects',
    short: 'Projects',
    icon: FolderKanban,
    title: 'Projects and saved work',
    summary: 'Group related conversations with shared instructions, and keep the answers worth returning to.',
    points: ['Projects with their own instructions', 'Saved conversations and responses', 'A knowledge base of documents and pages you saved'],
    doc: '/docs/projects',
  },
  {
    id: 'knowledge',
    short: 'Knowledge base',
    icon: BookMarked,
    title: 'Knowledge base',
    summary: 'Save documents and web pages so Atlas can draw on them when you ask.',
    points: ['Searchable by meaning, not just keywords', 'Kept with your account; delete any item at any time'],
    doc: '/docs/memory',
  },
  {
    id: 'security',
    short: 'Security',
    icon: ShieldCheck,
    title: 'Account security built in',
    summary: 'Every account is verified and reviewed, and you can see and end your own sessions.',
    points: [
      'Phone verification by SMS and email verification codes',
      'New accounts are reviewed before they get access',
      'Sign-in alerts, recent activity and "sign out of all devices"',
      'Automatic sign-out after inactivity',
    ],
    doc: '/docs/account-security',
  },
];
