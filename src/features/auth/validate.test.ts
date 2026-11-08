import { describe, expect, it } from 'vitest';
import { validateRegistration } from './validate';

const ok = { name: 'Ama Mensah', email: 'ama@example.com', password: 'secret123', confirm: 'secret123' };

describe('registration validation', () => {
  it('accepts a complete form', () => {
    expect(validateRegistration(ok)).toEqual({});
  });
  it('flags each field', () => {
    expect(validateRegistration({ ...ok, name: ' A ' }).name).toBeTruthy();
    expect(validateRegistration({ ...ok, email: 'ama@' }).email).toBeTruthy();
    expect(validateRegistration({ ...ok, password: 'short1', confirm: 'short1' }).password).toBe('Use at least 8 characters.');
    expect(validateRegistration({ ...ok, password: 'onlyletters', confirm: 'onlyletters' }).password).toBe('Use letters and at least one number.');
    expect(validateRegistration({ ...ok, confirm: 'secret124' }).confirm).toBe('Passwords do not match.');
    expect(validateRegistration({ ...ok, confirm: '' }).confirm).toBe('Confirm your password.');
  });
});

describe('registration phone number', () => {
  const withPhone = { ...ok, country: 'GH', phone: '024 123 4567' };
  it('accepts a Ghana mobile number in local or international form', () => {
    expect(validateRegistration(withPhone)).toEqual({});
    expect(validateRegistration({ ...withPhone, phone: '+233 24 123 4567' })).toEqual({});
  });
  it('requires a number that can receive verification texts', () => {
    expect(validateRegistration({ ...withPhone, phone: '' }).phone).toBe('Enter your mobile number.');
    expect(validateRegistration({ ...withPhone, phone: '011 123 4567' }).phone).toMatch(/valid Ghana/);
    expect(validateRegistration({ ...withPhone, country: 'GB', phone: '07700 900123' }).phone).toMatch(/Ghana \(\+233\)/);
  });
});
