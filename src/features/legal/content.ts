/**
 * Privacy Policy and Terms of Use, version 1.3, as shown on /privacy and /terms.
 *
 * Every statement must describe how Atlas AI works today (checked against the
 * code and the production configuration on 8 November 2026). No planned
 * features, no unconfirmed business details.
 *
 * When the meaning changes, bump TERMS_VERSION / PRIVACY_VERSION in
 * server/shared/legal.ts and consentOk() in firebase/firestore.rules: users are
 * then asked to accept the new version, and earlier acceptances stay in their
 * history (users/{uid}/consents).
 *
 * Verified facts used here:
 * - Firestore location nam5 (US multi-region); Vercel functions iad1 (US).
 * - Google Analytics loads only after the visitor allows it
 *   (src/lib/analyticsConsent.ts); withdrawing removes its cookies.
 * - Gemini API terms (effective 23 March 2026), Unpaid Services: Google may use
 *   prompts and responses to improve its products; human reviewers may read them.
 * - OpenRouter privacy policy: OpenRouter does not train on inputs or outputs;
 *   model providers may. Tested 8 November 2026: with data_collection "deny",
 *   the free Nemotron chat models and the free embedding model are refused
 *   ("Free model training"), so the app does not set "deny".
 * - Vercel runtime logs: 1 hour on the Hobby plan.
 * - Account purge 30 days after an administrator schedules deletion; admin log
 *   entries and the access request deleted 30 days after that
 *   (server/account/retention.ts).
 * - Error reports are scrubbed of emails, phone numbers and tokens
 *   (src/lib/monitor.ts).
 * - Cloudflare Workers AI (server/cloudflare, server/images): called directly
 *   (no AI Gateway), only when the user picks a Cloudflare model or asks for an
 *   image; never an automatic fallback. Image prompts are checked by rules and
 *   by Llama Guard on Workers AI first; an edit also sends the source image.
 *   Created images are stored in Firestore (users/{uid}/generatedImages and
 *   generatedImageData), readable and deletable only by the owner, deleted with
 *   the conversation or the account. Cloudflare's data-usage page (updated
 *   16 October 2026): no training on Workers AI content; inputs and outputs not
 *   kept once no longer needed for standard requests; operational metadata kept.
 */

export const LEGAL_UPDATED = '8 November 2026';
export const CONTACT_EMAIL = 'kingsleyanaab99@gmail.com';

const GEMINI_TERMS = 'https://aistudio.google.com/docs/terms';
const CLOUDFLARE_DATA = 'https://developers.cloudflare.com/workers-ai/platform/data-usage/';
const CLOUDFLARE_PRIVACY = 'https://www.cloudflare.com/privacypolicy/';

export interface LegalSection {
  heading: string;
  paragraphs?: string[];
  bullets?: string[];
}

export interface LegalDoc {
  title: string;
  intro: string;
  sections: LegalSection[];
}

export const PRIVACY: LegalDoc = {
  title: 'Privacy Policy',
  intro:
    'This policy explains what information Atlas AI collects, how it is used, which service providers receive it, where it is stored, how long it is kept and the choices you have. Please read it together with the Terms of Use.',
  sections: [
    {
      heading: 'Who runs Atlas AI',
      paragraphs: [
        'Atlas AI is independently owned and operated by Anaab Kingsley, an individual based in Ghana ("we", "us", "our"). Anaab Kingsley decides how and why your information is processed in Atlas AI.',
        'Google (Gemini), OpenRouter and Cloudflare (Workers AI) are third-party AI providers that Atlas AI connects to. They do not own or operate Atlas AI.',
        `Privacy questions and requests: ${CONTACT_EMAIL}, or Settings → Report an issue in the app.`,
      ],
    },
    {
      heading: 'Who can use Atlas AI',
      paragraphs: [
        'Atlas AI is a general-purpose AI assistant for everyday and professional use. It is intended only for people aged 18 or older. We do not knowingly collect information from anyone under 18. If you believe a person under 18 has an account, contact us and we will arrange for the account to be deleted.',
      ],
    },
    {
      heading: 'Information we collect',
      bullets: [
        'Account details: your name, email address, sign-in method (Google or email and password), the dates you created your account and last signed in, and your profile photo if Google provides one. If you sign in with Google, we receive your name, email address and profile photo from Google. Firebase Authentication manages your password; Atlas AI never sees or stores it.',
        'Phone number: the mobile number you verify by text message. It is required for email and password accounts and optional for Google accounts. If you choose "Skip for now" on the phone reminder, we record when you skipped it.',
        'Acceptance records: the versions of the Terms of Use and Privacy Policy you accepted, the time of acceptance (from our server) and your sign-in method, with a history of earlier acceptances.',
        'Access requests: the name, email address, phone number and optional reason you give when you request access, and the decision on your request.',
        'Content you create: your conversations (your messages and the AI responses), images you attach to messages, memories, the "about me" and custom instructions you write, projects and project instructions, saved responses, the text extracted from documents you upload, and knowledge-base items (including web pages you add, which our server fetches).',
        'Images Atlas AI creates for you: each image you ask for or ask to be edited, with the request text (prompt), the model used, the image format and size, the time it was created, the conversation it belongs to and, for an edited image, which image it was made from.',
        'Information generated from your content: conversation titles, summaries of long conversations, memory notes that Atlas AI saves automatically when memory is turned on, project summaries, and search indexes (numerical "embeddings") of your memories, conversations, documents and knowledge-base items, used to find relevant passages.',
        'Settings and usage: your preferences (such as theme, language, response style, default model and web-search settings), and usage counts such as the number of requests and tokens per model and per day, web-search counts, the number of images created, edited or refused per day, and the Cloudflare Workers AI usage (measured in "Neurons") of your requests.',
        'Web searches: the search queries Atlas AI sends for you and the results returned. These are saved with your account so that a repeated search can reuse them.',
        'Security records: sign-ins, failed sign-ins, sign-outs (including automatic sign-outs), password and phone changes, data exports and other account events, each with a general device description such as "Safari on iPhone".',
        'Text-message records: for each verification or recovery text, the phone number it was sent to, the time, its purpose and whether it was delivered and verified. Verification codes are not kept in these records.',
        'Password-recovery limits: to prevent abuse, we keep the times of recent recovery requests (no more than the last 24 hours) under a one-way hash of the email address and of the IP address used.',
        'Support reports: the title, category, description, screenshots and messages you send, with your name, email address and account ID, replies from Atlas Support, and in-app notifications about them.',
        'Error reports: when the app hits an error or a request fails or is slow, a short technical report (the error message with email addresses, phone numbers and similar details removed, the part of the app involved and the time taken) is written to our server log. It does not include your messages or documents.',
        'Analytics: only if you allow it. See "Analytics, cookies and browser storage".',
      ],
    },
    {
      heading: 'How we use information',
      bullets: [
        'To create and secure your account, verify your email address and phone number, record your acceptance of these documents and decide whether to grant access (by an administrator, or automatically when automatic approval is turned on).',
        'To answer your messages and run the features you use, as described in "AI providers and how they use your data".',
        'To search the web when you ask, or when automatic search decides that a question needs current information.',
        'To create or edit an image when you ask for one, check the request against our rules first, and keep the image in your account so that you can see, download and delete it.',
        'To show you your usage, apply usage and cost limits and prevent abuse.',
        'To respond to support reports and notify you in the app about replies and status changes.',
        'To keep a record of administrator actions (for example approving or suspending an account) for accountability.',
        'To find and fix errors and keep Atlas AI working.',
        'If you allow analytics: to understand in general terms how the app is used.',
      ],
    },
    {
      heading: 'AI providers and how they use your data',
      paragraphs: [
        'Atlas AI does not train AI models on your information. To produce answers, it sends information to third-party AI providers. Google Gemini is the primary provider and OpenRouter is an additional provider. Requests normally go to Gemini; Atlas AI sends a request through OpenRouter when you choose a model offered there, or when a Gemini model is unavailable or cannot handle the request. Cloudflare Workers AI is used only in the two cases described below, and never in place of Gemini or OpenRouter when they are unavailable.',
        'What is sent with a chat message: your message; earlier messages in the conversation (the most recent in full and a summary of older ones); images you attached to recent messages; your name, "about me", custom instructions and response preferences; relevant memories and project information; relevant excerpts from documents you attached and from your knowledge base; and web search results when a search was used.',
        'Images: when your message asks Atlas AI to create a picture, or to change the picture it just created or an image you attached, our server sends the request text to Cloudflare Workers AI. It goes first to a safety model, which checks whether the request is allowed, and then, if it is, to an image model. To edit an image, the image is sent as well. Your name, memories, documents and other parts of the conversation are not sent with an image request. The created image is returned to our server, which stores it in your account.',
        'Cloudflare chat models: if you choose a Cloudflare model in the model picker, your chat messages are sent to Cloudflare Workers AI with the same information as any other chat message.',
        'Background tasks also use these providers: creating conversation titles, summarising long conversations, saving memory notes and project summaries, and creating search embeddings of your memories, conversations, documents and knowledge-base items.',
        'Gemini, OpenRouter and Cloudflare have different data practices, and those practices are set by them, not by us:',
      ],
      bullets: [
        `Google Gemini. Atlas AI currently uses the Gemini API without a paid plan, so Google’s terms for unpaid services apply. Under those terms, Google uses the prompts and responses it receives to provide, improve and develop its products and machine-learning technologies, and human reviewers may read, annotate and process them. Google’s terms for paid services are different (Google says it does not use prompts or responses from paid services to improve its products), but they do not currently apply to Atlas AI. Google’s terms: ${GEMINI_TERMS}.`,
        'OpenRouter. OpenRouter forwards each request to a company that runs the chosen model (the model provider). OpenRouter’s privacy policy says it does not use inputs or outputs for model training, but model providers have their own policies, which differ from model to model. Several of the free models Atlas AI uses through OpenRouter, including the NVIDIA Nemotron chat models and the free embedding model, are available only from model providers that may store prompts and responses and use them to train or improve their models. OpenRouter: https://openrouter.ai/privacy and https://openrouter.ai/terms.',
        `Cloudflare Workers AI. Cloudflare runs the models on its own network. Cloudflare says that it does not use content processed by Workers AI to train AI models, that for requests like the ones Atlas AI makes it does not keep inputs or outputs once they are no longer needed to provide the service, and that it may keep operational information such as times, token counts and error codes. Cloudflare: ${CLOUDFLARE_DATA} and ${CLOUDFLARE_PRIVACY}.`,
        'Providers may keep copies of the information they receive under their own policies. Deleting something in Atlas AI does not delete copies held by a provider.',
        'Do not submit passwords, financial credentials such as card or bank details, highly sensitive personal information (for example about health), confidential business information or other people’s personal information.',
      ],
    },
    {
      heading: 'Other service providers',
      paragraphs: ['These providers receive only what they need for their part of the service. Their own terms and privacy policies apply.'],
      bullets: [
        'Google Firebase: sign-in (Firebase Authentication), the database that stores your account and all app data, including the images Atlas AI creates for you (Cloud Firestore) and, only if you allow it, Google Analytics.',
        'Vercel: hosts the app and runs the server functions that every request passes through, including their logs.',
        'SerpAPI and Tavily: receive web-search queries. Tavily also receives the addresses of web pages to read during research.',
        'Vynfy: receives your phone number and sends the verification and recovery texts.',
        'Websites you add to your knowledge base: our server requests the page from the address you provide.',
      ],
    },
    {
      heading: 'Where your information is stored',
      bullets: [
        'The Atlas AI database (Cloud Firestore) is in Google’s "nam5" multi-region location in the United States.',
        'Atlas AI’s server functions run on Vercel in the United States (Washington, D.C. region).',
        'Firebase Authentication and Google Analytics run on Google’s infrastructure. Vynfy sends text messages from Accra, Ghana. AI and search providers process information in the locations they choose, which may be outside Ghana.',
        'This means that information you provide in Ghana is transferred to, stored in and processed in the United States and other countries whose data protection laws may differ from Ghana’s. We rely on these providers’ own security and privacy commitments; we have not entered into separate data transfer agreements with them.',
      ],
    },
    {
      heading: 'Analytics, cookies and browser storage',
      paragraphs: [
        'Google Analytics for Firebase is off unless you allow it. The first time you open Atlas AI in a browser, a banner asks whether you allow analytics, and until you choose "Allow analytics" it is not loaded. If you allow it, it records how the app is used (for example pages viewed and visits), with device and browser details and an approximate location derived from your IP address, and stores its own identifiers (cookies) in your browser.',
        'Your choice is stored only in that browser. You can change it at any time in Settings → Security → Usage analytics, or with the switch at the end of this page. Turning analytics off stops further collection and removes its cookies from your browser. Declining does not change how the app works.',
        'Atlas AI also stores a few items in your browser so that it works: your sign-in session (managed by Firebase), your theme and accent colour, whether the sidebar is collapsed, a short-lived copy of your access status and of the model list for faster start-up, the time of your last activity (for automatic sign-out) and an offline copy of the app and of your recent data. Signing out removes the offline copy of your data and the stored access status.',
      ],
    },
    {
      heading: 'Why we use your information',
      paragraphs: ['We process your information only for the purposes in this policy, on the following grounds:'],
      bullets: [
        'To provide the service you ask for: your account, phone verification, your content, AI answers, web search and support. Without this information Atlas AI cannot work for you.',
        'Your consent: optional analytics. You can withdraw it at any time; this does not affect processing that already happened.',
        'Keeping Atlas AI secure and working: security records, abuse prevention and usage limits, error reports and the record of administrator actions.',
        'Where the law requires it, for example to respond to a lawful request from an authority.',
      ],
    },
    {
      heading: 'What we do not do',
      bullets: [
        'We do not sell your personal information.',
        'Atlas AI does not show advertising.',
        'The administrator screens in Atlas AI show account details, access status, usage counts and the number of conversations, documents and memories an account has, but not their content, and the database rules do not let administrators read that content through the app. As the operator of the database, the owner has technical access to stored data through Google Cloud’s administration tools and uses it only to operate, secure or support Atlas AI, to deal with a problem you report, or where the law requires.',
        'Atlas AI creates or edits an image only when you ask for one. Images you attach are otherwise sent to the AI model only so that it can read them.',
      ],
    },
    {
      heading: 'How long we keep information',
      paragraphs: ['Kept by Atlas AI:'],
      bullets: [
        'Your content (conversations, memories, documents, projects, knowledge base, saved responses): until you delete it or your account is deleted. You can delete individual items at any time.',
        'Images Atlas AI created for you, with their prompts: until you delete the image in Images, delete the conversation it was created in, or your account is deleted. Deleting an image does not delete the chat message that showed it, and deleting only that message does not delete the image.',
        'Profile, settings, usage counts, security records, acceptance history, saved web-search results, support reports, notifications and text-message records: for as long as your account exists, then deleted with it.',
        'Verification and recovery codes: a code stops working after 5 minutes or after too many attempts. Codes that Atlas AI creates are stored only as one-way hashes; codes created by Vynfy are checked by Vynfy and not stored by Atlas AI.',
        'Account deletion: you can ask for your account to be deleted (see "Your rights"). An administrator schedules the deletion; the account is disabled at once and can still be restored for 30 days. After 30 days a daily job permanently deletes it, together with everything listed above and your sign-in account.',
        'Kept after an account is permanently deleted: the record of administrator actions about the account (which includes its email address) and its access request, for accountability. They are deleted automatically 30 days after the account is permanently deleted, by the same daily job.',
        'Password-recovery limit records: only the last 24 hours of request times are kept.',
      ],
    },
    {
      heading: 'How long service providers keep information',
      bullets: [
        'Vercel server logs (including error reports): kept for 1 hour on the Vercel plan Atlas AI uses, then deleted by Vercel.',
        'Google Analytics (only if you allowed it): event-level data is kept for no longer than 14 months, the longest retention period Google Analytics offers for this data; aggregated reports are kept by Google under its own terms.',
        'AI, search and text-message providers keep the information they receive under their own policies (see "AI providers and how they use your data" for what Cloudflare says about Workers AI). Atlas AI cannot delete those copies.',
      ],
    },
    {
      heading: 'Your rights',
      paragraphs: [
        'Ghana’s Data Protection Act, 2012 (Act 843) gives you rights over your personal data, including the right to ask whether we hold data about you and to receive a copy, to ask for it to be corrected or deleted, to object to its processing, and to complain to the Data Protection Commission. If you use Atlas AI from another country, its laws may give you further rights. In Atlas AI you can:',
      ],
      bullets: [
        'See and update your name and phone number in Settings.',
        'Download a copy of your profile, conversations, memories, projects and activity in Settings → Security → Export your data.',
        'Turn memory and automatic web search on or off, and turn analytics on or off.',
        'Delete individual conversations, memories, documents and other items, and each image Atlas AI created for you (in Images).',
        'Download each image Atlas AI created for you, in its original quality, with its Download button.',
        `Ask for a copy of your data, a correction, deletion of your account, or anything else about your information by writing to ${CONTACT_EMAIL} or using Settings → Report an issue. We aim to reply within 24 hours. Some requests, such as a full copy of your data, may take longer, and we deal with every request without undue delay. We may need to confirm your identity first.`,
        'If you are not satisfied with our answer, you can complain to Ghana’s Data Protection Commission (https://dataprotection.org.gh).',
      ],
    },
    {
      heading: 'How your information is protected',
      bullets: [
        'Database security rules allow each account to read and change only its own records. Support reports can be read only by their author and administrators. Images Atlas AI created can be read and deleted only by your account, and only our server can add them.',
        'Sensitive operations (phone verification, password recovery, account changes, approvals and support reports) run on our server, which checks your identity on every request.',
        'Verification codes and recovery tokens are stored only as one-way hashes. The keys for the AI, search and text-message services are kept on the server and never sent to your browser.',
        'Information is sent over encrypted connections (HTTPS), and Google encrypts the stored database.',
        'On the website, you are signed out after 60 minutes without activity (this does not apply to the installed app). You can sign out of all devices in Settings → Security.',
        'No system is completely secure, and we cannot promise that information will never be accessed without authorisation.',
      ],
    },
    {
      heading: 'Changes to this policy',
      paragraphs: [
        'We may update this policy as Atlas AI changes. Each version has a number shown at the top of this page. When we publish a new version, Atlas AI asks you to read and accept it before you continue, and your earlier acceptances are kept.',
      ],
    },
    {
      heading: 'Contact',
      paragraphs: [`Questions about this policy or your information: ${CONTACT_EMAIL}, or Settings → Report an issue.`],
    },
  ],
};

export const TERMS: LegalDoc = {
  title: 'Terms of Use',
  intro:
    'These terms govern your use of Atlas AI. You must accept them, together with the Privacy Policy, before you use the app. If you do not agree, do not use Atlas AI.',
  sections: [
    {
      heading: 'Who provides Atlas AI',
      paragraphs: [
        'Atlas AI is independently owned and operated by Anaab Kingsley, an individual based in Ghana ("we", "us", "our"). We own the Atlas AI application, its name and branding and its software. Google (Gemini), OpenRouter, Cloudflare (Workers AI) and the other services named in these terms are independent third parties; they do not own Atlas AI.',
      ],
    },
    {
      heading: 'Eligibility and access',
      bullets: [
        'Atlas AI is a general-purpose AI assistant for personal and professional use, for example everyday questions, learning, writing, research and work tasks.',
        'You must be 18 or older to use Atlas AI.',
        'Access may require approval by an administrator, who decides whether to grant, keep or remove it. When automatic approval is turned on, new accounts are approved without a manual review.',
        'Email and password accounts must verify a mobile number by text message. Text messages can currently be sent only to Ghana (+233) numbers.',
      ],
    },
    {
      heading: 'Your account',
      bullets: [
        'Give accurate information when you register and when you request access.',
        'Keep your password, devices and verification codes secure. Never share a verification code; we will never ask you for one.',
        'You are responsible for activity on your account. If you think someone else has used it, tell us promptly through Settings → Report an issue and use "Sign out everywhere" in Settings → Security.',
        'One person per account. Do not share, sell or transfer your account.',
      ],
    },
    {
      heading: 'Acceptable use',
      paragraphs: ['Use Atlas AI lawfully and respectfully. You must not:'],
      bullets: [
        'Break any law, or infringe anyone’s intellectual property, privacy or other rights.',
        'Create or share content that is abusive, harassing or hateful, that sexually exploits children, or that promotes violence or self-harm.',
        'Use Atlas AI to create malware, phishing, spam, fraud or deceptive content, or to impersonate others.',
        'Ask Atlas AI to create or edit images that sexualise children; sexual or intimate images of a real person; deepfakes, face swaps or fake photos of a real person; forged or counterfeit documents, money or records; or images that impersonate a person, company or organisation. Atlas AI checks image requests automatically and refuses those that appear to break these rules. The check is not perfect, and you remain responsible for what you ask for.',
        'Upload personal information about other people without a lawful reason.',
        'Try to gain unauthorised access to accounts, data or systems, test or bypass security, or interfere with the service.',
        'Scrape, overload or automate the service, get around usage or cost limits, or resell access.',
        'Use outputs to make decisions with legal or similarly significant effects on people without appropriate human review.',
        'Break the usage policies of the AI providers that Atlas AI relies on.',
      ],
    },
    {
      heading: 'AI responses: limitations and your responsibility',
      bullets: [
        'AI responses are generated automatically and can be inaccurate, incomplete, out of date or biased, even when they sound confident.',
        'Responses are not professional advice. Do not rely on them for medical, legal, financial, safety or other important decisions without checking with a qualified person.',
        'Web search results and sources come from third-party websites that we do not control.',
        'You are responsible for how you use responses, including checking facts and making sure your use is lawful.',
        'Atlas AI can create an image, or edit one, when you ask. Created images can contain mistakes, such as distorted details or misspelled text, and may look similar to existing works, places or people. Check an image before you use or publish it.',
      ],
    },
    {
      heading: 'Third-party AI services',
      bullets: [
        'Atlas AI uses third-party AI services to provide its AI features: Google Gemini, the primary provider, and OpenRouter, an additional provider, together with the model providers that OpenRouter forwards requests to. Cloudflare Workers AI creates and edits images, and answers chat messages only when you choose one of its models.',
        'When you use AI features, the information you submit, including prompts, messages, attached images, uploaded documents and relevant conversation context, may be sent to these providers to generate a response.',
        'These providers process that information under their own terms and privacy policies, which differ from provider to provider. Some may keep it or use it to improve or train their models. The Privacy Policy explains what is known about each.',
        'We do not own or operate the underlying AI models. Their availability, behaviour and data practices are set by their providers and may change.',
        'Do not submit passwords, financial credentials, highly sensitive personal information or confidential information to Atlas AI.',
        `Provider terms: Google Gemini API (${GEMINI_TERMS}), OpenRouter (https://openrouter.ai/terms and https://openrouter.ai/privacy) and Cloudflare (${CLOUDFLARE_DATA} and ${CLOUDFLARE_PRIVACY}).`,
      ],
    },
    {
      heading: 'Your content',
      bullets: [
        'You keep any rights you have in the messages, documents and images you provide ("your content").',
        'You allow us to store and process your content, and to send it to our service providers, only as needed to run Atlas AI for you, as described in the Privacy Policy.',
        'You confirm that you have the right to provide your content and that it does not break these terms.',
        'You can delete your content at any time, and it is deleted with your account, as described in the Privacy Policy. Copies held by AI and other providers are kept under their own policies.',
      ],
    },
    {
      heading: 'Ownership of AI-generated outputs',
      bullets: [
        'We do not claim ownership of the responses and images Atlas AI generates for you ("outputs"). To the extent we have any rights in your outputs, we transfer them to you.',
        'You may use outputs for any lawful purpose, subject to these terms and to the terms of the AI provider that produced them.',
        'Outputs may not be unique: other people may receive similar responses. Whether an output is protected by copyright, or is free of other people’s rights, depends on the law and on the output, and we cannot confirm either. Check before you rely on or publish an output.',
      ],
    },
    {
      heading: 'Fees',
      paragraphs: [
        'Atlas AI is currently free to use. If we introduce fees or paid plans in future, we will tell you in advance, and you will not be charged unless you agree to it. Usage limits apply to free use and may change.',
      ],
    },
    {
      heading: 'Usage limits and abuse prevention',
      paragraphs: [
        'To control cost and prevent abuse, we limit web searches, research, image creation, file uploads, text messages, password-recovery requests and support reports, and AI providers apply their own limits to AI requests. Image creation uses a free daily allowance from Cloudflare; when it is used up, Atlas AI stops creating images until it resets at 00:00 UTC and does not switch to paid usage. We may change these limits, and we may block or slow requests that look automated or abusive.',
      ],
    },
    {
      heading: 'Suspension and ending your use',
      bullets: [
        'We may suspend or remove your access, or delete your account, if you break these terms, if your use creates risk or cost for others, if the law requires it, or if we stop offering Atlas AI. Where reasonable, we will tell you why.',
        `You may stop using Atlas AI at any time. To have your account deleted, write to ${CONTACT_EMAIL} or use Settings → Report an issue. An administrator schedules the deletion: your account is disabled at once, can still be restored for 30 days, and is then permanently deleted, as described in the Privacy Policy.`,
      ],
    },
    {
      heading: 'Availability and changes to the service',
      paragraphs: [
        'Features, models and providers may change, be limited or become unavailable, and the service may be interrupted for maintenance or because a provider is unavailable. We may change or replace the AI providers we use.',
      ],
    },
    {
      heading: 'Third-party services',
      paragraphs: [
        'Atlas AI relies on third-party services: Google (Firebase Authentication, Cloud Firestore, Google Analytics if you allow it, and Gemini), OpenRouter and the model providers it forwards requests to, Cloudflare (Workers AI), SerpAPI and Tavily (web search), Vynfy (text messages) and Vercel (hosting). Their availability and terms are outside our control, and we are not responsible for their acts or omissions, except where the law makes us responsible.',
      ],
    },
    {
      heading: 'No warranties',
      paragraphs: [
        'Atlas AI is provided free of charge, "as is" and "as available". To the extent permitted by law, we make no promises about it beyond those in these terms, including that it will be accurate, uninterrupted, error-free, secure or suitable for a particular purpose. This does not affect any rights you have under law that cannot be excluded.',
      ],
    },
    {
      heading: 'Limitation of liability',
      bullets: [
        'To the extent permitted by law, we are not liable for any indirect or consequential loss, or for loss of data, profits, revenue or goodwill, arising from your use of, or inability to use, Atlas AI or any output.',
        'To the extent permitted by law, we are not liable for loss caused by events outside our reasonable control, including failures of third-party services.',
        'Nothing in these terms excludes or limits liability that cannot be excluded or limited under the law that applies, including liability for fraud or for death or personal injury caused by negligence.',
      ],
    },
    {
      heading: 'Indemnity',
      paragraphs: [
        'To the extent permitted by law, you agree to compensate us for reasonable losses, costs and claims brought by third parties that arise from your breach of these terms, your content, or your unlawful use of Atlas AI or its outputs.',
      ],
    },
    {
      heading: 'Governing law and disputes',
      bullets: [
        'These terms are governed by the laws of the Republic of Ghana.',
        `If you have a complaint, please contact us first at ${CONTACT_EMAIL} or through Settings → Report an issue. We aim to reply within 24 hours and will try to resolve the matter informally.`,
        'If a dispute cannot be resolved informally, it will be decided by the courts of Ghana, unless the law where you live gives you the right to bring it elsewhere.',
      ],
    },
    {
      heading: 'Changes to these terms',
      paragraphs: [
        'We may update these terms. Each version has a number shown at the top of this page. When we publish a new version, Atlas AI asks you to read and accept it before you continue, and your earlier acceptances are kept. If you do not accept, you can stop using Atlas AI and ask for your account to be deleted.',
      ],
    },
    {
      heading: 'Contact',
      paragraphs: [`Questions about these terms: ${CONTACT_EMAIL}, or Settings → Report an issue.`],
    },
  ],
};
