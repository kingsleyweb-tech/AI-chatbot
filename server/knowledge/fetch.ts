/**
 * Fetch a public web page for the knowledge base. Free (no search credits).
 *
 * SSRF protection: http(s) only, default ports only, every hop (including
 * redirects) must resolve exclusively to public addresses, size and time
 * limits, text/html or text/plain only.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { HttpError } from '../http.js';
import { htmlToSections } from './text.js';
import type { Section } from '../docs/chunk.js';

export const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 4;

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::' || v6 === '::1') return true;
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v6.replace(/^\[|\]$/g, ''));
}

/** Validate a URL for fetching; throws a user-facing error when it is not allowed. */
export async function assertPublicUrl(raw: string, resolve = lookup): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(400, 'bad_url', 'That is not a valid web address.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new HttpError(400, 'bad_url', 'Only http and https links can be added.');
  if (u.username || u.password) throw new HttpError(400, 'bad_url', 'Links with credentials are not allowed.');
  if (u.port && u.port !== '80' && u.port !== '443') throw new HttpError(400, 'bad_url', 'Only standard web ports are allowed.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i.test(host)) {
    throw new HttpError(400, 'bad_url', 'Private or local addresses cannot be added.');
  }
  const addrs = isIP(host) ? [{ address: host }] : await resolve(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new HttpError(400, 'bad_url', 'That website could not be found.');
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new HttpError(400, 'bad_url', 'Private or local addresses cannot be added.');
  return u;
}

export interface FetchedPage {
  url: string;
  title: string;
  sections: Section[];
}

export async function fetchPage(raw: string, opts: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {}): Promise<FetchedPage> {
  const doFetch = opts.fetchImpl ?? fetch;
  let url = (await assertPublicUrl(raw)).toString();
  let res: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    res = await doFetch(url, {
      redirect: 'manual',
      headers: { 'user-agent': 'AtlasAIKnowledgeBot/1.0 (+personal assistant; fetches pages a user added)', accept: 'text/html,text/plain;q=0.9' },
      signal: opts.signal ?? AbortSignal.timeout(15_000),
    }).catch((err) => {
      throw new HttpError(502, 'fetch_failed', `Could not reach the page (${err instanceof Error ? err.message : 'network error'}).`);
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = (await assertPublicUrl(new URL(res.headers.get('location')!, url).toString())).toString();
      continue;
    }
    break;
  }
  if (!res || (res.status >= 300 && res.status < 400)) throw new HttpError(502, 'fetch_failed', 'The page redirected too many times.');
  if (!res.ok) throw new HttpError(502, 'fetch_failed', `The page returned an error (HTTP ${res.status}).`);
  const type = (res.headers.get('content-type') ?? '').toLowerCase();
  if (type && !type.includes('text/html') && !type.includes('text/plain') && !type.includes('xhtml')) {
    throw new HttpError(415, 'unsupported_page', 'Only web pages (HTML or plain text) can be added by link. Upload files directly instead.');
  }
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_PAGE_BYTES) throw new HttpError(413, 'too_large', 'The page is too large to add.');
  const body = await readLimited(res, MAX_PAGE_BYTES);
  if (type.includes('text/plain')) {
    return { url, title: new URL(url).hostname, sections: [{ ref: 'Text', text: body }] };
  }
  const { title, sections } = htmlToSections(body);
  return { url, title: title || new URL(url).hostname, sections };
}

async function readLimited(res: Response, max: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, 'too_large', 'The page is too large to add.');
    }
    chunks.push(value);
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks));
}
