/**
 * Current versions of the Terms of Use and Privacy Policy.
 *
 * Every account must have accepted these exact versions before it can use
 * Atlas AI (checked by the server in decideAccess and by firestore.rules
 * consentOk()). After a material change to either document, raise its
 * version here AND in firestore.rules: everyone is then asked to accept
 * again, and earlier acceptances stay in users/{uid}/consents.
 */
export const TERMS_VERSION = '1.0';
export const PRIVACY_VERSION = '1.0';

export type ConsentMethod = 'google' | 'email_password' | 'other';

export interface ConsentRecord {
  termsVersion: string;
  privacyVersion: string;
  /** ms since epoch, from the server clock */
  acceptedAt: number;
  method: ConsentMethod;
}

export function consentCurrent(c: Partial<ConsentRecord> | null | undefined): boolean {
  return Boolean(c && c.termsVersion === TERMS_VERSION && c.privacyVersion === PRIVACY_VERSION);
}

export function consentMethod(provider: string | null | undefined): ConsentMethod {
  if (provider === 'google.com') return 'google';
  if (provider === 'password') return 'email_password';
  return 'other';
}

export const CONSENT_METHOD_LABEL: Record<ConsentMethod, string> = {
  google: 'Google',
  email_password: 'Email and password',
  other: 'Other',
};
