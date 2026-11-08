import { countryByCode, SMS_COUNTRIES, toE164 } from '@/lib/phone';

/** Registration form checks (the server and Firebase enforce their own rules too). */
export function validateRegistration(v: { name: string; email: string; password: string; confirm: string; phone?: string; country?: string }) {
  const errors: Partial<Record<'name' | 'email' | 'password' | 'confirm' | 'phone', string>> = {};
  const name = v.name.trim();
  if (name.length < 2) errors.name = 'Enter your full name.';
  else if (name.length > 80) errors.name = 'Name is too long.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.email.trim())) errors.email = 'Enter a valid email address.';
  if (v.phone !== undefined) {
    const country = countryByCode(v.country ?? 'GH');
    if (!v.phone.trim()) errors.phone = 'Enter your mobile number.';
    else if (!SMS_COUNTRIES.has(country.code)) errors.phone = 'Verification texts can only be sent to Ghana (+233) numbers at the moment.';
    else if (!toE164(country, v.phone)) errors.phone = `Enter a valid ${country.name} mobile number, for example ${country.example}.`;
  }
  if (v.password.length < 8) errors.password = 'Use at least 8 characters.';
  else if (!/[A-Za-z]/.test(v.password) || !/\d/.test(v.password)) errors.password = 'Use letters and at least one number.';
  if (!v.confirm) errors.confirm = 'Confirm your password.';
  else if (v.confirm !== v.password) errors.confirm = 'Passwords do not match.';
  return errors;
}
