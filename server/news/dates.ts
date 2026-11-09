/**
 * Publication date handling for news. Search engines and feeds report dates in many shapes
 * ("3 minutes ago", "Nov 8, 2026", RFC 822, ISO 8601, two-digit years); this turns them into one
 * timestamp at the moment of retrieval, so a cached result never "ages backwards".
 *
 * Validation keeps the kinds of date apart:
 *  - published: when the article first appeared (the freshness signal)
 *  - updated:   a later revision (never treated as a new publication)
 *  - urlDate:   a date in the article's address (/2024/05/12/...), a strong hint of the original
 *               publication day that catches old articles re-indexed or re-dated by an aggregator
 * A date that cannot be established is "unknown"; such an article is never presented as current.
 */

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

const UNIT_MS: Record<string, number> = {
  second: 1_000, sec: 1_000, s: 1_000,
  minute: 60_000, min: 60_000, m: 60_000,
  hour: 3_600_000, hr: 3_600_000, h: 3_600_000,
  day: 86_400_000, d: 86_400_000,
  week: 7 * 86_400_000, w: 7 * 86_400_000,
  month: 30 * 86_400_000, mo: 30 * 86_400_000,
  year: 365 * 86_400_000, y: 365 * 86_400_000, yr: 365 * 86_400_000,
};

/** Earliest and latest timestamps we accept as a publication date (rejects garbage like year 1970 or 2099). */
const MIN_TS = Date.UTC(1995, 0, 1);
const FUTURE_SLACK = 36 * 3_600_000; // time zones and slightly early embargo timestamps

function sane(ts: number, now: number): number | null {
  return Number.isFinite(ts) && ts >= MIN_TS && ts <= now + FUTURE_SLACK ? ts : null;
}

/**
 * Parse a date string as reported by a provider or feed. Relative forms are resolved against
 * `now` (the retrieval time). Returns null when the string is not a recognisable date.
 */
export function parseDate(raw: string | null | undefined, now = Date.now()): number | null {
  if (!raw) return null;
  const s = raw.trim().replace(/\s+/g, ' ');
  if (!s) return null;
  const lower = s.toLowerCase();

  if (/^(just now|moments? ago|now)$/.test(lower)) return now;
  const rel = lower.match(/^(an?|\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|mos?|years?|yrs?|[smhdwy])\s*ago$/);
  if (rel) {
    const n = rel[1] === 'a' || rel[1] === 'an' ? 1 : Number(rel[1]);
    const unit = rel[2].replace(/s$/, '');
    const ms = UNIT_MS[unit] ?? UNIT_MS[rel[2]];
    return ms ? sane(now - n * ms, now) : null;
  }
  if (lower === 'yesterday') return sane(now - 86_400_000, now);
  if (lower === 'today') return now;

  // RFC 822 with a two-digit year ("Fri, 06 Nov 26 12:00:00 +0000"): Date.parse reads 26 as 1926 or 2026
  // depending on the engine, so expand it explicitly.
  const two = s.match(/^(?:[A-Za-z]{3},\s*)?(\d{1,2})\s+([A-Za-z]{3,4})\s+(\d{2})\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*(.*)$/);
  if (two) {
    const t = Date.parse(`${two[1]} ${two[2]} 20${two[3]} ${two[4]} ${two[5] || 'GMT'}`.trim());
    if (Number.isFinite(t)) return sane(t, now);
  }
  // "Nov 8, 2026" / "8 Nov 2026" / "November 8, 2026, 10:00 AM" (no zone: UTC)
  const md = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/) ?? null;
  const dm = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/) ?? null;
  if ((md || dm) && !/[+-]\d{2}:?\d{2}|gmt|utc|z\b/i.test(s.slice(10))) {
    const [mon, day, year] = md ? [md[1], md[2], md[3]] : [dm![2], dm![1], dm![3]];
    const m = MONTHS[mon.slice(0, mon.toLowerCase().startsWith('sept') ? 4 : 3).toLowerCase()];
    if (m !== undefined) {
      const time = s.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
      let h = time ? Number(time[1]) : 12; // midday: the safest guess for a date without a time
      if (time?.[3]) h = (h % 12) + (time[3].toLowerCase() === 'pm' ? 12 : 0);
      return sane(Date.UTC(Number(year), m, Number(day), h, time ? Number(time[2]) : 0), now);
    }
  }
  // SerpAPI google_news style "11/09/2026, 08:00 AM, +0000 UTC"
  const us = s.match(/^(\d{2})\/(\d{2})\/(\d{4}),?\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (us) {
    let h = Number(us[4]);
    if (us[6]) h = (h % 12) + (us[6].toUpperCase() === 'PM' ? 12 : 0);
    return sane(Date.UTC(Number(us[3]), Number(us[1]) - 1, Number(us[2]), h, Number(us[5])), now);
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? sane(t, now) : null;
}

/** A publication day encoded in the article URL (/2024/05/12/, /2024-05-12-, /20240512/), as UTC midday. */
export function urlDate(url: string, now = Date.now()): number | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const m =
    path.match(/(?:^|\/)(20\d{2}|19\d{2})[/-](0[1-9]|1[0-2])[/-](0[1-9]|[12]\d|3[01])(?:[/-]|$)/) ??
    path.match(/(?:^|[/_-])(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?:[/_-]|$)/);
  if (m) return sane(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12), now);
  // year + month only (/2024/05/slug): the 15th
  const ym = path.match(/(?:^|\/)(20\d{2})\/(0[1-9]|1[0-2])\/[^/]*[a-z]/i);
  if (ym) return sane(Date.UTC(Number(ym[1]), Number(ym[2]) - 1, 15, 12), now);
  return null;
}

export type DateBasis = 'feed' | 'provider' | 'url' | 'none';
export type DateStatus = 'confirmed' | 'reported' | 'unknown';

export interface DateCheck {
  /** best estimate of the original publication time (ms), or null when unknown */
  published: number | null;
  /** a later revision time, when one was reported separately */
  updated: number | null;
  basis: DateBasis;
  /** confirmed: two independent signals agree, or a publisher feed timestamp; reported: one provider date */
  status: DateStatus;
  /** the reported date is recent but the URL shows a much older original: an old article re-dated or re-indexed */
  redated: boolean;
}

/** Days two date signals may differ and still agree (time zones, late indexing, overnight publication). */
const AGREE_MS = 2 * 86_400_000;

/**
 * Decide an article's publication date from every signal available.
 * `feedPublished` comes from the publisher's own RSS/Atom entry (most reliable); `reported` from a
 * search provider (may be an indexing or crawl time); `updated` from an updated/modified field.
 */
export function checkDate(input: { url: string; feedPublished?: number | null; reported?: number | null; updated?: number | null }, now = Date.now()): DateCheck {
  const fromUrl = urlDate(input.url, now);
  const updated = input.updated ?? null;
  const feed = input.feedPublished ?? null;
  const reported = input.reported ?? null;

  if (feed != null) {
    // a feed entry whose URL is from a much earlier day is a re-published old article
    const redated = fromUrl != null && feed - fromUrl > AGREE_MS + 86_400_000;
    return { published: redated ? fromUrl : feed, updated: redated ? feed : updated, basis: redated ? 'url' : 'feed', status: 'confirmed', redated };
  }
  if (reported != null) {
    if (fromUrl != null) {
      if (reported - fromUrl > AGREE_MS + 86_400_000) {
        // e.g. a 2024 article that a search engine shows as "2 hours ago": use the URL's original date
        return { published: fromUrl, updated: reported, basis: 'url', status: 'confirmed', redated: true };
      }
      if (Math.abs(reported - fromUrl) <= AGREE_MS) return { published: reported, updated, basis: 'provider', status: 'confirmed', redated: false };
    }
    return { published: reported, updated, basis: 'provider', status: 'reported', redated: false };
  }
  if (fromUrl != null) return { published: fromUrl, updated, basis: 'url', status: 'reported', redated: false };
  return { published: null, updated, basis: 'none', status: 'unknown', redated: false };
}

export function isoOrNull(ts: number | null): string | null {
  return ts == null ? null : new Date(ts).toISOString();
}
