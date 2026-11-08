/**
 * Phone number handling. Verification texts currently go through a Ghana
 * gateway, so numbers are normalised to Ghana mobile numbers (+233).
 */

// Ghana mobile network prefixes (after the trunk 0 or the country code).
const GH_MOBILE = /^(20|23|24|25|26|27|28|50|53|54|55|56|57|59)\d{7}$/;

export type PhoneResult = { ok: true; e164: string } | { ok: false; reason: 'format' | 'country' };

export function normalizePhone(input: string): PhoneResult {
  let digits = input.trim().replace(/[\s().-]/g, '');
  if (!/^\+?\d+$/.test(digits)) return { ok: false, reason: 'format' };
  if (digits.startsWith('00')) digits = '+' + digits.slice(2);
  let national: string;
  if (digits.startsWith('+')) {
    if (!digits.startsWith('+233')) return { ok: false, reason: 'country' };
    national = digits.slice(4);
    if (national.startsWith('0')) national = national.slice(1);
  } else if (digits.startsWith('233') && digits.length === 12) national = digits.slice(3);
  else if (digits.startsWith('0') && digits.length === 10) national = digits.slice(1);
  else if (digits.length === 9) national = digits;
  else return { ok: false, reason: 'format' };
  return GH_MOBILE.test(national) ? { ok: true, e164: `+233${national}` } : { ok: false, reason: 'format' };
}

/** +233241234567 -> +233 •• ••• 4567 */
export function maskPhone(e164: string): string {
  return `${e164.slice(0, 4)} •• ••• ${e164.slice(-4)}`;
}

/**
 * Any international number as E.164 (for access requests). Ghana numbers
 * get the stricter mobile check above. `dialCode` (e.g. "+233") applies to
 * numbers written without one.
 */
export function normalizeInternational(input: string, dialCode = '+233'): PhoneResult {
  let digits = input.trim().replace(/[\s().-]/g, '');
  if (!/^\+?\d+$/.test(digits)) return { ok: false, reason: 'format' };
  if (digits.startsWith('00')) digits = '+' + digits.slice(2);
  if (!digits.startsWith('+')) {
    if (!/^\+[1-9]\d{0,3}$/.test(dialCode)) return { ok: false, reason: 'format' };
    digits = dialCode + digits.replace(/^0+/, '');
  }
  if (digits.startsWith('+233')) return normalizePhone(digits);
  return /^\+[1-9]\d{7,14}$/.test(digits) ? { ok: true, e164: digits } : { ok: false, reason: 'format' };
}
