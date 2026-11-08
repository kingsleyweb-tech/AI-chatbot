/**
 * Privacy Policy and Terms of Use: DRAFTS written from how Atlas AI actually
 * works today (checked against the code and the production configuration on
 * 8 November 2026). They have not been reviewed by a lawyer.
 *
 * Rules for editing:
 * - Describe only what is implemented. No planned features.
 * - Anything not supplied by the owner or not verifiable stays a visible
 *   [PLACEHOLDER IN CAPITALS]; LegalPage highlights every [...] so it can never
 *   pass for real information.
 * - Sections with `review: true` are flagged "For legal review" on the page.
 * - When the meaning changes, bump TERMS_VERSION / PRIVACY_VERSION in
 *   server/shared/legal.ts and consentOk() in firebase/firestore.rules: every
 *   user is then asked to accept again (earlier acceptances stay in history).
 *
 * Verified facts used here:
 * - Firestore database location: nam5 (Google multi-region, United States).
 * - Vercel server functions: iad1 (Washington, D.C., United States).
 * - Google Analytics for Firebase: enabled in production (measurement ID set;
 *   loaded a few seconds after the page opens, see src/lib/firebase.ts).
 * - Gemini API (Unpaid Services terms, effective 23 March 2026): Google may use
 *   prompts and responses to improve its products; human reviewers may read
 *   them. Users of the API must be 18 or older.
 * - OpenRouter privacy policy (updated 31 August 2026): OpenRouter does not
 *   train on inputs or outputs; some model providers it routes to may.
 * - No automatic deletion except the account purge 30 days after an
 *   administrator schedules deletion (daily job). Users cannot delete their
 *   own account in the app.
 */

export const LEGAL_UPDATED = '8 November 2026';

export interface LegalSection {
  heading: string;
  paragraphs?: string[];
  bullets?: string[];
  /** Drafted wording that must be reviewed by a lawyer before it is relied on. */
  review?: boolean;
}

export interface LegalDoc {
  title: string;
  intro: string;
  sections: LegalSection[];
  /** Business, legal or operational details the owner still has to confirm. */
  toConfirm: string[];
}

export const PRIVACY: LegalDoc = {
  title: 'Privacy Policy',
  intro:
    'This policy explains what information Atlas AI collects, how it is used, where it is stored, which service providers receive it, how long it is kept and the choices you have. It describes how the app works today.',
  sections: [
    {
      heading: 'Who runs Atlas AI',
      paragraphs: [
        'Atlas AI is independently owned and operated by Anaab Kingsley, an individual based in Ghana ("we", "us"). Atlas AI is not a registered company. Google (Gemini) and OpenRouter are third-party AI providers that Atlas AI connects to; they do not own or operate Atlas AI.',
        'Privacy questions and requests: kingsleyanaab99@gmail.com, or Settings → Report an issue in the app.',
      ],
    },
    {
      heading: 'Who can use Atlas AI',
      paragraphs: ['Atlas AI is intended only for people aged 18 or older. We do not knowingly collect information from anyone under 18. If you believe a person under 18 has an account, contact us and we will delete it.'],
    },
    {
      heading: 'Information we collect',
      bullets: [
        'Account details: your name, email address, profile photo (if your sign-in provider supplies one), sign-in method, and the dates you created your account and last signed in.',
        'Phone number: the mobile number you verify by text message. It is required for email and password accounts and optional for Google accounts. If you choose "Skip for now" on the phone reminder, we store when you skipped it.',
        'Acceptance of these documents: the versions of the Terms of Use and Privacy Policy you accepted, the time (from our server) and your sign-in method, with a history of earlier acceptances.',
        'Access request: the name, email, phone number and optional reason you give when requesting access, and the administrator’s decision.',
        'Content you create: conversations (your messages and the AI responses), memories, personalization instructions, projects, saved responses, documents you upload (the extracted text, and for presentations some embedded images), knowledge-base items, and images you attach to messages.',
        'Settings and usage: your preferences (theme, default model, search settings) and usage counts, such as requests and tokens per model and per day and web-search counts.',
        'Web search: the search queries Atlas AI sends for you and the results returned, which are saved with your account so a repeated search can reuse them.',
        'Security records: sign-ins, sign-outs, password and phone changes, with a coarse device description (for example "Safari on iPhone").',
        'Text-message records: for each verification or recovery text, the number it was sent to, the time and whether it was delivered.',
        'Support reports: the title, category, description, screenshots and messages you send, with your name, email and user ID, and replies from Atlas Support.',
        'Error reports: when the app hits an error or a request fails or is slow, a short technical report (the error message with emails, phone numbers and similar details removed, the part of the app involved and the time taken) is written to our server log. It never includes your messages or documents.',
        'Analytics: see "Analytics, cookies and local storage" below.',
      ],
    },
    {
      heading: 'How we use information',
      bullets: [
        'To create and secure your account, verify your email and phone number, record your acceptance of these documents and decide whether to grant access (by an administrator, or automatically when automatic approval is turned on).',
        'To answer your messages: your message, relevant earlier messages, memories, personalization and relevant document or knowledge-base excerpts are sent to the AI model that answers.',
        'To search the web when you ask, or when automatic search decides a question needs current information.',
        'To show you your usage, enforce usage and cost limits and prevent abuse.',
        'To respond to support reports and notify you in the app about replies and status changes.',
        'To keep a record of administrator actions (for example approving or suspending an account) for accountability.',
        'To find and fix errors, and to understand in general terms how the app is used.',
      ],
    },
    {
      heading: 'AI providers and how they use your data',
      paragraphs: [
        'Atlas AI does not train AI models on your data. To answer you, it sends your messages and related context to third-party AI providers, whose own terms decide what they keep and how they use it:',
      ],
      bullets: [
        'Google Gemini. Atlas AI uses the Gemini API under Google’s terms for unpaid use. Under those terms Google may use the prompts and responses it receives to provide, improve and develop its products and machine-learning technology, and human reviewers may read, annotate and process them (Google says it first disconnects them from the account and API key).',
        'OpenRouter. OpenRouter forwards requests to the companies that run each model. OpenRouter’s privacy policy says it does not use inputs or outputs for model training, but that some model providers may use them for training or improvement, under their own policies. Atlas AI mainly uses free models offered through OpenRouter.',
        'Search embeddings: to find relevant passages later, the text of memories, documents and knowledge-base items is sent to Google Gemini or through OpenRouter to create search embeddings.',
        'Because of this, do not enter information you would not want a provider to see or keep, such as passwords, health or financial details, or other people’s personal information.',
      ],
    },
    {
      heading: 'Other service providers',
      paragraphs: ['These providers receive only what they need for their part of the service. Their own terms and privacy policies apply.'],
      bullets: [
        'Google Firebase: sign-in (Firebase Authentication), the database that stores your account and all app data (Cloud Firestore) and Google Analytics.',
        'Vercel: hosts the app and runs the server functions that every request passes through, including their logs.',
        'SerpAPI and Tavily: receive web-search queries, and for Tavily the addresses of pages to read during research.',
        'Vynfy: receives your phone number and the text of verification and recovery messages.',
        'Websites you add to the knowledge base: our server fetches the page address you provide.',
      ],
    },
    {
      heading: 'Where your information is stored',
      bullets: [
        'The Atlas AI database (Cloud Firestore) is in Google’s "nam5" multi-region location in the United States.',
        'Atlas AI’s server functions run on Vercel in the United States (Washington, D.C. region).',
        'Firebase Authentication and Google Analytics are operated on Google’s infrastructure; AI, search and SMS providers process data in their own locations ([VYNFY PROCESSING LOCATION TO BE CONFIRMED]).',
        'This means information you provide in Ghana is transferred to and stored in the United States and other countries whose data protection laws may differ from Ghana’s.',
      ],
    },
    {
      heading: 'Analytics, cookies and local storage',
      paragraphs: [
        'Google Analytics for Firebase is turned on for the Atlas AI website. A few seconds after a page opens it loads and records how the app is used (for example pages viewed and visits), with device and browser details and an approximate location derived from your IP address. It uses its own identifiers stored in your browser. You can block it with your browser’s privacy settings or a content blocker without affecting the app.',
        'Atlas AI also stores a few items in your browser so it works properly: your sign-in session (managed by Firebase), your theme and accent colour, whether the sidebar is collapsed, a short-lived copy of your access status and of the model list for faster start-up, the time of your last activity (for the automatic sign-out after inactivity) and an offline copy of the app itself. Signing out removes the session items and the offline copy of your data.',
      ],
    },
    {
      heading: 'What we do not do',
      bullets: [
        'We do not sell your personal information.',
        'Atlas AI does not show advertising.',
        'Administrators manage accounts and access, but the app does not give them a way to read your conversations, memories or documents.',
        'Atlas AI does not generate or edit images. Images you attach are sent to the AI model so it can read them.',
      ],
    },
    {
      heading: 'How long we keep information',
      paragraphs: [
        'There is currently no automatic deletion of information other than the permanent deletion of an account described below. Specifically:',
      ],
      bullets: [
        'Your content (conversations, memories, documents, projects, knowledge base, saved responses): kept until you delete it or your account is deleted. You can delete individual items at any time.',
        'Profile, settings, usage counts, security records, acceptance history, saved web-search results, support reports and text-message records: kept for as long as your account exists, then deleted with it.',
        'Verification and recovery codes: stored only as one-way hashes; a code stops working after 5 minutes or after too many attempts.',
        'Account deletion: you can ask for your account to be deleted (see "Your rights"). An administrator schedules the deletion: the account is disabled at once and permanently deleted after 30 days by a daily job, together with everything listed above and your sign-in account. During those 30 days it can still be restored.',
        'Kept after an account is deleted: the record of administrator actions (which includes the account’s email address) and the access request record, for accountability. [RETENTION PERIOD FOR THESE RECORDS TO BE DECIDED.]',
        'Server logs at Vercel and Google Analytics data are kept for the periods set by those services. [VERCEL LOG AND GOOGLE ANALYTICS RETENTION PERIODS TO BE CONFIRMED.]',
        'Copies held by AI, search and SMS providers are kept under their own policies and are not deleted by Atlas AI.',
      ],
    },
    {
      heading: 'Your rights',
      review: true,
      paragraphs: [
        'Ghana’s Data Protection Act, 2012 (Act 843) and other laws that may apply give you rights over your personal data, including to access it, to have it corrected, to object to its processing and to ask for it to be deleted. In Atlas AI you can:',
      ],
      bullets: [
        'See and update your profile and phone number in Settings.',
        'Download a copy of your data from Settings → Security and activity.',
        'Turn memory and automatic web search on or off.',
        'Delete individual conversations, memories, documents and other items.',
        'Ask for a copy of your data, a correction, or deletion of your account by writing to kingsleyanaab99@gmail.com or using Settings → Report an issue. We will reply within [RESPONSE TIME TO BE CONFIRMED].',
        'If you are not satisfied with our answer, you may complain to Ghana’s Data Protection Commission.',
      ],
    },
    {
      heading: 'How your information is protected',
      bullets: [
        'Database security rules allow each account to read and write only its own records. Support reports are readable only by their author and administrators.',
        'Sensitive operations (phone verification, password recovery, account changes, approvals, support reports) run on our server, which checks your identity on every request.',
        'Verification codes and recovery tokens are stored only as one-way hashes. API keys for AI, search and SMS providers are kept on the server and never sent to your browser.',
        'Data is sent over HTTPS. On the website you are signed out after 60 minutes without activity.',
        'No system is perfectly secure, and we cannot guarantee that information will never be accessed without authorisation.',
      ],
    },
    {
      heading: 'Changes to this policy',
      paragraphs: [
        'We may update this policy as the app changes. Each version has a number shown at the top of this page. When we publish a new version, Atlas AI asks you to read and accept it before you continue; your earlier acceptances are kept.',
      ],
    },
  ],
  toConfirm: [
    'The response time you commit to for privacy requests.',
    'Registration status with Ghana’s Data Protection Commission. Until confirmed, the documents make no registration or compliance claim.',
    'Whether other privacy laws apply to users outside Ghana, and the legal bases for processing, with legal counsel.',
    'Retention periods for administrator logs and access requests after an account is deleted, for Vercel logs and for Google Analytics (check the Analytics data-retention setting).',
    'Where Vynfy processes and stores phone numbers and messages.',
    'Google’s Gemini API terms say the API is for developers building for professional or business purposes, not for consumer use. Check with counsel whether a paid Gemini plan, a different provider or other changes are needed for a consumer app.',
    'Whether OpenRouter’s account setting allows routing to providers that train on prompts (Settings → Privacy at openrouter.ai); turning that off would let this policy say less is used for training.',
    'Whether to add a cookie or analytics consent banner.',
  ],
};

export const TERMS: LegalDoc = {
  title: 'Terms of Use',
  intro:
    'These terms govern your use of Atlas AI. You must accept them, together with the Privacy Policy, before using the app. If you do not agree, do not use Atlas AI.',
  sections: [
    {
      heading: 'Who provides Atlas AI',
      paragraphs: [
        'Atlas AI is independently owned and operated by Anaab Kingsley, an individual based in Ghana ("we", "us"). Atlas AI is not a registered company. We own the Atlas AI application, its name and branding and its software. Google (Gemini), OpenRouter and the other services listed in the Privacy Policy are independent third parties; they do not own Atlas AI.',
      ],
    },
    {
      heading: 'Eligibility and access',
      bullets: [
        'You must be 18 or older to use Atlas AI.',
        'Access may require approval by an administrator, who decides whether to grant, keep or remove it. When automatic approval is turned on, new accounts are approved without a manual review.',
        'Email and password accounts must verify a mobile number by text message. Text messages can currently be sent only to Ghana (+233) numbers.',
      ],
    },
    {
      heading: 'Your account',
      bullets: [
        'Give accurate information when you register and request access.',
        'Keep your password, devices and verification codes secure. Never share a verification code; we will never ask for it.',
        'You are responsible for activity on your account. Tell us promptly through Settings → Report an issue if you think it has been used without permission, and use "Sign out of all devices".',
        'One person per account. Do not share, sell or transfer your account.',
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
        'Break the usage policies of the AI providers Atlas AI relies on.',
      ],
    },
    {
      heading: 'AI responses: limitations and your responsibility',
      bullets: [
        'AI responses are generated automatically and can be inaccurate, incomplete, out of date or biased, even when they sound confident.',
        'Responses are not professional advice. Do not rely on them for medical, legal, financial, safety or other important decisions without checking with a qualified person.',
        'Web search results and sources come from third-party websites that we do not control.',
        'You are responsible for how you use responses, including checking facts and making sure your use is lawful.',
        'Atlas AI does not generate or edit images.',
      ],
    },
    {
      heading: 'Your content',
      bullets: [
        'You keep any rights you have in the messages, documents and images you provide ("your content").',
        'You allow us to store and process your content, and to send it to our service providers, only as needed to run Atlas AI for you, as described in the Privacy Policy. Some AI providers may use content they receive under their own terms, as the Privacy Policy explains.',
        'You confirm you have the right to provide your content and that it does not break these terms.',
      ],
    },
    {
      heading: 'Ownership of AI-generated outputs',
      review: true,
      bullets: [
        'As between you and us, we do not claim ownership of the responses Atlas AI generates for you ("outputs"), and to the extent we have any rights in them, we assign those rights to you.',
        'You may use outputs for any lawful purpose, subject to these terms and to the terms of the AI provider that produced them.',
        'Outputs may not be unique: other users may receive similar responses. We do not promise that outputs are original, accurate, free of third-party rights or protected by copyright, and you are responsible for checking this before you rely on or publish them.',
      ],
    },
    {
      heading: 'Fees',
      review: true,
      paragraphs: [
        'Atlas AI is currently free to use. We may introduce fees, paid plans or usage-based charges in future. If we do, we will tell you in the app at least 60 days before any charge applies, and you will not be charged unless you agree to the new terms. Usage limits apply to free use and may change.',
      ],
    },
    {
      heading: 'Usage limits and abuse prevention',
      paragraphs: [
        'We apply limits to requests, web searches, research runs, uploads, text messages and support reports to control cost and prevent abuse, and we may change them. We may block or slow requests that look automated or abusive.',
      ],
    },
    {
      heading: 'Suspension and ending your use',
      bullets: [
        'We may suspend or remove your access, or delete your account, if you break these terms, if your use creates risk or cost for others, if the law requires it, or if we stop offering Atlas AI.',
        'You may stop using Atlas AI at any time. To have your account deleted, write to kingsleyanaab99@gmail.com or use Settings → Report an issue; deletion becomes permanent 30 days after it is scheduled, as described in the Privacy Policy.',
      ],
    },
    {
      heading: 'Availability and changes to the service',
      paragraphs: [
        'Features, models and providers may change, be limited or become unavailable, and the service may be interrupted for maintenance or because a provider is down.',
      ],
    },
    {
      heading: 'Third-party services',
      paragraphs: [
        'Atlas AI relies on third parties such as Google (Firebase and Gemini), OpenRouter and the model providers it routes to, SerpAPI, Tavily, Vynfy and Vercel. Their availability and terms are outside our control, and we are not responsible for their acts or omissions.',
      ],
    },
    {
      heading: 'No warranties',
      review: true,
      paragraphs: [
        'To the extent permitted by law, Atlas AI is provided "as is" and "as available", without warranties of any kind, whether express or implied, including warranties of accuracy, fitness for a particular purpose, non-infringement, availability or that the service will be error-free or secure.',
      ],
    },
    {
      heading: 'Limitation of liability',
      review: true,
      bullets: [
        'To the extent permitted by law, we are not liable for any indirect, incidental, special or consequential loss, or for loss of data, profits, revenue or goodwill, arising from your use of, or inability to use, Atlas AI or any output.',
        'To the extent permitted by law, our total liability for all claims relating to Atlas AI is limited to [LIABILITY CAP, E.G. THE GREATER OF THE AMOUNT YOU PAID US IN THE PREVIOUS 12 MONTHS OR GHS [AMOUNT]].',
        'Nothing in these terms excludes or limits liability that cannot be excluded or limited under the law that applies, including Ghanaian consumer protection law.',
      ],
    },
    {
      heading: 'Indemnity',
      review: true,
      paragraphs: [
        'To the extent permitted by law, you agree to compensate us for reasonable losses, costs and claims made by third parties that arise from your breach of these terms, your content, or your unlawful use of Atlas AI or its outputs.',
      ],
    },
    {
      heading: 'Governing law and disputes',
      review: true,
      bullets: [
        'These terms are governed by the laws of the Republic of Ghana. [SUBJECT TO CONFIRMATION BY LEGAL COUNSEL.]',
        'If you have a complaint, please contact us first at kingsleyanaab99@gmail.com or through Settings → Report an issue, and we will try to resolve it informally within 24 hours.',
        'If a dispute cannot be resolved informally, it will be decided by the courts of Ghana, unless the law where you live gives you the right to bring it elsewhere. [DISPUTE FORUM AND ANY ARBITRATION OR MEDIATION STEP TO BE CONFIRMED BY LEGAL COUNSEL.]',
      ],
    },
    {
      heading: 'Changes to these terms',
      paragraphs: [
        'We may update these terms. Each version has a number shown at the top of this page. When we publish a new version, Atlas AI asks you to read and accept it before you continue; if you do not accept, you can stop using Atlas AI and ask for your account to be deleted.',
      ],
    },
    {
      heading: 'Contact',
      paragraphs: ['Questions about these terms: kingsleyanaab99@gmail.com, or Settings → Report an issue.'],
    },
  ],
  toConfirm: [
    'Governing law, the dispute forum and any mediation or arbitration step (drafted as Ghana, subject to legal counsel).',
    'Warranty disclaimer, limitation of liability (including the cap) and indemnity wording, checked against Ghanaian law, including consumer protection law.',
    'Ownership of AI outputs, checked against the current Gemini and OpenRouter (and model provider) terms.',
    'Whether Atlas AI is offered for personal use, business use or both (relevant to Google’s Gemini API terms, which restrict consumer use).',
  ],
};
