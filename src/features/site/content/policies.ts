/**
 * Public policies alongside the Privacy Policy and Terms (version 1.4, accepted
 * by users). Every statement is checked against the code; nothing is invented.
 * Change `updated` whenever a policy changes.
 */

export interface Policy {
  slug: 'cookies' | 'acceptable-use' | 'ai-transparency' | 'accessibility';
  title: string;
  intro: string;
  updated: string;
  body: string;
}

export const POLICIES_UPDATED = '9 November 2026';

export const POLICIES: Record<Policy['slug'], Policy> = {
  cookies: {
    slug: 'cookies',
    title: 'Cookie Policy',
    intro: 'Atlas AI uses very little browser storage, and no advertising cookies. This page lists what is stored in your browser and why.',
    updated: POLICIES_UPDATED,
    body: `## Essential storage

These are needed for Atlas AI to work and are always on. They stay in your browser; most are not cookies but local storage.

| What | Where | Why |
| --- | --- | --- |
| Sign-in session | IndexedDB / local storage (Firebase Authentication) | Keeps you signed in |
| Device identifier | Local storage (\`atlas.deviceId\`) | Recognises this device for session security and new-device alerts |
| Preferences | Local storage (\`tessera.appearance\`, \`tessera.sidebar\`, \`atlas:translateTarget\`) | Theme, accent colour, sidebar and last translation language |
| Model list cache | Local storage (\`tessera.catalog.v1\`) | Opens the model list faster |
| Reminders | Local storage (\`atlas.phoneReminderShown\`, \`atlas.emailReminderShown\`) | Avoids showing the same reminder twice |
| Offline copy | Service worker cache | Lets the installed app open quickly and offline |
| Analytics choice | Local storage (\`atlas.analyticsConsent\`) | Remembers whether you allowed analytics |

## Optional analytics

**Google Analytics** is off by default. It loads only if you choose **Allow** in the analytics banner or turn on **Usage analytics** in Settings. It sets the cookies \`_ga\` and \`_ga_<id>\`.

If you decline or later withdraw, collection stops and Atlas AI removes those cookies from your browser.

## What we do not use

- No advertising or cross-site tracking cookies.
- No social media trackers. Share links on the blog are plain links.

## Your choices

- Change your analytics choice at any time on the [Privacy Policy](/privacy) page or in **Settings → Security**.
- Clearing site data in your browser removes all of the above and signs you out.

## Contact

Questions about this policy: see [Contact](/contact).`,
  },

  'acceptable-use': {
    slug: 'acceptable-use',
    title: 'Acceptable Use Policy',
    intro: 'Atlas AI is for thinking, creating and discovering. This policy explains what you may not use it for. It adds detail to the Terms of Use, which take priority.',
    updated: POLICIES_UPDATED,
    body: `## You may not use Atlas AI to

- Break the law, or help someone else break it.
- Create sexual content involving minors, or any content that sexualises minors.
- Harass, threaten, bully or incite violence against anyone.
- Create content that promotes hatred against people because of a protected characteristic.
- Impersonate real people or organisations in a way that misleads, or create fake records, reviews or documents presented as genuine.
- Create malware, phishing pages or instructions for attacking systems you are not authorised to test.
- Seek serious help with weapons capable of mass harm.
- Collect or reveal other people's private information without a lawful reason.
- Generate spam or run automated, bulk or scripted access to the service.

## Protecting the service

- Do not try to get around rate limits, usage limits, safety checks or account approval.
- Do not probe, scan or test Atlas AI's security without written permission.
- Do not share your account or verification codes.
- Do not call the app's private server endpoints from your own code.

## Professional advice

Atlas AI does not give professional medical, legal, financial or safety advice. Check important information with a qualified person.

## Enforcement

Requests may be refused by safety checks. Accounts that break this policy may be suspended or removed, as described in the [Terms of Use](/terms).

## Reporting misuse

Signed in: **Settings → Report an issue**. Otherwise see [Contact](/contact).`,
  },

  'ai-transparency': {
    slug: 'ai-transparency',
    title: 'AI Transparency',
    intro: 'Atlas AI is built on AI models from other companies. This page explains which ones, how a request is routed and what AI answers can and cannot do.',
    updated: POLICIES_UPDATED,
    body: `## The models behind Atlas AI

| Task | Provider |
| --- | --- |
| Chat answers (default) | Google Gemini |
| Other chat models you choose, and fallbacks | Free models through OpenRouter |
| Image creation and editing | Cloudflare Workers AI |
| Speech to text, default voice, translation | Cloudflare Workers AI |
| Optional premium voices | ElevenLabs (only if you choose them) |
| Web search and news | SerpAPI and Tavily |

Atlas AI uses **free models only**, enforced on the server.

## How a request is routed

1. Your message goes to the Atlas server, which checks your account and limits.
2. The server decides whether the question needs a web search.
3. It sends your message, relevant context (conversation, memories you allowed, documents you attached) and any search results to the model.
4. If that model cannot handle the request, or is unavailable, another capable model may answer. The app tells you when this happens, and each reply shows which model answered.

## How your data is used by providers

Some free AI services may use prompts and responses to improve their products, and human reviewers may read them. Do not share sensitive personal information in chats. The [Privacy Policy](/privacy) lists each provider and its terms.

## What AI can get wrong

- Answers can be inaccurate, incomplete or out of date, even when they sound confident.
- Models can misread sources or documents.
- Generated images may contain errors or unintended content.

## How we reduce the risk

- Web answers show their **sources**, and news dates are checked.
- Image prompts pass a safety check before any image is created.
- Documents: Atlas says whether it read all of a document or only parts.

## Labelling

Everything Atlas AI writes or creates is AI-generated. If you publish it, review it first and say that AI was used where that matters.`,
  },

  accessibility: {
    slug: 'accessibility',
    title: 'Accessibility',
    intro: 'We want Atlas AI to work for everyone, including people who use assistive technology. This page describes our approach and known limitations.',
    updated: POLICIES_UPDATED,
    body: `## Our target

We aim to meet the **Web Content Accessibility Guidelines (WCAG) 2.2, level AA**. This is a goal, not a claim: Atlas AI has not had an independent accessibility audit.

## What we do

- Semantic page structure with landmarks, one main heading per page and a "Skip to content" link.
- Every action reachable with a keyboard, with a visible focus outline.
- Text alternatives for icons and images that carry meaning.
- Colour contrast checked against AA ratios for text and controls.
- Animations stop when your device asks for **reduced motion**.
- Layouts that work from small phones to large screens, and with browser zoom up to 200%.
- Finger-sized tap targets on phones.
- Voice input and read-aloud replies.

## Known limitations

- Streaming replies are announced as they arrive, which some screen readers may read in pieces.
- Some third-party content, such as linked web pages, is outside our control.
- Code blocks and wide tables scroll sideways on small screens.

## Feedback

If something is hard to use, tell us through [Contact](/contact) or **Settings → Report an issue**. Please describe the page, what you tried and the assistive technology you use.`,
  },
};

