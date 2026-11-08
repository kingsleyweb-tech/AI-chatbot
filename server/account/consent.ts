/**
 * Terms of Use and Privacy Policy acceptance.
 *
 * - users/{uid}.consent           the latest acceptance, read by decideAccess
 *                                 and firestore.rules (consentOk); server-only
 * - users/{uid}/consents/{id}     every acceptance ever made (history, never
 *                                 overwritten); owner-readable, server-only writes
 *
 * The time comes from the server clock and the method from the verified
 * token, never from the browser. Only the current versions can be accepted.
 */
import type { AuthUser } from '../auth.js';
import type { Firestore } from '../firestore.js';
import { HttpError } from '../http.js';
import { consentCurrent, consentMethod, PRIVACY_VERSION, TERMS_VERSION, type ConsentRecord } from '../shared/legal.js';
import { eventId, recordSecurityEvent } from './events.js';

export async function acceptTerms(
  db: Firestore,
  user: AuthUser,
  versions: { termsVersion: string; privacyVersion: string },
  existing: Partial<ConsentRecord> | null | undefined,
  device: string,
  now = Date.now(),
): Promise<{ consent: ConsentRecord; recorded: boolean }> {
  if (versions.termsVersion !== TERMS_VERSION || versions.privacyVersion !== PRIVACY_VERSION) {
    throw new HttpError(409, 'terms_outdated', 'The Terms of Use or Privacy Policy changed. Please review the current versions.');
  }
  // Accepting the same versions twice (double tap, second tab) changes nothing.
  if (consentCurrent(existing)) return { consent: existing as ConsentRecord, recorded: false };
  const consent: ConsentRecord = { termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION, acceptedAt: now, method: consentMethod(user.provider) };
  await db.commit([
    { op: 'set', path: `users/${user.uid}`, data: { consent }, merge: true },
    {
      op: 'set',
      path: `users/${user.uid}/consents/${eventId(now)}`,
      data: { userId: user.uid, termsAccepted: true, privacyAccepted: true, ...consent, acceptedAtServer: new Date(now) },
      precondition: { exists: false },
    },
  ]);
  await recordSecurityEvent(db, user.uid, 'terms_accepted', { provider: user.provider, device, detail: `Terms ${TERMS_VERSION}, Privacy ${PRIVACY_VERSION}` }, now);
  return { consent, recorded: true };
}
