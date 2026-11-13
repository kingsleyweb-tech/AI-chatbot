/**
 * Public documentation. Written from the app's actual behaviour (src/, server/).
 * Plain data so the build-time prerender can read titles and summaries.
 * There is no public developer API, and the docs say so.
 */

export interface DocArticle {
  slug: string;
  title: string;
  section: DocSection;
  summary: string;
  /** Markdown; ## and ### headings feed the table of contents */
  body: string;
}

export const DOC_SECTIONS = [
  'Getting started',
  'Using Atlas AI',
  'Research & search',
  'Files & media',
  'Voice',
  'Account & security',
  'Privacy & data',
  'Troubleshooting',
  'Developers',
] as const;
export type DocSection = (typeof DOC_SECTIONS)[number];

export const DOCS: DocArticle[] = [
  // ---------------------------------------------------------------- Getting started
  {
    slug: 'getting-started',
    title: 'Getting started',
    section: 'Getting started',
    summary: 'Create an account, verify it and send your first message.',
    body: `Atlas AI is an AI assistant for thinking, creating and discovering. It runs in your browser and can be installed like an app.

## Create your account

1. Open [Create account](/register).
2. Sign up with **Google**, or with an **email address and password**.
3. Email and password accounts verify a **phone number by SMS**. Enter the 6-digit code; it is checked as soon as you finish typing.
4. Accept the **Terms of Use** and **Privacy Policy**.

## Get access

New accounts are reviewed before they can use Atlas AI. Verified accounts are usually approved automatically; otherwise an administrator reviews the request. When your account is approved you get an SMS and an email, and the app opens on its own.

## Send your first message

Type in the message box and press **Enter** (or the send button). Use **Shift + Enter** for a new line.

> AI answers can be wrong or out of date. Check important information before relying on it.

## Next steps

- [Install Atlas AI on your phone or computer](/docs/install)
- [Chatting with Atlas AI](/docs/chatting)
- [Web search and sources](/docs/web-search)`,
  },
  {
    slug: 'install',
    title: 'Install as an app',
    section: 'Getting started',
    summary: 'Add Atlas AI to your home screen or desktop.',
    body: `Atlas AI is a Progressive Web App: it installs from the browser, opens in its own window and updates itself.

## iPhone and iPad

1. Open Atlas AI in **Safari**.
2. Tap **Share**, then **Add to Home Screen**.
3. Tap **Add**.

## Android

Open Atlas AI in Chrome and choose **Install app** from the menu (or the prompt at the bottom of the screen).

## Windows, macOS and Linux

In Chrome or Edge, use the **Install** icon in the address bar.

## Updates

The installed app checks for a new version when you return to it and updates automatically. You never need to reinstall.`,
  },
  {
    slug: 'sign-in',
    title: 'Signing in',
    section: 'Getting started',
    summary: 'Sign in with Google, your email address or your phone number.',
    body: `## Ways to sign in

- **Continue with Google** for Google accounts.
- **Email or phone number and password** for password accounts. You can type either your email address or the phone number you verified.

## New device alerts

When you sign in from a device Atlas AI has not seen before, you get an email alert. If it was not you, change your password and use **Sign out of all devices** in **Settings → Security**.

## Staying signed in

On the web, Atlas AI signs you out after **60 minutes** without activity, with a warning 5 minutes before. Installed apps are not signed out for inactivity.`,
  },

  // ---------------------------------------------------------------- Using Atlas AI
  {
    slug: 'chatting',
    title: 'Chatting with Atlas AI',
    section: 'Using Atlas AI',
    summary: 'Messages, attachments, conversation history and shortcuts.',
    body: `## Conversations

- **New chat** starts a fresh conversation. Earlier conversations are listed in the sidebar, grouped by date.
- Use the menu next to a conversation to **rename**, **save** or **delete** it.
- **Search chats** finds earlier conversations. On desktop press \`Ctrl K\` (\`⌘ K\` on a Mac).

## Attachments

The **+** button in the message box adds:

| Option | What it does |
| --- | --- |
| Photo or image | Up to 6 images for Atlas to read or analyse |
| Upload document | PDF, Word, Excel, PowerPoint, CSV, text and more |
| From document library | Reuse a document you uploaded before |
| Audio to text | Turn a recording into text |

## Replies

Replies stream as they are written. Code appears in highlighted blocks with a copy button, and tables scroll sideways on small screens. If you leave the page, the reply keeps generating and is there when you come back.

## Keyboard

| Keys | Action |
| --- | --- |
| \`Enter\` | Send |
| \`Shift Enter\` | New line |
| \`Ctrl K\` | Search chats |`,
  },
  {
    slug: 'models',
    title: 'AI models and routing',
    section: 'Using Atlas AI',
    summary: 'Which models answer you, and how Atlas switches when needed.',
    body: `## The default

**Google Gemini** answers by default. You can pick another model from the model list above the message box, and set a default in **Settings**.

## Free models only

Atlas AI uses free models only. This is enforced on the server for every AI request, so no request can start paid usage.

## Automatic switching

Badges show what each model can do, such as reading images or handling long documents. If the model you picked cannot handle a request (for example an image sent to a text-only model), Atlas uses a capable model **for that message only** and shows a notice. Your choice is not changed.

## When a provider is unavailable

If a model fails or is busy, Atlas may retry with another model so your answer is not lost. You can see which model answered on each reply.

Read more in [AI Transparency](/ai-transparency).`,
  },
  {
    slug: 'memory',
    title: 'Memory and personalization',
    section: 'Using Atlas AI',
    summary: 'What Atlas remembers, and how to review or delete it.',
    body: `## Memory

Memory stores short facts and preferences you share, such as your name or preferred writing style, so later answers can use them.

- Turn memory on or off in **Settings → Memory**.
- Review, edit or delete memories on the **Memory** page. **Delete all** removes every memory.

## Personalization

Give Atlas standing instructions, for example "answer in British English" or "keep answers short".

## Knowledge base

Save documents and web pages to your **Knowledge base** so Atlas can refer to them. Items are searched by meaning, not just keywords, and you can delete any item at any time.

## Conversation history

Conversations are stored with your account. Within a conversation, Atlas uses earlier messages (and summaries of long conversations) to keep answers consistent. Deleting a conversation removes its messages.`,
  },
  {
    slug: 'projects',
    title: 'Projects and saved items',
    section: 'Using Atlas AI',
    summary: 'Group related work and keep the answers worth returning to.',
    body: `## Projects

A project groups related conversations and gives them shared instructions. Create one from **Projects**, add instructions such as the audience or tone, then start conversations inside it.

## Saved

Save a conversation or a single response from its menu. Everything you saved is collected on the **Saved** page.

## Exporting

**Settings → Security → Export your data** downloads your profile, conversations, memories, projects and activity, as an easy-to-read **PDF** or a complete **JSON** file. To export a single conversation, use **Export as PDF** (or Markdown or text) in that conversation's menu.`,
  },

  // ---------------------------------------------------------------- Research & search
  {
    slug: 'web-search',
    title: 'Web search and sources',
    section: 'Research & search',
    summary: 'When Atlas searches the web and how sources are shown.',
    body: `## Automatic search

With **automatic search** on (Settings → Web search), Atlas searches when a question needs current information, such as news, prices, scores or recent events. Greetings and ordinary questions are answered without searching.

## Forcing a search

Use the **search toggle** (globe) in the message box to search the web for one message.

## Sources

Web answers show a **Sources** button with the logos of the sites used. Open it to see every source with its site and, where known, its date. Numbers in the answer point to those sources.

## Providers and limits

Searches go to **SerpAPI** or **Tavily**. Recent results may be reused from a short-lived cache. Daily and monthly limits apply; when they are reached, Atlas answers without searching and tells you.`,
  },
  {
    slug: 'deep-research',
    title: 'Deep Research',
    section: 'Research & search',
    summary: 'Multi-step research with a structured, sourced report.',
    body: `Deep Research is for questions that need more than one search: comparisons, overviews and reports.

## How it works

1. Atlas plans several searches from your question.
2. It runs them and reads a selection of the most relevant pages, within a fixed budget.
3. It writes a structured report with headings and numbered sources.

## Using it

Turn on **Deep Research** in the message box before you send. It takes longer than a normal answer and uses more of the search allowance.

## Tips

- Say what you want the report to cover and who it is for.
- Ask follow-up questions in the same conversation; Atlas keeps the context.
- Always open the key sources for anything important.`,
  },
  {
    slug: 'news',
    title: 'Current news',
    section: 'Research & search',
    summary: 'How Atlas finds recent reporting and checks dates.',
    body: `Ask about recent events ("What happened in the Premier League this weekend?") and Atlas gathers reporting from news feeds and from search providers.

## Dates are checked

Each article's publication date is checked against the feed, the provider and the address of the page. Dates are treated as **confirmed**, **reported** or **unknown**, and old stories are not presented as new.

## Sources

Every news answer links to the original reporting through the **Sources** button.`,
  },

  // ---------------------------------------------------------------- Files & media
  {
    slug: 'documents',
    title: 'Documents',
    section: 'Files & media',
    summary: 'Supported file types, limits and how documents are read.',
    body: `Upload files in **Documents** or attach them to a conversation.

## Supported files

PDF, Word (.docx), Excel (.xlsx, .xls), CSV and TSV, PowerPoint (.pptx), text, Markdown, JSON and HTML, up to **25 MB** each.

Older .doc and .ppt files are not supported; save them as .docx or .pptx first. Scanned PDFs without selectable text cannot be read.

## How documents are read

- Text is extracted **in your browser** and stored with your account.
- For long documents, Atlas searches for the most relevant sections and tells you whether it read the whole document or only parts.
- Spreadsheet calculations are worked out from the data, then explained.

## Deleting

Delete a document at any time from **Documents**.`,
  },
  {
    slug: 'images',
    title: 'Images',
    section: 'Files & media',
    summary: 'Ask about images, and create or edit pictures.',
    body: `## Understanding images

Attach up to **6 images** per message. Atlas can describe photos, read screenshots and analyse charts. Images are compressed before upload. If your model cannot read images, Atlas uses one that can for that message.

## Creating images

Ask for a picture ("Create an image of a lighthouse at dawn, watercolour style"). Atlas uses **Cloudflare Workers AI** image models.

## Editing images

Attach an image and describe the change. The source image is sent with your request.

## Safety

Every image prompt is checked before it is created. If a request is refused, Atlas explains why. Images you create are stored with your account, visible only to you, and deleted with the conversation or your account.`,
  },

  // ---------------------------------------------------------------- Voice
  {
    slug: 'voice',
    title: 'Voice, dictation and translation',
    section: 'Voice',
    summary: 'Dictate messages, hear replies and translate answers.',
    body: `## Dictation

Tap the microphone to speak a message. Speech is turned into text with **Whisper** on Cloudflare, then you can edit it before sending.

## Listening to replies

Tap the speaker on a reply to hear it. The default natural voice runs on Cloudflare. In **Settings → Voice** you can choose an **ElevenLabs** voice instead, and set its speed.

## Audio to text

Use **+ → Audio to text** to transcribe a recording (MP3, M4A, WAV and other common formats).

## Translation

Use **Translate** on a reply, pick a language and Atlas translates it while keeping headings, lists, tables and code in place.`,
  },
  {
    slug: 'voice-mode',
    title: 'Voice Mode',
    section: 'Voice',
    summary: 'A continuous, hands-free spoken conversation.',
    body: `Voice Mode lets you talk with Atlas AI without tapping between turns.

## How it works

1. Open **Voice Mode** from the message box and allow the microphone.
2. Speak. Atlas notices when you finish your turn.
3. Atlas answers aloud, sentence by sentence, while the reply is still being written.
4. It starts listening again automatically.

Everything you say is saved in the conversation like a typed message, so you can scroll back or continue in text.

## Interrupting

Just start talking. Background noise and distant voices are ignored; clear speech stops the reply and your new message is sent. You can also tap the orb or **Interrupt**.

## Tips

Use headphones in noisy places for the best results.`,
  },

  // ---------------------------------------------------------------- Account & security
  {
    slug: 'account-security',
    title: 'Account security',
    section: 'Account & security',
    summary: 'Verification, sign-in alerts, sessions and devices.',
    body: `## Verification

- Password accounts verify a **phone number by SMS**. One number can verify only one account.
- Email verification uses a 6-digit code sent by email.

## Activity and devices

**Settings → Security** shows recent sign-ins and security events and the devices signed in to your account.

- **Remove** a device to sign it out.
- **Sign out of all devices** ends every session.

## Alerts

You get an email when your account is used on a new device.

## Inactivity

On the web you are signed out after 60 minutes without activity. Installed apps stay signed in.`,
  },
  {
    slug: 'password-reset',
    title: 'Resetting your password',
    section: 'Account & security',
    summary: 'Reset a forgotten password with a code.',
    body: `1. On the sign-in screen choose **Forgot password**.
2. Enter your email address.
3. Enter the code sent by email. If your phone is verified, the code is also sent by SMS.
4. Choose a new password.

Codes expire after a few minutes and allow only a few attempts. **Never share a code**; Atlas staff will never ask for it.

Signed up with Google? There is no Atlas password to reset. Use **Continue with Google**.`,
  },
  {
    slug: 'access-approval',
    title: 'Account approval',
    section: 'Account & security',
    summary: 'Why new accounts are reviewed and what each status means.',
    body: `Atlas AI reviews new accounts to keep the service safe and within its limits.

| Status | Meaning |
| --- | --- |
| Pending | Your request is waiting for review |
| Approved | You can use Atlas AI. You get an SMS and an email |
| Not approved | The request was declined. You can contact us |

Check your status on the request screen with **Refresh status**. The app opens automatically once you are approved.`,
  },
  {
    slug: 'delete-account',
    title: 'Exporting data and deleting your account',
    section: 'Account & security',
    summary: 'Download your data, or delete your account.',
    body: `## Download your data

**Settings → Security → Export your data** downloads your profile, conversations, memories, projects and activity, as an easy-to-read **PDF** or a complete **JSON** file. To export a single conversation, use **Export as PDF** (or Markdown or text) in that conversation's menu.

## Delete your account

**Settings → Security → Delete account** disables your account immediately (you confirm by typing DELETE and entering a code sent to your email). To change your mind, press **Cancel deletion** in the email you receive (a reminder follows 7 days before the end), or choose **Ask to restore it** on the sign-in screen. It is permanently deleted after **30 days**; until then an administrator can restore it if you change your mind.`,
  },

  // ---------------------------------------------------------------- Privacy & data
  {
    slug: 'data-and-privacy',
    title: 'How your data is handled',
    section: 'Privacy & data',
    summary: 'Where your data is stored and who processes it.',
    body: `## Storage

Conversations, memories and documents are stored in Atlas AI's Firebase database. Security rules limit each account to its own data.

## Processing

To answer you, your message and relevant context go through the Atlas server to the AI provider of the model in use (Google Gemini, or a provider reached through OpenRouter). Web searches go to SerpAPI or Tavily. Images, speech and translation use Cloudflare Workers AI; ElevenLabs only if you choose its voices.

## Administrators

Administrators manage accounts and access. They can see account details, when each account was last active and a log of account events such as sign-ins, but they cannot read your conversations in the app.

## Analytics

Google Analytics loads only if you allow it, and you can withdraw at any time.

The full details are in the [Privacy Policy](/privacy).`,
  },
  {
    slug: 'responsible-use',
    title: 'Using AI responsibly',
    section: 'Privacy & data',
    summary: 'The limits of AI answers and how to check them.',
    body: `AI models predict likely text. They can be confidently wrong, miss recent events or misread a source.

## Good habits

- Open the **Sources** for facts that matter.
- Do not rely on Atlas AI alone for medical, legal, financial or safety decisions.
- Do not share passwords, codes or other people's private information.
- Review generated text and images before you publish them.

See the [Acceptable Use Policy](/acceptable-use) and [AI Transparency](/ai-transparency).`,
  },

  // ---------------------------------------------------------------- Troubleshooting
  {
    slug: 'troubleshooting',
    title: 'Common problems',
    section: 'Troubleshooting',
    summary: 'Fixes for codes, microphones, uploads and updates.',
    body: `## I did not get an SMS code

Check the number and country code, wait a minute and use **Resend**. Codes are limited per day to prevent abuse.

## The microphone does not work

Allow microphone access for the site in your browser settings. On iPhone, use Safari or the installed app.

## A document says no text was found

The file is probably a scanned PDF. Export it with selectable text, or copy the text into the message.

## The app looks out of date

Close and reopen the app; it checks for a new version when it returns to view.

## Still stuck?

Signed in: open **Settings → Report an issue**. Otherwise see [Contact](/contact).`,
  },
  {
    slug: 'reporting-problems',
    title: 'Reporting a problem',
    section: 'Troubleshooting',
    summary: 'Send a report and follow its progress.',
    body: `1. Open **Settings → Report an issue**.
2. Choose a category, add a title and describe what happened. You can attach up to 3 screenshots.
3. Send. You get a reference number such as \`ATL-2611-7KQ3M\`.

Follow reports in **Settings → My reports**: read replies, send more details, and confirm the fix or reopen it. You get a notification when Atlas Support replies.

Do not include passwords or verification codes in a report.`,
  },

  // ---------------------------------------------------------------- Developers
  {
    slug: 'developers',
    title: 'Developers and the API',
    section: 'Developers',
    summary: 'Atlas AI does not offer a public API yet.',
    body: `Atlas AI does **not** currently offer a public developer API, SDK or API keys.

The server endpoints used by the app are private: every request is authenticated, authorised and rate limited, and they may change without notice. Please do not call them from your own code.

## Interested in an API?

Tell us what you would build through [Contact](/contact). If a public API is released, it will be announced in the [Changelog](/changelog) and documented here.`,
  },
];

/** Headings (## and ###) for the table of contents and search. */
export function docHeadings(body: string): { level: 2 | 3; text: string; id: string }[] {
  const out: { level: 2 | 3; text: string; id: string }[] = [];
  let inCode = false;
  for (const line of body.split('\n')) {
    if (line.startsWith('```')) inCode = !inCode;
    if (inCode) continue;
    const m = /^(##|###)\s+(.+)$/.exec(line);
    if (m) out.push({ level: m[1].length as 2 | 3, text: m[2].trim(), id: slugify(m[2]) });
  }
  return out;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Ranked search over titles, summaries, headings and body. */
export function searchDocs(q: string, docs: DocArticle[] = DOCS): DocArticle[] {
  const terms = q.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  if (!terms.length) return [];
  return docs
    .map((d) => {
      const title = d.title.toLowerCase();
      const meta = `${d.summary} ${docHeadings(d.body).map((h) => h.text).join(' ')}`.toLowerCase();
      const body = d.body.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (title.includes(t)) score += 6;
        if (meta.includes(t)) score += 3;
        if (body.includes(t)) score += 1;
      }
      return { d, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.d);
}
