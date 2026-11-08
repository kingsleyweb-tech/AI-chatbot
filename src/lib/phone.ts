import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/min';

/** Countries offered in phone fields. Verification texts currently reach Ghana numbers only. */
export interface Country {
  code: string;
  name: string;
  dial: string;
  example: string;
}

export const COUNTRIES: Country[] = [
  { code: 'GH', name: 'Ghana', dial: '+233', example: '024 123 4567' },
  { code: 'NG', name: 'Nigeria', dial: '+234', example: '0803 123 4567' },
  { code: 'CI', name: "Côte d'Ivoire", dial: '+225', example: '01 23 45 67 89' },
  { code: 'TG', name: 'Togo', dial: '+228', example: '90 12 34 56' },
  { code: 'BF', name: 'Burkina Faso', dial: '+226', example: '70 12 34 56' },
  { code: 'KE', name: 'Kenya', dial: '+254', example: '0712 345678' },
  { code: 'ZA', name: 'South Africa', dial: '+27', example: '071 234 5678' },
  { code: 'GB', name: 'United Kingdom', dial: '+44', example: '07700 900123' },
  { code: 'US', name: 'United States / Canada', dial: '+1', example: '(201) 555-0123' },
  { code: 'DE', name: 'Germany', dial: '+49', example: '01512 3456789' },
  { code: 'FR', name: 'France', dial: '+33', example: '06 12 34 56 78' },
  { code: 'IN', name: 'India', dial: '+91', example: '081234 56789' },
];

/** Countries whose numbers can receive verification texts. */
export const SMS_COUNTRIES = new Set(['GH']);

export function countryByCode(code: string): Country {
  return COUNTRIES.find((c) => c.code === code) ?? COUNTRIES[0];
}

/** Ghana mobile network prefixes (after +233). The server checks again with full metadata. */
const GH_MOBILE = /^(20|23|24|25|26|27|28|50|53|54|55|56|57|59)\d{7}$/;

/**
 * Combine a country and a locally written number into E.164, or null when it
 * cannot be a valid number. Accepts 0501901401, +233501901401, 233501901401,
 * 00233…, and the common mistake +2330501901401. The server normalises and
 * validates again.
 */
export function toE164(country: Country, input: string): string | null {
  let s = input.trim().replace(/[\s().-]/g, '');
  if (!/^\+?\d+$/.test(s)) return null;
  if (s.startsWith('00')) s = '+' + s.slice(2);
  else if (!s.startsWith('+') && country.code === 'GH' && /^233\d{9,10}$/.test(s)) s = '+' + s;
  const p = s.startsWith('+') ? parsePhoneNumberFromString(s) : parsePhoneNumberFromString(s, country.code as CountryCode);
  if (!p) return null;
  let national = String(p.nationalNumber);
  // "+233 0XX…": drop the domestic trunk zero that was kept after the country code
  if (p.countryCallingCode === '233' && national.length === 10 && national.startsWith('0')) national = national.slice(1);
  if (p.countryCallingCode === '233') return GH_MOBILE.test(national) ? `+233${national}` : null;
  return p.isValid() ? p.number : null;
}

/** +233501901401 -> +233 50 190 1401 (international format). */
export function formatPhone(e164: string): string {
  return parsePhoneNumberFromString(e164)?.formatInternational() ?? e164;
}
