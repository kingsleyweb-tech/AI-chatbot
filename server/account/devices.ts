/**
 * Recognised devices, for new-device sign-in alerts.
 *
 * users/{uid}/devices/{key} (server-only: the users catch-all rule does not
 * list "devices", so clients can neither read nor write it directly).
 * The key is an HMAC of the account and the browser's random device id (the
 * x-atlas-device header, kept in that browser's storage), or of the browser
 * and system when an older app sends no id. Stored: coarse device, browser,
 * system, country/city from the IP, a partially hidden IP and dates; never
 * the full IP or user agent.
 *
 * checkSignIn() runs once per sign-in session (a new auth_time), never on
 * token refreshes or ordinary requests.
 */
import { createHmac } from 'node:crypto';
import type { Firestore } from '../firestore.js';
import type { DeviceFacts } from '../email/templates.js';

export interface ClientInfo {
  deviceId: string | null;
  userAgent: string | null;
  ip: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  timeZone: string | null;
}

export interface DeviceDoc {
  device: string;
  os: string;
  browser: string;
  country: string | null;
  location: string | null;
  ip: string | null;
  firstSeen: number;
  lastSeen: number;
}

export const MAX_DEVICES = 20;

function header(h: Headers, name: string): string | null {
  const v = h.get(name);
  if (!v) return null;
  try {
    return decodeURIComponent(v).trim().slice(0, 80) || null;
  } catch {
    return v.trim().slice(0, 80) || null;
  }
}

/** Device id, user agent, IP and Vercel's IP geolocation headers from a request. */
export function clientInfo(h: Headers): ClientInfo {
  const id = h.get('x-atlas-device');
  const tz = h.get('x-atlas-tz');
  return {
    deviceId: id && /^[A-Za-z0-9-]{16,64}$/.test(id) ? id : null,
    userAgent: h.get('user-agent'),
    ip: (h.get('x-forwarded-for') ?? '').split(',')[0]!.trim() || h.get('x-real-ip') || null,
    country: header(h, 'x-vercel-ip-country'),
    region: header(h, 'x-vercel-ip-country-region'),
    city: header(h, 'x-vercel-ip-city'),
    timeZone:
      tz && /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(tz) && tz.length <= 40 ? tz : null,
  };
}

/** "102.176.18.137" -> "102.176.x.x"; IPv6 keeps the first two groups. */
export function maskIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(ip);
  if (v4) return `${v4[1]}.${v4[2]}.x.x`;
  if (ip.includes(':')) return `${ip.split(':').slice(0, 2).join(':')}:…`;
  return null;
}

/** Device type, system and browser from a user agent. */
export function parseAgent(ua: string | null | undefined): {
  device: string;
  os: string;
  browser: string;
} {
  const s = ua ?? '';
  const os = /iPhone/.test(s)
    ? 'iOS'
    : /iPad/.test(s)
      ? 'iPadOS'
      : /Android/.test(s)
        ? 'Android'
        : /CrOS/.test(s)
          ? 'ChromeOS'
          : /Mac OS X|Macintosh/.test(s)
            ? 'macOS'
            : /Windows/.test(s)
              ? 'Windows'
              : /Linux/.test(s)
                ? 'Linux'
                : 'Unknown system';
  const browser = /Edg(?:A|iOS)?\//.test(s)
    ? 'Edge'
    : /OPR\/|Opera/.test(s)
      ? 'Opera'
      : /SamsungBrowser/.test(s)
        ? 'Samsung Internet'
        : /CriOS|Chrome\//.test(s)
          ? 'Chrome'
          : /FxiOS|Firefox\//.test(s)
            ? 'Firefox'
            : /Safari\//.test(s)
              ? 'Safari'
              : 'Unknown browser';
  const device =
    /iPad|Tablet/.test(s) || (/Android/.test(s) && !/Mobile/.test(s))
      ? 'Tablet'
      : /iPhone|Mobile|Android/.test(s)
        ? 'Phone'
        : s
          ? 'Computer'
          : 'Unknown device';
  return { device, os, browser };
}

const regionNames = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    return null;
  }
})();

/** "Accra, Greater Accra, Ghana" from the IP geolocation headers, or null when the country is unknown. */
export function locationOf(c: Pick<ClientInfo, 'country' | 'region' | 'city'>): string | null {
  if (!c.country || !/^[A-Z]{2}$/.test(c.country)) return null;
  let country = c.country;
  try {
    country = regionNames?.of(c.country) ?? c.country;
  } catch {
    /* keep the code */
  }
  return [c.city, country].filter(Boolean).join(', ');
}

export function deviceFacts(c: ClientInfo): DeviceFacts {
  return { ...parseAgent(c.userAgent), ip: maskIp(c.ip), location: locationOf(c) };
}

export function deviceKey(secret: string, uid: string, c: ClientInfo): string {
  const a = parseAgent(c.userAgent);
  const basis = c.deviceId ? `id|${c.deviceId}` : `ua|${a.device}|${a.os}|${a.browser}`;
  return createHmac('sha256', secret).update(`device|${uid}|${basis}`).digest('hex').slice(0, 32);
}

export interface SignInCheck {
  /** the device was seen before */
  known: boolean;
  /** first device ever recorded for this account (no alert: nothing to compare with) */
  first: boolean;
  /** why this sign-in looks unusual, when it does */
  suspicious: string | null;
  facts: DeviceFacts;
}

/** Record this sign-in's device and say whether it is new or unusual. */
export async function checkSignIn(
  db: Firestore,
  secret: string,
  uid: string,
  c: ClientInfo,
  now = Date.now(),
): Promise<SignInCheck> {
  const key = deviceKey(secret, uid, c);
  const facts = deviceFacts(c);
  const all = await db.list<DeviceDoc>(`users/${uid}/devices`, {
    orderBy: 'lastSeen',
    direction: 'DESCENDING',
    limit: 50,
  });
  const mine = all.find((d) => d.id === key);
  const doc: DeviceDoc = {
    device: facts.device,
    os: facts.os,
    browser: facts.browser,
    country: c.country,
    location: facts.location ?? null,
    ip: facts.ip ?? null,
    firstSeen: mine?.data.firstSeen ?? now,
    lastSeen: now,
  };
  await db.set(`users/${uid}/devices/${key}`, doc);
  // Keep the list short: forget the least recently used devices.
  const extra = all.filter((d) => d.id !== key).slice(MAX_DEVICES - 1);
  if (extra.length)
    await db
      .commit(extra.map((d) => ({ op: 'delete' as const, path: `users/${uid}/devices/${d.id}` })))
      .catch(() => undefined);

  if (mine) return { known: true, first: false, suspicious: null, facts };
  if (!all.length) return { known: false, first: true, suspicious: null, facts };
  const countries = new Set(all.map((d) => d.data.country).filter(Boolean));
  const suspicious =
    c.country && countries.size > 0 && !countries.has(c.country)
      ? `This sign-in came from a new device in a country your account has not been used from before (${facts.location ?? c.country}).`
      : null;
  return { known: false, first: false, suspicious, facts };
}

export interface DeviceView extends DeviceDoc {
  id: string;
  current: boolean;
}

export async function listDevices(
  db: Firestore,
  secret: string,
  uid: string,
  c: ClientInfo,
): Promise<DeviceView[]> {
  const key = deviceKey(secret, uid, c);
  const all = await db.list<DeviceDoc>(`users/${uid}/devices`, {
    orderBy: 'lastSeen',
    direction: 'DESCENDING',
    limit: MAX_DEVICES,
  });
  return all.map((d) => ({ ...d.data, id: d.id, current: d.id === key }));
}
