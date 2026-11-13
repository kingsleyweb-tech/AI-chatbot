/** Public Help Centre: short answers that link to the full documentation. */
export interface Faq {
  q: string;
  a: string;
  doc?: string;
}

export const HELP_TOPICS: { title: string; description: string; icon: string; faqs: Faq[] }[] = [
  {
    title: 'Account & access',
    description: 'Signing up, approval and signing in',
    icon: 'UserRound',
    faqs: [
      {
        q: 'How do I create an account?',
        a: 'Open Create account and sign up with Google, or with an email address and password. Password accounts verify a phone number by SMS.',
        doc: '/docs/getting-started',
      },
      {
        q: 'Why is my account pending?',
        a: 'New accounts are reviewed before they can use Atlas AI. You get an SMS and an email when you are approved, and the app opens on its own.',
        doc: '/docs/access-approval',
      },
      { q: 'Can I sign in with my phone number?', a: 'Yes. Password accounts can sign in with either their email address or the phone number they verified.', doc: '/docs/sign-in' },
      {
        q: 'I forgot my password.',
        a: 'Choose Forgot password on the sign-in screen and enter the code sent by email (and by SMS to a verified phone). Google accounts have no Atlas password.',
        doc: '/docs/password-reset',
      },
      { q: 'Why was I signed out?', a: 'On the web, Atlas AI signs you out after 60 minutes without activity. Installed apps stay signed in.', doc: '/docs/sign-in' },
    ],
  },
  {
    title: 'Chat & models',
    description: 'Conversations, models and answers',
    icon: 'MessageSquare',
    faqs: [
      { q: 'Which AI answers me?', a: 'Google Gemini by default. You can choose another free model from the model list; each reply shows which model answered.', doc: '/docs/models' },
      { q: 'Does Atlas AI cost anything?', a: 'Atlas AI uses free AI models only, enforced on the server. Pricing has not been published.', doc: '/pricing' },
      { q: 'Can I find an old conversation?', a: 'Use Search chats in the sidebar, or press Ctrl K on desktop.', doc: '/docs/chatting' },
      { q: 'Can Atlas remember things about me?', a: 'Yes, if memory is on. You can review, edit or delete every memory on the Memory page.', doc: '/docs/memory' },
    ],
  },
  {
    title: 'Search & research',
    description: 'Web search, sources and Deep Research',
    icon: 'Globe',
    faqs: [
      { q: 'When does Atlas search the web?', a: 'When a question needs current information, or when you turn on the search toggle for a message.', doc: '/docs/web-search' },
      { q: 'Where are the sources?', a: 'Web answers have a Sources button listing every site used, with dates where known.', doc: '/docs/web-search' },
      { q: 'What is Deep Research?', a: 'Several searches and page reads within a fixed budget, then a structured report with numbered sources.', doc: '/docs/deep-research' },
    ],
  },
  {
    title: 'Files, images & voice',
    description: 'Documents, pictures, speech and translation',
    icon: 'FileText',
    faqs: [
      { q: 'Which files can I upload?', a: 'PDF, Word (.docx), Excel, CSV, PowerPoint (.pptx), text, Markdown, JSON and HTML, up to 25 MB each.', doc: '/docs/documents' },
      { q: 'Why can’t Atlas read my PDF?', a: 'Scanned PDFs without selectable text cannot be read. Export the file with selectable text.', doc: '/docs/troubleshooting' },
      { q: 'Can Atlas create images?', a: 'Yes. Describe the picture, or attach an image and describe the change.', doc: '/docs/images' },
      { q: 'How do I use Voice Mode?', a: 'Open Voice Mode from the message box, allow the microphone and speak. Talk over Atlas to interrupt.', doc: '/docs/voice-mode' },
    ],
  },
  {
    title: 'Privacy & security',
    description: 'Your data, devices and choices',
    icon: 'ShieldCheck',
    faqs: [
      { q: 'Can administrators read my chats?', a: 'No. Administrators manage accounts and access but cannot read your conversations in the app.', doc: '/docs/data-and-privacy' },
      { q: 'How do I sign out other devices?', a: 'Settings → Security lists your devices. Remove one, or sign out of all devices.', doc: '/docs/account-security' },
      { q: 'How do I delete my account?', a: 'Settings → Security → Delete account, then confirm with the code we email you. It is disabled at once and permanently deleted after 30 days; until then it can be restored.', doc: '/docs/delete-account' },
      { q: 'Does Atlas AI use tracking cookies?', a: 'No advertising cookies. Google Analytics runs only if you allow it.', doc: '/cookies' },
    ],
  },
];
