/**
 * Built-in Help Centre articles. Administrators can override any of these,
 * hide them, or add new ones (helpArticles/{id} in Firestore); the app shows
 * the built-in text when no override exists. Describe only what the app
 * actually does.
 */

export interface HelpArticle {
  id: string;
  title: string;
  category: string;
  summary: string;
  /** Markdown */
  body: string;
  keywords?: string[];
  /** set on administrator overrides */
  hidden?: boolean;
  updatedAt?: number;
  custom?: boolean;
}

export const HELP_CATEGORIES = ['Getting started', 'Using Atlas AI', 'Account', 'Privacy and support'] as const;

export const HELP_ARTICLES: HelpArticle[] = [
  {
    id: 'getting-started',
    title: 'Getting started with Atlas AI',
    category: 'Getting started',
    summary: 'Create an account, get approved and send your first message.',
    keywords: ['sign up', 'register', 'approval', 'install', 'home screen', 'pwa'],
    body: `Atlas AI is a private AI assistant. To start:

1. **Create an account** with Google, or with an email address and password. Email and password accounts also verify a phone number by SMS.
2. **Verify your email** if you signed up with email and password.
3. **Request access.** New accounts are reviewed by an administrator. You can check your status on the request screen with **Refresh status**.
4. Once approved, start typing in the message box and press **Send**.

**Install as an app.** On iPhone, open Atlas AI in Safari, tap **Share**, then **Add to Home Screen**. On Android and desktop, use the browser's **Install** option. The installed app updates itself when a new version is released.`,
  },
  {
    id: 'chat',
    title: 'Chatting with Atlas AI',
    category: 'Using Atlas AI',
    summary: 'Send messages, attach images, use voice and manage conversations.',
    keywords: ['message', 'conversation', 'voice', 'dictation', 'images', 'rename', 'delete', 'saved', 'projects'],
    body: `- **New chat** starts a fresh conversation. Earlier conversations are listed in the sidebar, grouped by date.
- **Images:** attach up to 6 images per message with the attachment button. Images are compressed before they are sent. Models that can read images describe or analyse them; if your chosen model cannot, Atlas switches to a capable model for that message and tells you.
- **Voice:** where your browser supports it, use the microphone to dictate and the speaker button to have a reply read aloud.
- **Manage conversations:** use the menu next to a conversation to rename, save or delete it. **Saved** collects conversations and responses you saved.
- **Projects** group related conversations with shared instructions.
- **Search chats** (Ctrl K on desktop) finds earlier conversations.

AI responses can be wrong or out of date. Check important information before relying on it.`,
  },
  {
    id: 'models',
    title: 'Choosing an AI model',
    category: 'Using Atlas AI',
    summary: 'How model selection and automatic switching work.',
    keywords: ['model', 'gemini', 'openrouter', 'switch', 'default model', 'free', 'paid'],
    body: `Atlas AI uses models from **Google Gemini** and from providers available through **OpenRouter**.

- Choose a model from the model picker above the message box. Set a default in **Settings → Default model**.
- Badges show what each model can do, such as reading images or handling long context.
- If your model cannot handle a request (for example an image with a text-only model), Atlas picks a capable free model for that message and shows a notice. Your chosen model is not changed.
- If only a paid model could handle the request, Atlas asks before using it.
- If a model is unavailable, Atlas may fall back to another model and says so.`,
  },
  {
    id: 'web-search',
    title: 'Web search and Deep Research',
    category: 'Using Atlas AI',
    summary: 'When Atlas searches the web, and how sources and limits work.',
    keywords: ['search', 'internet', 'sources', 'research', 'deep research', 'citations', 'limits'],
    body: `When web search is configured on the server:

- **Automatic search** (Settings → Web search) lets Atlas search when a question needs current information, such as news, prices or recent events. Ordinary questions are answered without searching.
- Use the **search toggle** in the message box to force a search for one message.
- **Deep Research** runs several searches and reads a few pages, then writes a report with numbered sources. It takes longer and uses more of the search allowance.
- Sources are listed under the answer with their site and, where available, the date.
- Searches go to a search provider (SerpAPI or Tavily). Recent results may be reused from a short-lived cache to save requests.
- Daily and monthly search limits apply. When they are reached, Atlas answers without searching and tells you.`,
  },
  {
    id: 'documents',
    title: 'Uploading and analysing documents',
    category: 'Using Atlas AI',
    summary: 'Supported file types, limits and how documents are read.',
    keywords: ['upload', 'pdf', 'word', 'docx', 'excel', 'xlsx', 'csv', 'powerpoint', 'pptx', 'file', 'document'],
    body: `Upload files in **Documents** or attach them to a conversation.

**Supported:** PDF, Word (.docx), Excel (.xlsx, .xls), CSV and TSV, PowerPoint (.pptx), text, Markdown, JSON and HTML. Files must be 25 MB or smaller.

**Not supported:** older .doc and .ppt files (save them as .docx or .pptx first). Scanned PDFs without selectable text cannot be read, because OCR is not configured.

How it works:
- Text is extracted in your browser and stored with your account so Atlas can search it when you ask questions.
- For long documents, Atlas searches for the most relevant sections and tells you whether it read the whole document or only parts of it.
- Spreadsheet calculations are worked out from the data and then explained by the model.

Delete a document at any time from **Documents**.`,
  },
  {
    id: 'image-generation',
    title: 'Image generation',
    category: 'Using Atlas AI',
    summary: 'Atlas AI does not currently create or edit images.',
    keywords: ['image', 'generate', 'picture', 'draw', 'edit image', 'dall-e'],
    body: `Atlas AI **does not currently generate or edit images.** If you ask for an image, the assistant explains that this is not available instead of producing one.

You can still **attach images** to a message so a capable model can read, describe or analyse them.

If you would like image generation, send a **Feature request** from **Settings → Report an issue**.`,
  },
  {
    id: 'memory',
    title: 'Memory and conversation history',
    category: 'Using Atlas AI',
    summary: 'What Atlas remembers, and how to review or delete it.',
    keywords: ['memory', 'remember', 'forget', 'history', 'personalization', 'knowledge base'],
    body: `- **Memory** stores short facts and preferences you share (for example your name or preferred writing style) so later answers can use them. Turn it on or off in **Settings → Memory**.
- Review, edit or delete memories on the **Memory** page. **Delete all** removes every memory.
- **Conversation history** is stored with your account. Atlas may use relevant earlier messages from the same conversation, and summaries of long conversations, to keep answers consistent.
- **Personalization** lets you give Atlas standing instructions.
- The **Knowledge base** holds documents and web pages you saved so Atlas can refer to them.

Deleting a conversation removes its messages.`,
  },
  {
    id: 'account',
    title: 'Managing your account',
    category: 'Account',
    summary: 'Profile, phone number, sign-in methods, sessions, export and deletion.',
    keywords: ['profile', 'phone', 'sign out', 'devices', 'delete account', 'export', 'download data', 'security'],
    body: `In **Settings**:

- **Account:** change your display name, see your email, phone number and sign-in method.
- **Security and activity:** see recent sign-ins and security events, and **sign out of all devices**. Other devices are signed out automatically.
- **Download your data:** export your conversations, memories and other records as a file.
- **Delete account:** your account is disabled immediately and permanently deleted after **30 days**. Until then an administrator can restore it if you change your mind.

Email and password accounts need a verified phone number. Google sign-in does not.`,
  },
  {
    id: 'password-recovery',
    title: 'Recovering your password',
    category: 'Account',
    summary: 'Reset a forgotten password by email or SMS.',
    keywords: ['password', 'forgot', 'reset', 'recover', 'locked out', 'code', 'sms'],
    body: `If you signed up with email and password:

1. On the sign-in screen, choose **Forgot password**.
2. Follow the steps to receive a reset link by email, or a verification code by SMS to your verified phone number.
3. Choose a new password.

Codes expire after 5 minutes and are limited to a few attempts. Never share a code with anyone; Atlas staff will never ask for it.

If you sign in with Google, manage your password in your Google account instead.`,
  },
  {
    id: 'privacy-security',
    title: 'Privacy and security',
    category: 'Privacy and support',
    summary: 'How your data is stored and who can see it.',
    keywords: ['privacy', 'security', 'data', 'third party', 'providers', 'delete'],
    body: `- Your conversations, memories and documents are stored in Atlas AI's Firebase database. Security rules limit each account to its own data.
- To answer you, messages and relevant context are sent through the Atlas server to the AI provider of the model you use (Google Gemini or a provider reached through OpenRouter). Web searches are sent to SerpAPI or Tavily.
- Administrators manage accounts and access but cannot read your conversations in the app.
- Phone verification codes are stored only as one-way hashes and expire quickly.

Read the full **Privacy Policy** and **Terms of Use** from **Settings → About**.`,
  },
  {
    id: 'reporting-problems',
    title: 'Reporting a problem',
    category: 'Privacy and support',
    summary: 'Send a report, follow its progress and reply to Atlas Support.',
    keywords: ['report', 'bug', 'issue', 'support', 'contact', 'feedback', 'feature request', 'help'],
    body: `1. Open **Settings → Report an issue**.
2. Choose a category, add a short title and describe what happened. You can attach up to 3 screenshots.
3. Tap **Send report**. You get a reference number such as **ATL-2611-7KQ3M**.

Follow your reports in **Settings → My reports**:
- Read replies from Atlas Support and send more information or screenshots.
- See status changes: New, Pending, Under review, Awaiting your response, Resolved and Closed.
- When a report is marked **Resolved**, confirm the fix, or **Reopen** it if the problem continues.

You get a notification in the app when Atlas Support replies or changes the status. Do not include passwords or verification codes in a report.`,
  },
];

/** Merge administrator overrides into the built-in articles. */
export function mergeArticles(overrides: HelpArticle[]): HelpArticle[] {
  const byId = new Map(HELP_ARTICLES.map((a) => [a.id, a]));
  for (const o of overrides) byId.set(o.id, { ...byId.get(o.id), ...o, custom: !byId.has(o.id) || o.custom });
  return [...byId.values()].filter((a) => !a.hidden);
}

/** Simple ranked search over title, summary, keywords and body. */
export function searchArticles(articles: HelpArticle[], q: string): HelpArticle[] {
  const terms = q.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  if (!terms.length) return articles;
  const scored = articles.map((a) => {
    const title = a.title.toLowerCase();
    const meta = `${a.summary} ${(a.keywords ?? []).join(' ')}`.toLowerCase();
    const body = a.body.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (title.includes(t)) score += 5;
      if (meta.includes(t)) score += 3;
      if (body.includes(t)) score += 1;
    }
    return { a, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((x, y) => y.score - x.score)
    .map((s) => s.a);
}
