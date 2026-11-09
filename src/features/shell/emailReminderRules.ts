/** After "Skip for now" on the sign-up screen, the first dashboard reminder waits this long. */
export const EMAIL_FIRST_REMINDER_MS = 86_400_000;
/** Later "Skip for now" choices: 3 days, then a week from the third skip on. */
export function emailRemindAgainMs(skips: number): number {
  return (skips >= 2 ? 7 : 3) * 86_400_000;
}

interface ReminderProfile {
  emailReminderNextAt?: number | null;
}

/**
 * Should the "Verify your email" reminder be offered? Only to a signed-in,
 * allowed account whose email is not verified, and not before the skip
 * period ends. (Once per session and "no other dialog open" are checked by
 * the component.)
 */
export function emailReminderDue(
  emailVerified: boolean | undefined,
  p: ReminderProfile | null | undefined,
  now: number,
): boolean {
  if (emailVerified !== false || !p) return false;
  const next = typeof p.emailReminderNextAt === 'number' ? p.emailReminderNextAt : 0;
  return next <= now;
}
