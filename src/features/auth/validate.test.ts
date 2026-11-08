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
