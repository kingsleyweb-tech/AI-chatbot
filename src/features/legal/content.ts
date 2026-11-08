/**
 * Privacy Policy and Terms of Use: DRAFTS written from how Atlas AI actually
 * works. They have not been reviewed by a lawyer. Items in [brackets] and the
 * "to confirm" lists must be completed by the operator before relying on them.
 */

export const LEGAL_UPDATED = '8 November 2026';

export interface LegalSection {
  heading: string;
  paragraphs?: string[];
  bullets?: string[];
}

export interface LegalDoc {
  title: string;
  intro: string;
  sections: LegalSection[];
  /** Business, legal or operational details the operator still has to confirm. */
  toConfirm: string[];
}

export const PRIVACY: LegalDoc = {
  title: 'Privacy Policy',
  intro:
    'This policy explains what information Atlas AI collects, how it is used, which service providers receive it and the choices you have. It describes how the app works today.',
  sections: [
    {
      heading: 'Who we are',
      paragraphs: [
        'Atlas AI is operated by [operator legal name] ("we", "us"). You can contact us through Settings → Report an issue in the app, or at [contact email].',
      ],
    },
    {
      heading: 'Information we collect',
      bullets: [
        'Account details: your name, email address, profile photo (if your sign-in provider supplies one), sign-in method, and the dates you created your account and last signed in.',
        'Phone number: for email and password accounts, the mobile number you verify by SMS.',
        'Access request: the name, email, phone number and optional reason you give when requesting access, and the administrator’s decision.',
        'Content you create: conversations (your messages and the AI responses), memories, personalization instructions, projects, saved responses, documents you upload (the extracted text, and for presentations some embedded images), knowledge-base items, and images you attach to messages.',
        'Settings and usage: your preferences (theme, default model, search settings), and usage counts such as the number of requests and tokens per model and per day, and web-search counts.',
        'Web search: the search queries Atlas sends for you and the results returned, which are cached with your account for a limited time.',
        'Security records: sign-in events, password and phone changes, and session sign-outs, with a coarse device description (for example "Safari on iPhone"). We do not store your full browser identifier.',
        'Support reports: the title, category, description, screenshots and messages you send, with your name, email and user ID, and replies from Atlas Support.',
      ],
    },
    {
      heading: 'How we use information',
      bullets: [
        'To create and secure your account, verify your email and phone number, and decide whether to grant access.',
        'To answer your messages: your message, relevant earlier messages, memories, personalization and relevant document or knowledge-base excerpts are sent to the AI model you use.',
        'To search the web when you ask, or when automatic search decides a question needs current information.',
        'To show you your usage, enforce usage and cost limits, and prevent abuse.',
        'To respond to support reports and notify you in the app about replies and status changes.',
        'To keep a record of administrator actions (for example approving or suspending an account) for accountability.',
      ],
    },
    {
      heading: 'Sign-in and verification',
      bullets: [
        'Sign-in is provided by Google Firebase Authentication. You can sign in with Google or with an email address and password. Passwords are handled by Firebase Authentication; Atlas AI does not see or store them.',
        'Email and password accounts verify a phone number by SMS. Codes are sent through our SMS provider (Vynfy) from our server. Codes are stored only as one-way hashes, expire after 5 minutes and are limited to a few attempts.',
        'Password recovery uses an email link from Firebase, or an SMS code sent to your verified number.',
      ],
    },
    {
      heading: 'Service providers that receive your information',
      paragraphs: ['We use the following providers to run Atlas AI. They receive only what is needed for their part of the service, and their own terms and privacy policies apply to how they process it.'],
      bullets: [
        'Google Firebase (Authentication, Cloud Firestore database, and Analytics if enabled): stores your account and all app data listed above.',
        'Vercel: hosts the app and runs the server functions that every request passes through.',
        'Google Gemini: receives your messages and related context when you use a Gemini model.',
        'Google Gemini or OpenRouter: receive the text of memories, documents and knowledge-base items to create search embeddings, so relevant passages can be found later.',
        'OpenRouter and the model providers it routes to: receive your messages and related context when you use a model offered through OpenRouter.',
        'SerpAPI and Tavily: receive web-search queries, and for Tavily the addresses of pages to read during research.',
        'Vynfy: receives your phone number and the verification message.',
        'Websites you add to the knowledge base: our server fetches the page address you provide.',
      ],
    },
    {
      heading: 'What we do not do',
      bullets: [
        'We do not sell your personal information.',
        'Atlas AI does not show advertising.',
        'Administrators manage accounts and access, but the app does not give them a way to read your conversations, memories or documents.',
      ],
    },
    {
      heading: 'Image generation',
      paragraphs: ['Atlas AI does not currently generate or edit images. Images you attach are sent to the AI model you use so it can read them.'],
    },
    {
      heading: 'Cookies and local storage',
      paragraphs: [
        'Atlas AI stores a few items in your browser to work properly: your sign-in session (managed by Firebase), your theme and accent colour, whether the sidebar is collapsed, a short-lived copy of your access status and of the model list for faster start-up, and an offline copy of the app itself. If Firebase Analytics is enabled, it may set its own identifiers to measure app usage.',
      ],
    },
    {
      heading: 'How your information is protected',
      bullets: [
        'Database security rules allow each account to read and write only its own records. Support reports are readable only by their author and administrators, and administrator notes only by administrators.',
        'Sensitive operations (phone verification, password recovery, account changes, support reports) run on our server, which checks your identity on every request.',
        'Verification codes and recovery tokens are stored only as one-way hashes. API keys for AI, search and SMS providers are kept on the server and never sent to your browser.',
        'Data is transmitted over HTTPS.',
        'No system is perfectly secure, and we cannot guarantee that information will never be accessed without authorisation.',
      ],
    },
    {
      heading: 'Retention and deletion',
      bullets: [
        'Your content stays in your account until you delete it. You can delete conversations, memories, documents and other items at any time.',
        'If you delete your account, it is disabled immediately and permanently deleted after 30 days, together with your conversations, memories, documents, other account data and your support reports. During those 30 days an administrator can restore it.',
        'Records of administrator actions and of your access request may be kept after your account is deleted, for accountability.',
        'Copies held by service providers are subject to their own retention practices.',
      ],
    },
    {
      heading: 'Your choices and rights',
      bullets: [
        'See and update your profile in Settings.',
        'Download a copy of your data from Settings → Security and activity.',
        'Turn memory and automatic web search on or off.',
        'Delete individual items, or your whole account.',
        'Ask us a question or make a request through Settings → Report an issue, or at [contact email]. Depending on where you live, you may have additional rights under local law.',
      ],
    },
    {
      heading: 'Children',
      paragraphs: ['Atlas AI is not intended for children under [minimum age].'],
    },
    {
      heading: 'Changes to this policy',
      paragraphs: ['We may update this policy as the app changes. We will change the "Last updated" date and, for significant changes, tell you in the app.'],
    },
  ],
  toConfirm: [
    'Operator legal name, address and the contact email for privacy requests.',
    'Governing law and the jurisdictions whose privacy laws apply (for example Ghana’s Data Protection Act, 2012, GDPR or others), the legal bases for processing and any registration with a data protection authority.',
    'Minimum age for using Atlas AI.',
    'Retention periods for administrator logs, access requests, security events and cached search results (today they have no automatic deletion except account purge).',
    'Whether Firebase Analytics is enabled in production, and the regions where Firebase and Vercel store data (international transfers).',
    'Whether each AI provider may use API data for training, based on the plans and settings in use.',
    'How users can make data requests outside the app, and the response time you commit to.',
  ],
};

export const TERMS: LegalDoc = {
  title: 'Terms of Use',
  intro: 'These terms govern your use of Atlas AI. By creating an account or using the app you agree to them. If you do not agree, do not use Atlas AI.',
  sections: [
    {
      heading: 'The service',
      paragraphs: [
        'Atlas AI is an AI assistant provided by [operator legal name]. It lets you chat with AI models, search the web, analyse documents and keep memories and history. Access is by approval: an administrator decides whether to grant, keep or remove access.',
      ],
    },
    {
      heading: 'Your account',
      bullets: [
        'Give accurate information when you register and request access.',
        'Keep your password, devices and verification codes secure. Never share a verification code; Atlas staff will never ask for it.',
        'You are responsible for activity on your account. Tell us promptly through Settings → Report an issue if you think it has been used without permission, and use "Sign out of all devices".',
        'One person per account. Do not share or transfer your account.',
      ],
    },
    {
      heading: 'Acceptable use',
      paragraphs: ['Use Atlas AI lawfully and respectfully. You must not:'],
      bullets: [
        'Break any law, or infringe anyone’s intellectual property, privacy or other rights.',
        'Create or share content that is abusive, harassing, hateful, sexually exploits minors, or promotes violence or self-harm.',
        'Use Atlas AI to create malware, phishing, spam, fraud or deceptive content, or to impersonate others.',
        'Upload personal information about other people without a lawful reason.',
        'Try to gain unauthorised access to accounts, data or systems, test or bypass security, or interfere with the service.',
        'Scrape, overload or automate the service, get around usage or cost limits, or resell access.',
        'Use outputs to make decisions with legal or similarly significant effects on people without appropriate human review.',
      ],
    },
    {
      heading: 'AI responses: limitations and your responsibility',
      bullets: [
        'AI responses are generated automatically and can be inaccurate, incomplete, out of date or biased, even when they sound confident.',
        'Responses are not professional advice. Do not rely on them for medical, legal, financial, safety or other important decisions without checking with a qualified person.',
        'Web search results and sources come from third-party websites that we do not control.',
        'You are responsible for how you use responses, including checking facts and making sure your use is lawful.',
        'Atlas AI does not currently generate or edit images.',
      ],
    },
    {
      heading: 'Your content',
      bullets: [
        'You keep any rights you have in the messages, documents and images you provide ("your content").',
        'You give us permission to store, process and send your content to our service providers only as needed to run Atlas AI for you, as described in the Privacy Policy.',
        'You confirm you have the right to upload your content and that it does not break these terms.',
        'As between you and us, you may use the responses generated for you, subject to these terms, the law and the terms of the AI providers.',
      ],
    },
    {
      heading: 'Usage limits and abuse prevention',
      paragraphs: [
        'We apply limits to requests, web searches, research runs, uploads and support reports to control cost and prevent abuse, and we may change them. We may block or slow requests that look automated or abusive.',
      ],
    },
    {
      heading: 'Suspension and termination',
      bullets: [
        'We may suspend or remove your access, or delete your account, if you break these terms, if your use creates risk or cost for others, or if we stop offering Atlas AI.',
        'You can stop using Atlas AI and delete your account at any time in Settings. Deletion becomes permanent after 30 days.',
      ],
    },
    {
      heading: 'Availability and changes to the service',
      paragraphs: [
        'Atlas AI is provided "as is" and "as available". Features, models and providers may change, be limited or become unavailable, and the service may be interrupted for maintenance or because a provider is down. We do not promise that it will be error-free or always available.',
      ],
    },
    {
      heading: 'Third-party services',
      paragraphs: [
        'Atlas AI relies on third parties such as Google (Firebase and Gemini), OpenRouter and the model providers it routes to, SerpAPI, Tavily, Vynfy and Vercel. Their availability and terms are outside our control.',
      ],
    },
    {
      heading: 'Liability',
      paragraphs: ['[To be completed after legal review: limitation of liability, disclaimers of warranties and any indemnity, as permitted by applicable law.]'],
    },
    {
      heading: 'Changes to these terms',
      paragraphs: ['We may update these terms. We will change the "Last updated" date and, for significant changes, tell you in the app. Continuing to use Atlas AI after a change means you accept the updated terms.'],
    },
    {
      heading: 'Contact',
      paragraphs: ['Questions about these terms: Settings → Report an issue, or [contact email].'],
    },
  ],
  toConfirm: [
    'Operator legal name, address and contact email.',
    'Governing law, jurisdiction and how disputes are resolved.',
    'Limitation of liability, warranty disclaimers and indemnity wording (must be drafted by a lawyer for the applicable law).',
    'Minimum age and whether Atlas AI is for personal use, business use or both.',
    'Whether any fees, paid plans or credits will apply in future.',
    'Notice period for changes to the terms and for ending the service.',
    'Ownership of AI outputs, checked against each AI provider’s current terms.',
  ],
};
