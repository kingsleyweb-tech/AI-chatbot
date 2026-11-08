import { describe, expect, it } from 'vitest';
import { reminderDue, REMIND_AGAIN_MS } from './phoneReminderRules';

const now = 1_800_000_000_000;

describe('phone reminder', () => {
  it('is due for a loaded profile without a verified number', () => {
    expect(reminderDue({}, now)).toBe(true);
    expect(reminderDue({ phoneNumber: '+233241234567', phoneVerified: false }, now)).toBe(true);
  });
  it('never shows while the profile is loading', () => {
    expect(reminderDue(null, now)).toBe(false);
  });
  it('stops once a number is verified', () => {
    expect(reminderDue({ phoneNumber: '+233241234567', phoneVerified: true }, now)).toBe(false);
  });
  it('stays hidden for 14 days after "Skip for now", then returns', () => {
    const skippedAt = now;
    const p = { phoneReminderNextAt: skippedAt + REMIND_AGAIN_MS };
    expect(reminderDue(p, now + 13 * 86_400_000)).toBe(false);
    expect(reminderDue(p, now + 14 * 86_400_000)).toBe(true);
  });
  it('is due again after the number is removed (the server clears the skip date)', () => {
    expect(reminderDue({ phoneNumber: null, phoneVerified: false, phoneReminderNextAt: null }, now)).toBe(true);
  });
});
