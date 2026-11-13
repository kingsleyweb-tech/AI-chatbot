/**
 * API key authentication and browser-origin checks.
 *
 * A key is accepted only when its format is valid, its record exists, the SHA-256 of the presented
 * key matches the stored hash (constant-time), the key is active and not expired, its mode matches,
 * and its integration exists, is active and not expired. Every refusal uses the same safe messages:
 * nothing reveals whether a key id exists. Repeated failures from one address are slowed down.
 */
import type { Firestore } from '../firestore.js';
import { HttpError } from '../http.js';
import { normalizeOrigin, type IntegrationConfig } from '../shared/apiPlatform.js';
import { keyMatches, parseKey, presentedKey } from './keys.js';
import { loadIntegration, loadKey, type KeyRecord } from './store.js';

export interface Authenticated {
  integration: IntegrationConfig;
  key: KeyRecord;
}

/* ------------------------------------------------------- failed-attempt throttle */

const FAIL_WINDOW = 60_000;
const FAIL_MAX = 20;
const failures = new Map<string, { at: number; n: number }>();

/** The caller's address as reported by the platform proxy (only used to slow down guessing). */
export function clientAddress(request: Request): string {
  const fwd = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return (fwd || request.headers.get('x-real-ip') || 'unknown').slice(0, 64);
}

function noteFailure(addr: string, now: number) {
  const cur = failures.get(addr);
  if (!cur || now - cur.at > FAIL_WINDOW) failures.set(addr, { at: now, n: 1 });
  else cur.n++;
  if (failures.size > 5_000) failures.clear();
}

function throttled(addr: string, now: number): boolean {
  const cur = failures.get(addr);
  return Boolean(cur && now - cur.at <= FAIL_WINDOW && cur.n >= FAIL_MAX);
}

export function resetAuthThrottle() {
  failures.clear();
}

/* ------------------------------------------------------------------ authenticate */

const invalid = () => new HttpError(401, 'invalid_api_key', 'The API key is not valid.');

/**
 * Verify the key on the request. Throws 401 (missing, invalid, revoked or expired key), 403
 * (disabled key, suspended/disabled/expired application) or 429 (too many failed attempts).
 */
export async function authenticate(db: Firestore, request: Request, now = Date.now()): Promise<Authenticated> {
  const addr = clientAddress(request);
  if (throttled(addr, now)) throw new HttpError(429, 'too_many_auth_failures', 'Too many failed authentication attempts. Try again in a minute.');
  const fail = (err: HttpError): never => {
    noteFailure(addr, now);
    throw err;
  };

  const raw = presentedKey(request.headers);
  if (!raw) fail(new HttpError(401, 'missing_api_key', 'Send the API key in the Authorization header: "Bearer atlas_live_…".'));
  const parsed = parseKey(raw as string);
  if (!parsed) fail(invalid());
  const { keyId, mode } = parsed as NonNullable<typeof parsed>;

  const key = await loadKey(db, keyId);
  if (!key || !keyMatches(raw as string, key.hash) || key.mode !== mode) fail(invalid());
  const k = key as KeyRecord;
  if (k.status === 'revoked') fail(new HttpError(401, 'key_revoked', 'This API key has been revoked.'));
  if (k.expiresAt !== null && k.expiresAt <= now) fail(new HttpError(401, 'key_expired', 'This API key has expired.'));
  if (k.status === 'disabled') fail(new HttpError(403, 'key_disabled', 'This API key is disabled.'));

  const integration = await loadIntegration(db, k.integrationId);
  if (!integration || integration.status === 'deleted') fail(invalid());
  return { integration: checkIntegration(integration as IntegrationConfig, now), key: k };
}

/** The integration may be used right now (status and expiry). */
export function checkIntegration(integration: IntegrationConfig, now = Date.now()): IntegrationConfig {
  if (integration.status === 'suspended') throw new HttpError(403, 'integration_suspended', 'This application’s API access is suspended.');
  if (integration.status !== 'active') throw new HttpError(403, 'integration_disabled', 'This application’s API access is disabled.');
  if (integration.expiresAt !== null && integration.expiresAt <= now) throw new HttpError(403, 'integration_expired', 'This application’s API access has expired.');
  return integration;
}

/* ------------------------------------------------------------------------ CORS */

export const CORS_ALLOW_HEADERS = 'authorization, content-type, x-atlas-key, x-atlas-user, idempotency-key';
export const CORS_ALLOW_METHODS = 'GET, POST, DELETE, OPTIONS';
export const CORS_EXPOSE_HEADERS = 'x-request-id, x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset, retry-after, atlas-api-version';

/**
 * Browser calls are accepted only from the integration's allowed origins (empty list: server-to-
 * server only, every browser origin refused). Requests without an Origin header are not browsers.
 */
export function corsHeaders(request: Request, integration: IntegrationConfig): Record<string, string> {
  const origin = request.headers.get('origin');
  if (!origin) return {};
  const norm = normalizeOrigin(origin);
  // Atlas AI's own site (the developer sandbox at /developers/sandbox): same host, so not a third party
  const host = request.headers.get('host');
  if (norm && host && new URL(norm).host === host) return {};
  if (!norm || !integration.allowedOrigins.includes(norm)) {
    throw new HttpError(403, 'origin_not_allowed', 'Requests from this website are not allowed for this application.');
  }
  return {
    'access-control-allow-origin': norm,
    'access-control-expose-headers': CORS_EXPOSE_HEADERS,
    vary: 'Origin',
  };
}

/**
 * Preflight (OPTIONS): browsers send no key here, so only the methods and headers are announced.
 * The origin itself is checked on the real request, against the integration of the key.
 */
export function preflight(request: Request): Response {
  const origin = request.headers.get('origin');
  const norm = origin ? normalizeOrigin(origin) : null;
  if (!norm) return new Response(null, { status: 204 });
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': norm,
      'access-control-allow-methods': CORS_ALLOW_METHODS,
      'access-control-allow-headers': CORS_ALLOW_HEADERS,
      'access-control-max-age': '600',
      vary: 'Origin',
    },
  });
}
