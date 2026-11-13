/**
 * Ready-made messages for Admin › Messages.
 *
 * - "support" templates answer one person's problem (Contact a user).
 * - "announcement" templates go to a group (Announcements).
 *
 * {name} becomes the person's first name. Parts in [square brackets] must be filled in by the
 * administrator; the page refuses to send while any are left. Texts are kept to one SMS
 * (160 characters including the "Atlas AI: " prefix the server adds); tests check this.
 * Every place in the app named here exists: Settings › Security, Settings › Usage, and the menu
 * under the person's name (Help Centre, Report an issue).
 */

export type TemplateKind = 'support' | 'announcement';

export interface ReadyTemplate {
  id: string;
  kind: TemplateKind;
  category: string;
  name: string;
  /** when to use it (shown on the card) */
  hint: string;
  sms: string;
  subject: string;
  body: string;
}

export interface TemplateCategory {
  id: string;
  kind: TemplateKind;
  label: string;
}

export const TEMPLATE_CATEGORIES: TemplateCategory[] = [
  { id: 'signin', kind: 'support', label: 'Sign-in & password' },
  { id: 'codes', kind: 'support', label: 'Verification codes' },
  { id: 'access', kind: 'support', label: 'Account access' },
  { id: 'usage', kind: 'support', label: 'Usage & limits' },
  { id: 'reports', kind: 'support', label: 'Reports & issues' },
  { id: 'security', kind: 'support', label: 'Security' },
  { id: 'account', kind: 'support', label: 'Account & data' },
  { id: 'welcome', kind: 'announcement', label: 'Welcome & onboarding' },
  { id: 'service', kind: 'announcement', label: 'Service updates' },
  { id: 'product', kind: 'announcement', label: 'Product news' },
  { id: 'safety', kind: 'announcement', label: 'Safety & policies' },
];

const SIGN_OFF = '\n\nThe Atlas AI team';
const HELP = 'If you need anything else, reply through the app: open the menu under your name and choose Report an issue.';

export const READY_TEMPLATES: ReadyTemplate[] = [
  /* ---------------------------------------------------------------- sign-in & password */
  {
    id: 'rt-reset-password',
    kind: 'support',
    category: 'signin',
    name: 'Forgot password',
    hint: 'They cannot remember their password.',
    sms: 'Hi {name}, to reset your password open chatatlasai.vercel.app, tap Sign in, then Forgot password? and follow the steps.',
    subject: 'How to reset your Atlas AI password',
    body: `Hi {name},\n\nWe are sorry you are having trouble signing in. You can set a new password in a minute:\n\n1. Open chatatlasai.vercel.app and tap Sign in.\n2. Tap Forgot password? under the password field.\n3. Enter your email address or phone number and follow the steps in the message we send you.\n\nAfter that, sign in with your new password.\n\n${HELP}${SIGN_OFF}`,
  },
  {
    id: 'rt-signin-phone',
    kind: 'support',
    category: 'signin',
    name: 'Sign in with phone number',
    hint: 'They no longer have access to their email.',
    sms: 'Hi {name}, you can also sign in with your verified phone number instead of your email. Use the same password.',
    subject: 'You can sign in with your phone number',
    body: `Hi {name},\n\nIf you cannot use your email address, you can sign in with your verified phone number instead. On the sign-in page, enter your phone number in the "Email or phone number" field and use your usual password.\n\nOnce you are in, you can update your email address in Settings › Security.\n\n${HELP}${SIGN_OFF}`,
  },
  {
    id: 'rt-signin-fixed',
    kind: 'support',
    category: 'signin',
    name: 'Sign-in problem fixed',
    hint: 'A sign-in problem on our side has been solved.',
    sms: 'Hi {name}, the sign-in problem you reported has been fixed. Please try signing in again at chatatlasai.vercel.app.',
    subject: 'You can sign in to Atlas AI again',
    body: `Hi {name},\n\nThank you for your patience. The problem that stopped you from signing in has been fixed, and you can sign in again at chatatlasai.vercel.app.\n\nIf it still does not work, please tell us exactly what you see on the screen and we will look into it straight away.\n\n${HELP}${SIGN_OFF}`,
  },

  /* ---------------------------------------------------------------- verification codes */
  {
    id: 'rt-sms-code',
    kind: 'support',
    category: 'codes',
    name: 'SMS code not received',
    hint: 'Their phone verification text did not arrive.',
    sms: 'Hi {name}, texts can take a few minutes. Check the number is right, wait 1 minute, then tap Resend code on the verification screen.',
    subject: 'Did not receive your verification code?',
    body: `Hi {name},\n\nSorry your verification code did not arrive. Here is what usually helps:\n\n1. Check that the phone number on the verification screen is correct, including the network code (for example 024, 054 or 053).\n2. Make sure the phone has signal and is not blocking messages from unknown senders.\n3. Wait about a minute, then tap Resend code.\n\nYou can request up to 3 codes per hour. If none arrive, tell us and we will check the delivery on our side.\n\n${HELP}${SIGN_OFF}`,
  },
  {
    id: 'rt-email-code',
    kind: 'support',
    category: 'codes',
    name: 'Email code not received',
    hint: 'Their email verification code did not arrive.',
    sms: 'Hi {name}, your Atlas AI email code may be in Spam or Promotions. Please check there, then request a new code if needed.',
    subject: 'Finding your Atlas AI email code',
    body: `Hi {name},\n\nSorry your email code did not arrive. Please check:\n\n1. Your Spam, Junk or Promotions folders.\n2. That the email address in Settings › Security is spelled correctly.\n3. After a minute, request a new code from the same screen.\n\nMarking our message as "Not spam" helps future emails reach your inbox.\n\n${HELP}${SIGN_OFF}`,
  },
  {
    id: 'rt-phone-in-use',
    kind: 'support',
    category: 'codes',
    name: 'Phone number already in use',
    hint: 'Their number is linked to another account.',
    sms: 'Hi {name}, that phone number is linked to another Atlas AI account. Sign in to that account, or use a different number.',
    subject: 'Your phone number is linked to another account',
    body: `Hi {name},\n\nEach phone number can be linked to only one Atlas AI account, and the number you entered is already linked to another one.\n\nIf that other account is yours, sign in to it with the phone number and its password. If you think someone else has linked your number, reply through the app and we will look into it.\n\n${HELP}${SIGN_OFF}`,
  },

  /* ---------------------------------------------------------------- account access */
  {
    id: 'rt-approved',
    kind: 'support',
    category: 'access',
    name: 'Account approved',
    hint: 'Their access request has been accepted.',
    sms: 'Hi {name}, your Atlas AI account is approved. Sign in now at chatatlasai.vercel.app with your email or phone number.',
    subject: 'Your Atlas AI account is approved',
    body: `Hi {name},\n\nGood news: your Atlas AI account has been approved.\n\nYou can sign in now at chatatlasai.vercel.app with your email address or phone number and your password, and start using Atlas AI right away.\n\nWelcome aboard!${SIGN_OFF}`,
  },
  {
    id: 'rt-reviewing',
    kind: 'support',
    category: 'access',
    name: 'Request under review',
    hint: 'They asked why they cannot sign in yet.',
    sms: 'Hi {name}, thank you for signing up. Your Atlas AI account is being reviewed. We will text you as soon as it is approved.',
    subject: 'Your Atlas AI request is being reviewed',
    body: `Hi {name},\n\nThank you for signing up for Atlas AI. Your account is still being reviewed.\n\nAs soon as it is approved, you will receive a text message and an email, and you can start using Atlas AI right away. There is nothing else you need to do.${SIGN_OFF}`,
  },
  {
    id: 'rt-declined',
    kind: 'support',
    category: 'access',
    name: 'Request declined',
    hint: 'Their access request was not accepted.',
    sms: 'Hi {name}, we are unable to approve your Atlas AI request at this time. Thank you for your interest.',
    subject: 'About your Atlas AI request',
    body: `Hi {name},\n\nThank you for your interest in Atlas AI. After review, we are unable to approve your request at this time.\n\n[Optional: add the reason, or remove this line.]\n\nIf you think this is a mistake, you can reply through our contact page at chatatlasai.vercel.app/contact.${SIGN_OFF}`,
  },
  {
    id: 'rt-suspended',
    kind: 'support',
    category: 'access',
    name: 'Account suspended',
    hint: 'Explain a suspension and how to appeal.',
    sms: 'Hi {name}, your Atlas AI account has been suspended. We have emailed you the details and how to contact us.',
    subject: 'Your Atlas AI account has been suspended',
    body: `Hi {name},\n\nYour Atlas AI account has been suspended, so you cannot sign in for now.\n\nReason: [write the reason here]\n\nYour chats and settings have not been deleted. If you believe this is a mistake or would like to discuss it, contact us through chatatlasai.vercel.app/contact.${SIGN_OFF}`,
  },
  {
    id: 'rt-reactivated',
    kind: 'support',
    category: 'access',
    name: 'Account reactivated',
    hint: 'A suspension has been lifted.',
    sms: 'Hi {name}, your Atlas AI account is active again. You can sign in now at chatatlasai.vercel.app.',
    subject: 'Your Atlas AI account is active again',
    body: `Hi {name},\n\nYour Atlas AI account has been reactivated. You can sign in again at chatatlasai.vercel.app, and your chats and settings are just as you left them.\n\nThank you for your patience.${SIGN_OFF}`,
  },

  /* ---------------------------------------------------------------- usage & limits */
  {
    id: 'rt-limit-reached',
    kind: 'support',
    category: 'usage',
    name: 'Daily limit reached',
    hint: 'They hit their usage allowance.',
    sms: 'Hi {name}, you reached your Atlas AI limit for now. It resets automatically; see Settings > Usage for the time.',
    subject: 'About your Atlas AI usage limit',
    body: `Hi {name},\n\nYou have reached your current Atlas AI allowance, which is why some features are paused for now. Allowances keep the service free and fair for everyone.\n\nYour limit resets automatically. Open Settings › Usage to see exactly how much you have used and when it resets.\n\n${HELP}${SIGN_OFF}`,
  },
  {
    id: 'rt-limit-raised',
    kind: 'support',
    category: 'usage',
    name: 'Limit increased',
    hint: 'You gave them a higher allowance.',
    sms: 'Hi {name}, we have increased your Atlas AI usage limit. You can continue now; see Settings > Usage for details.',
    subject: 'Your Atlas AI limit has been increased',
    body: `Hi {name},\n\nGood news: we have increased your Atlas AI usage allowance, so you can carry on with your work.\n\nYou can see your new allowance any time in Settings › Usage.\n\nEnjoy!${SIGN_OFF}`,
  },

  /* ---------------------------------------------------------------- reports & issues */
  {
    id: 'rt-report-received',
    kind: 'support',
    category: 'reports',
    name: 'Report received',
    hint: 'Acknowledge a report they sent.',
    sms: 'Hi {name}, thank you for your report. We are looking into it and will update you as soon as we know more.',
    subject: 'We received your report',
    body: `Hi {name},\n\nThank you for letting us know about this. We have received your report and are looking into it now.\n\nWe will update you as soon as we know more. You can follow its progress in the app: open the menu under your name and choose Report an issue to see your reports.${SIGN_OFF}`,
  },
  {
    id: 'rt-need-info',
    kind: 'support',
    category: 'reports',
    name: 'Need more details',
    hint: 'You cannot act on a report without more information.',
    sms: 'Hi {name}, to fix your issue we need a few more details. Please check your email from Atlas AI. Thank you!',
    subject: 'A few more details about your issue',
    body: `Hi {name},\n\nThank you for your report. To fix it, we need a little more information:\n\n- What were you trying to do when it happened?\n- What did you see on the screen (an error message or a screenshot helps a lot)?\n- Which device and browser were you using?\n\nPlease add these details to your report in the app (menu under your name › Report an issue).${SIGN_OFF}`,
  },
  {
    id: 'rt-issue-fixed',
    kind: 'support',
    category: 'reports',
    name: 'Issue fixed',
    hint: 'The problem they reported is solved.',
    sms: 'Hi {name}, the issue you reported has been fixed. Thank you for helping us improve Atlas AI!',
    subject: 'The issue you reported has been fixed',
    body: `Hi {name},\n\nGood news: the issue you reported has been fixed. Thank you for taking the time to tell us about it; reports like yours make Atlas AI better for everyone.\n\nIf you notice anything else, we would love to hear about it.\n\n${HELP}${SIGN_OFF}`,
  },
  {
    id: 'rt-working-on-it',
    kind: 'support',
    category: 'reports',
    name: 'Still working on it',
    hint: 'A fix will take longer.',
    sms: 'Hi {name}, we are still working on the issue you reported. Thank you for your patience; we will update you soon.',
    subject: 'An update on your report',
    body: `Hi {name},\n\nWe wanted to let you know that we are still working on the issue you reported. It is taking a little longer than we hoped, but it has not been forgotten.\n\nWe will let you know as soon as it is fixed. Thank you for your patience.${SIGN_OFF}`,
  },

  /* ---------------------------------------------------------------- security */
  {
    id: 'rt-suspicious',
    kind: 'support',
    category: 'security',
    name: 'Suspicious sign-in',
    hint: 'Someone else may have used their account.',
    sms: 'Hi {name}, we noticed unusual activity on your Atlas AI account. Please change your password and sign out of all devices.',
    subject: 'Please secure your Atlas AI account',
    body: `Hi {name},\n\nWe noticed sign-in activity on your Atlas AI account that may not have been you. To be safe, please:\n\n1. Change your password (Sign in › Forgot password? if you cannot sign in).\n2. Open Settings › Security and choose Sign out of all devices.\n3. Check that your email address and phone number there are still yours.\n\nAtlas AI will never ask you for your password or verification codes.${SIGN_OFF}`,
  },
  {
    id: 'rt-scam-warning',
    kind: 'support',
    category: 'security',
    name: 'Code-sharing warning',
    hint: 'They were asked to share a code or password.',
    sms: 'Hi {name}, never share your Atlas AI password or codes with anyone, even someone claiming to be from us.',
    subject: 'Never share your codes or password',
    body: `Hi {name},\n\nAtlas AI will never ask for your password or the verification codes we send you, by phone, text or email.\n\nIf someone asks for them, even if they say they are from Atlas AI, do not share them. If you already did, change your password straight away and choose Sign out of all devices in Settings › Security.${SIGN_OFF}`,
  },

  /* ---------------------------------------------------------------- account & data */
  {
    id: 'rt-deletion-scheduled',
    kind: 'support',
    category: 'account',
    name: 'Deletion scheduled',
    hint: 'Their account will be deleted in 30 days.',
    sms: 'Hi {name}, your Atlas AI account is scheduled for deletion in 30 days. Reply via our contact page to keep it.',
    subject: 'Your Atlas AI account is scheduled for deletion',
    body: `Hi {name},\n\nAs requested, your Atlas AI account has been closed and is scheduled for permanent deletion in 30 days.\n\nUntil then, nothing is lost: if you change your mind, contact us through chatatlasai.vercel.app/contact and we will restore it with all your chats and settings. After 30 days, your data is deleted permanently and cannot be recovered.${SIGN_OFF}`,
  },
  {
    id: 'rt-restored',
    kind: 'support',
    category: 'account',
    name: 'Account restored',
    hint: 'A scheduled deletion was cancelled.',
    sms: 'Hi {name}, your Atlas AI account has been restored. You can sign in again at chatatlasai.vercel.app.',
    subject: 'Your Atlas AI account has been restored',
    body: `Hi {name},\n\nYour Atlas AI account has been restored and will not be deleted. Your chats, memories and settings are all still there.\n\nYou can sign in again at chatatlasai.vercel.app.${SIGN_OFF}`,
  },
  {
    id: 'rt-export',
    kind: 'support',
    category: 'account',
    name: 'Download your data',
    hint: 'They asked for a copy of their data.',
    sms: 'Hi {name}, you can download all your Atlas AI data any time in Settings > Security > Export your data.',
    subject: 'How to download your Atlas AI data',
    body: `Hi {name},\n\nYou can download a copy of your data at any time: open Settings › Security and choose Export your data. You can download it as an easy-to-read PDF or a complete JSON file, and it includes your profile, conversations, memories and projects.\n\n${HELP}${SIGN_OFF}`,
  },

  /* ================================================================ announcements */
  {
    id: 'rt-welcome',
    kind: 'announcement',
    category: 'welcome',
    name: 'Welcome',
    hint: 'New members.',
    sms: 'Hi {name}, welcome to Atlas AI! Sign in any time at chatatlasai.vercel.app and ask anything.',
    subject: 'Welcome to Atlas AI, {name}',
    body: `Hi {name},\n\nWelcome to Atlas AI. You can ask questions, get help with writing and studies, search the web for current news, create images and talk to Atlas with your voice.\n\nNew here? The Help Centre (menu under your name) has short guides for everything.${SIGN_OFF}`,
  },
  {
    id: 'rt-verify-email',
    kind: 'announcement',
    category: 'welcome',
    name: 'Verify your email',
    hint: 'People who have not verified their email.',
    sms: 'Hi {name}, please verify your email in Atlas AI (Settings > Security) so you can recover your account.',
    subject: 'Please verify your email address',
    body: `Hi {name},\n\nYour email address is not verified yet. Verifying it lets you recover your account if you forget your password, and makes sure security alerts reach you.\n\nSign in to Atlas AI and open Settings › Security to get a code.${SIGN_OFF}`,
  },
  {
    id: 'rt-maintenance',
    kind: 'announcement',
    category: 'service',
    name: 'Scheduled maintenance',
    hint: 'Planned downtime.',
    sms: 'Hi {name}, Atlas AI will be briefly unavailable on [day] from [start] to [end] for maintenance. Thank you!',
    subject: 'Scheduled maintenance on [day]',
    body: `Hi {name},\n\nAtlas AI will be briefly unavailable on [day] from [start time] to [end time] while we carry out maintenance and improvements.\n\nYour chats and settings are safe, and everything will be back to normal afterwards. Thank you for your patience.${SIGN_OFF}`,
  },
  {
    id: 'rt-disruption',
    kind: 'announcement',
    category: 'service',
    name: 'Service disruption',
    hint: 'Something is not working right now.',
    sms: 'Hi {name}, some Atlas AI features are not working properly right now. We are fixing it and will update you soon.',
    subject: 'Some Atlas AI features are not working right now',
    body: `Hi {name},\n\nSome parts of Atlas AI are not working as they should at the moment: [describe what is affected].\n\nWe are already working on a fix and will let you know as soon as everything is back to normal. Your chats and data are safe. Sorry for the inconvenience.${SIGN_OFF}`,
  },
  {
    id: 'rt-service-restored',
    kind: 'announcement',
    category: 'service',
    name: 'Service restored',
    hint: 'After a disruption.',
    sms: 'Hi {name}, Atlas AI is working normally again. Sorry for the interruption and thank you for your patience.',
    subject: 'Atlas AI is working normally again',
    body: `Hi {name},\n\nThe problem that affected Atlas AI earlier has been fixed, and everything is working normally again.\n\nWe are sorry for the interruption. If anything still does not work as expected, please tell us: open the menu under your name and choose Report an issue.${SIGN_OFF}`,
  },
  {
    id: 'rt-new-feature',
    kind: 'announcement',
    category: 'product',
    name: 'New feature',
    hint: 'Announce something new.',
    sms: 'Hi {name}, new on Atlas AI: [feature]. Sign in at chatatlasai.vercel.app to try it.',
    subject: 'New on Atlas AI: [feature]',
    body: `Hi {name},\n\nWe have just added something new to Atlas AI: [feature].\n\n[One or two sentences on what it does and how to use it.]\n\nSign in to try it out, and let us know what you think (menu under your name › Report an issue).${SIGN_OFF}`,
  },
  {
    id: 'rt-feedback',
    kind: 'announcement',
    category: 'product',
    name: 'Ask for feedback',
    hint: 'Hear what people think.',
    sms: 'Hi {name}, how is Atlas AI working for you? Tell us in the app: menu under your name > Report an issue.',
    subject: 'How is Atlas AI working for you?',
    body: `Hi {name},\n\nWe would love to hear how Atlas AI is working for you: what you like, what is missing, and what we could do better.\n\nYou can send your thoughts any time in the app: open the menu under your name and choose Report an issue. Every message is read.\n\nThank you,\nThe Atlas AI team`,
  },
  {
    id: 'rt-security-reminder',
    kind: 'announcement',
    category: 'safety',
    name: 'Security reminder',
    hint: 'General safety advice.',
    sms: 'Atlas AI will never ask for your password or verification codes. Do not share them with anyone.',
    subject: 'Keep your Atlas AI account safe',
    body: `Hi {name},\n\nA quick reminder: Atlas AI will never ask for your password or your verification codes by phone, text or email.\n\nIf someone asks for them, even if they claim to be from Atlas AI, do not share them. You can review your signed-in devices any time in Settings › Security.${SIGN_OFF}`,
  },
  {
    id: 'rt-policy-update',
    kind: 'announcement',
    category: 'safety',
    name: 'Terms or Privacy update',
    hint: 'After publishing new Terms or Privacy Policy.',
    sms: 'Hi {name}, we have updated our Terms and Privacy Policy. You will be asked to review them next time you sign in.',
    subject: 'We have updated our Terms and Privacy Policy',
    body: `Hi {name},\n\nWe have updated the Atlas AI Terms of Service and Privacy Policy. [Summarise the main change in one sentence.]\n\nYou will be asked to review and accept them the next time you sign in. You can read them any time at chatatlasai.vercel.app/terms and chatatlasai.vercel.app/privacy.${SIGN_OFF}`,
  },
];

/** Parts the administrator still has to fill in, e.g. "[reason]". */
export const unfilled = (...texts: string[]) => texts.flatMap((t) => t.match(/\[[^\]\n]{1,60}\]/g) ?? []);
