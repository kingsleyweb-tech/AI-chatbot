/**
 * Atlas AI API keys.
 *
 * Format: atlas_<live|test>_<16 hex: key id>_<43 chars: 256-bit secret, base64url>
 *
 * - Generated with crypto.randomBytes (CSPRNG); nothing in a key is predictable or derived from data.
 * - Only a SHA-256 hash of the whole key is stored (apiKeys/{id}.hash). A key with 256 bits of
 *   randomness cannot be guessed or brute-forced from its hash, so no slow hash is needed (the same
 *   approach as GitHub and Stripe tokens). The full key is returned once, at creation or rotation.
 * - The key id inside the key lets the server read exactly one record (no query over all keys),
 *   then compare the hash in constant time.
 * - These keys are Atlas AI's own credentials. They are never provider keys and never give access
 *   to Gemini, OpenRouter, Cloudflare, Tavily, SerpAPI or ElevenLabs credentials.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { KeyMode } from '../shared/apiPlatform.js';

const KEY_RE = /^atlas_(live|test)_([a-f0-9]{16})_([A-Za-z0-9_-]{43})$/;

export interface ParsedKey {
  mode: KeyMode;
  /** apiKeys document id */
  keyId: string;
}

export interface NewKey {
  /** the full key: show once, never store */
  secret: string;
  keyId: string;
  mode: KeyMode;
  hash: string;
  display: string;
}

export const keyIdFromBody = (body: string) => `key_${body}`;

export function hashKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export function displayKey(mode: KeyMode, body: string, secret: string): string {
  return `atlas_${mode}_${body.slice(0, 6)}…${secret.slice(-4)}`;
}

export function generateKey(mode: KeyMode): NewKey {
  const body = randomBytes(8).toString('hex');
  const secretPart = randomBytes(32).toString('base64url');
  const secret = `atlas_${mode}_${body}_${secretPart}`;
  return { secret, keyId: keyIdFromBody(body), mode, hash: hashKey(secret), display: displayKey(mode, body, secretPart) };
}

/** Structure check only (no database read for malformed keys). */
export function parseKey(raw: string): ParsedKey | null {
  const m = KEY_RE.exec(raw);
  if (!m) return null;
  return { mode: m[1] as KeyMode, keyId: keyIdFromBody(m[2]) };
}

/** Constant-time comparison of a presented key with the stored hash. */
export function keyMatches(presented: string, storedHash: unknown): boolean {
  if (typeof storedHash !== 'string' || !/^[a-f0-9]{64}$/.test(storedHash)) return false;
  const a = Buffer.from(hashKey(presented), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The key from "Authorization: Bearer <key>" or "X-Atlas-Key: <key>". */
export function presentedKey(headers: Headers): string | null {
  const auth = headers.get('authorization') ?? '';
  const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
  if (m) return m[1];
  const x = headers.get('x-atlas-key')?.trim();
  return x || null;
}

/** Random ids for integrations, conversations, messages and requests. */
export const newId = (prefix: string, bytes = 8) => `${prefix}_${randomBytes(bytes).toString('hex')}`;

export const shortHash = (value: string, length = 24) => createHash('sha256').update(value, 'utf8').digest('hex').slice(0, length);
