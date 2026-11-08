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

/**
 * Combine a country and a locally written number into E.164, or null when it
 * cannot be a valid number. The server normalises and validates again.
 */
export function toE164(country: Country, input: string): string | null {
  let digits = input.trim().replace(/[\s().-]/g, '');
  if (!/^\+?\d+$/.test(digits)) return null;
  if (digits.startsWith('00')) digits = '+' + digits.slice(2);
  if (!digits.startsWith('+')) digits = country.dial + digits.replace(/^0+/, '');
  if (digits.startsWith('+233')) return /^\+233(20|23|24|25|26|27|28|50|53|54|55|56|57|59)\d{7}$/.test(digits) ? digits : null;
  return /^\+[1-9]\d{7,14}$/.test(digits) ? digits : null;
}
