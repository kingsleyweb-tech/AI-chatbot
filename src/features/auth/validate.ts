/** Registration form checks (the server and Firebase enforce their own rules too). */
export function validateRegistration(v: { name: string; email: string; password: string; confirm: string }) {
  const errors: Partial<Record<keyof typeof v, string>> = {};
  const name = v.name.trim();
  if (name.length < 2) errors.name = 'Enter your full name.';
  else if (name.length > 80) errors.name = 'Name is too long.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.email.trim())) errors.email = 'Enter a valid email address.';
  if (v.password.length < 8) errors.password = 'Use at least 8 characters.';
  else if (!/[A-Za-z]/.test(v.password) || !/\d/.test(v.password)) errors.password = 'Use letters and at least one number.';
  if (!v.confirm) errors.confirm = 'Confirm your password.';
  else if (v.confirm !== v.password) errors.confirm = 'Passwords do not match.';
  return errors;
}
