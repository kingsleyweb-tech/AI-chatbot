/**
 * Phone number handling, built on libphonenumber (Google's numbering-plan
 * metadata) via libphonenumber-js.
 *
 * - Stored form: E.164, e.g. +233501901401 (one consistent format everywhere).
 * - Display form: +233 50 190 1401.
 * - Vynfy form: 233501901401 (Vynfy accepts 233XXXXXXXXX, +233XXXXXXXXX or
 *   0XXXXXXXXX; we always send the first).
 *
 * The trunk 0 of a domestic number is dropped when the country code is added,
 * so "024 123 4567", "+233 24 123 4567" and "+233 024 123 4567" all become
 * +233241234567, never +2330241234567. Vynfy itself accepts "+2330…" without
 * complaint, so this must happen here.
 *
 * Verification texts go through a Ghana gateway (Vynfy's OTP service accepts
 * Ghanaian numbers only), so normalizePhone accepts Ghana mobile numbers only.
 * normalizeInternational accepts any country (access-request contact numbers).
 */
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';

export type PhoneResult = { ok: true; e164: string } | { ok: false; reason: 'format' | 'country' };

const ALLOWED = /^\+?[\d\s().\-/]+$/;

/** Strip punctuation; "00" international prefix -> "+"; bare 233XXXXXXXXX -> +233XXXXXXXXX. */
function clean(input: string): string | null {
  const raw = input.trim();
  if (!raw || !ALLOWED.test(raw)) return null;
  let s = raw.replace(/[\s().\-/]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (!s.startsWith('+') && /^233\d{9}$/.test(s)) s = '+' + s;
  return s;
}

function parse(input: string, country: CountryCode) {
  const s = clean(input);
  if (!s) return null;
  return parsePhoneNumberFromString(s, country) ?? null;
}

/** A Ghana mobile number that can receive verification texts, as E.164. */
export function normalizePhone(input: string): PhoneResult {
  const n = parse(input, 'GH');
  if (!n) return { ok: false, reason: 'format' };
  if (n.countryCallingCode !== '233') return n.isPossible() ? { ok: false, reason: 'country' } : { ok: false, reason: 'format' };
  const type = n.getType();
  if (!n.isValid() || (type !== 'MOBILE' && type !== 'FIXED_LINE_OR_MOBILE')) return { ok: false, reason: 'format' };
  return { ok: true, e164: n.number };
}

/**
 * Any international number as E.164 (for access requests). Ghana numbers get
 * the stricter mobile check above. `dialCode` (e.g. "+233") applies to
 * numbers written without one; its trunk 0 is dropped.
 */
export function normalizeInternational(input: string, dialCode = '+233'): PhoneResult {
  let s = clean(input);
  if (!s) return { ok: false, reason: 'format' };
  if (!s.startsWith('+')) {
    if (!/^\+[1-9]\d{0,3}$/.test(dialCode)) return { ok: false, reason: 'format' };
    s = dialCode + s.replace(/^0+/, '');
  }
  if (s.startsWith('+233')) return normalizePhone(s);
  const n = parsePhoneNumberFromString(s);
  // Contact numbers only (no text is sent to them): a possible number is enough.
  return n && n.isPossible() ? { ok: true, e164: n.number } : { ok: false, reason: 'format' };
}

/** +233501901401 -> 233501901401 (Vynfy's documented format). */
export function toVynfy(e164: string): string {
  return e164.replace(/^\+/, '');
}

/** +233501901401 -> +233 50 190 1401 */
export function formatPhone(e164: string): string {
  return parsePhoneNumberFromString(e164)?.formatInternational() ?? e164;
}

/** +233241234567 -> +233 •• ••• 4567 */
export function maskPhone(e164: string): string {
  return `${e164.slice(0, 4)} •• ••• ${e164.slice(-4)}`;
}
