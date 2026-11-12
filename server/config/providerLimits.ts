/**
 * Free-tier rate limits Atlas AI plans around, per Gemini model.
 *
 * Sources (Gemini account A, the existing project, verified 2026-11-11):
 *  - RPM: Google AI Studio › Rate limits for the project (screenshot supplied by the owner):
 *    3.8 Flash 5, 3.6 Flash 5, 3.5 Flash-Lite 15, 3.1 Flash-Lite 15, Embedding 100.
 *  - RPD: Google's own 429 response for 3.8 Flash and 3.6 Flash
 *    (`GenerateRequestsPerDayPerProjectPerModel-FreeTier`, quotaValue 20).
 *  - Not verified: RPD of the Flash-Lite and embedding models and every TPM figure (Google does
 *    not report them through the API). They are left out rather than guessed; the 429 handling
 *    covers them.
 *
 * Account B is a separate Google project whose limits were not shown to us. Until Google reports
 * a figure for it (a 429 carries the quota value, which is then stored and used), these same
 * figures are applied to B as a safe assumption.
 *
 * Limits are per Google project and per model; Gemini's daily quota resets at midnight Pacific time.
 */
export interface ModelLimits {
  rpm?: number;
  rpd?: number;
}

export const GEMINI_LIMITS: Record<string, ModelLimits> = {
  'gemini-3.8-flash': { rpm: 5, rpd: 20 },
  'gemini-3.6-flash': { rpm: 5, rpd: 20 },
  'gemini-3.5-flash-lite': { rpm: 15 },
  'gemini-3.1-flash-lite': { rpm: 15 },
  'gemini-embedding-001': { rpm: 100 },
};

/** Atlas stays this far below a per-minute limit (protects against bursts from several instances). */
export const RPM_SAFETY = 0.8;

/** Requests per minute Atlas allows itself on one account for one model (null: no known limit). */
export function rpmGuard(limits: ModelLimits | undefined): number | null {
  return limits?.rpm ? Math.max(1, Math.floor(limits.rpm * RPM_SAFETY)) : null;
}

const pacific = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function pacificParts(now: number) {
  const p = Object.fromEntries(pacific.formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, h: Number(p.hour), m: Number(p.minute), s: Number(p.second) };
}

/** Gemini's quota day (Pacific time), e.g. "2026-11-11". */
export function pacificDay(now = Date.now()): string {
  return pacificParts(now).day;
}

/** The next midnight Pacific time (when Gemini's daily quotas reset), in ms. */
export function nextPacificMidnight(now = Date.now()): number {
  const { h, m, s } = pacificParts(now);
  let t = now - ((h * 60 + m) * 60 + s) * 1000 - (now % 1000) + 86_400_000;
  // daylight-saving days are 23 or 25 hours long: step to the real day change
  const today = pacificDay(now);
  while (pacificDay(t) === today) t += 3_600_000; // not yet the next day
  while (pacificDay(t - 3_600_000) !== today) t -= 3_600_000; // an hour past it
  return t;
}
