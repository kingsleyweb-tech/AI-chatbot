/** "Skip for now" hides the phone reminder for this long. */
export const REMIND_AGAIN_MS = 14 * 86_400_000;

interface ReminderProfile {
  phoneNumber?: string | null;
  phoneVerified?: boolean;
  phoneReminderNextAt?: number | null;
}

/**
 * Should the "Secure your account" reminder be offered? Only to a loaded
 * profile without a verified number, and not before the skip period ends.
 * (Once-per-session and "no other dialog open" are checked by the component.)
 */
export function reminderDue(p: ReminderProfile | null | undefined, now: number): boolean {
  if (!p) return false;
  if (p.phoneVerified && p.phoneNumber) return false;
  const next = typeof p.phoneReminderNextAt === 'number' ? p.phoneReminderNextAt : 0;
  return next <= now;
}
