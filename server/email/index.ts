import { env } from '../env.js';
import type { Firestore } from '../firestore.js';
import { getEmailProvider } from './provider.js';
import type { EmailDeps } from './service.js';

export { sendEmail, type EmailDeps, type SendRequest, type SendOutcome } from './service.js';

/** Email dependencies from the server configuration (provider is null when email is not set up). */
export function emailDeps(db: Firestore): EmailDeps {
  const e = env();
  return { db, provider: getEmailProvider(), baseUrl: e.publicUrl, dailyCap: e.emailDailyCap };
}
