/**
 * Text utilities for the knowledge base: cleaning, keyword terms, compact
 * vector storage and HTML-to-text. Pure functions (unit tested).
 */
import { createHash } from 'node:crypto';
import type { Section } from '../docs/chunk.js';

const STOP = new Set(
  (
    'a an and are as at be been but by can could did do does for from had has have how i if in into is it its ' +
    'me my no not of on or our so than that the their them then there these they this to was we were what when ' +
    'where which who whom why will with would you your about also any all just more most other some such only own ' +
    'same very s t don should now tell know please give get us he she his her him'
  ).split(' '),
);

/** Very light stemming so "services"/"service" and "drones"/"drone" match. */
function stem(w: string): string {
  if (/[\d.+#]/.test(w)) return w; // node.js, c++, 5g, v2
  if (w.length > 5 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && w.endsWith('es') && /(?:ss|sh|ch|x|z)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) return w.slice(0, -1);
  return w;
}

/** Normalized keyword terms (lowercase, no stop words, lightly stemmed). */
export function terms(text: string): string[] {
  return (text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9][a-z0-9+#.-]*[a-z0-9+#]|[a-z0-9]/g) ?? [])
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem);
}

/** Distinct terms of a chunk, most frequent first (capped to keep the index small). */
export function chunkTerms(text: string, max = 80): string[] {
  const counts = new Map<string, number>();
  for (const t of terms(text)) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([t]) => t);
}

/**
 * BM25-style keyword scores over chunk term sets (presence only, since the
 * index stores distinct terms). Rare terms weigh more.
 */
export function keywordScores(queryTerms: string[], docs: string[][]): number[] {
  const q = [...new Set(queryTerms)];
  if (!q.length || !docs.length) return docs.map(() => 0);
  const sets = docs.map((d) => new Set(d));
  const n = docs.length;
  const idf = new Map(
    q.map((t) => {
      const df = sets.reduce((k, s) => k + (s.has(t) ? 1 : 0), 0);
      return [t, Math.log(1 + (n - df + 0.5) / (df + 0.5))];
    }),
  );
  return sets.map((s) => q.reduce((sum, t) => sum + (s.has(t) ? idf.get(t)! : 0), 0));
}

// ---- compact vectors: unit-normalized, int8, base64 ----

export function packVector(v: number[]): string {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  const bytes = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) bytes[i] = Math.max(-127, Math.min(127, Math.round((v[i] / norm) * 127)));
  return Buffer.from(bytes.buffer).toString('base64');
}

export function unpackVector(s: string): Float32Array {
  const buf = Buffer.from(s, 'base64');
  const bytes = new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] / 127;
  return out;
}

/** Cosine between a (normalized) packed vector and a query vector. */
export function cosinePacked(packed: Float32Array, query: Float32Array): number {
  let dot = 0;
  let a = 0;
  let b = 0;
  const n = Math.min(packed.length, query.length);
  for (let i = 0; i < n; i++) {
    dot += packed[i] * query[i];
    a += packed[i] * packed[i];
    b += query[i] * query[i];
  }
  return a && b ? dot / Math.sqrt(a * b) : 0;
}

// ---- cleaning ----

/** Normalize whitespace, drop control characters and repeated boilerplate lines. */
export function cleanText(text: string): string {
  const lines = text
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim());
  // lines repeated many times (page headers/footers, cookie banners) carry no information
  const counts = new Map<string, number>();
  for (const l of lines) if (l.length > 3 && l.length < 120) counts.set(l, (counts.get(l) ?? 0) + 1);
  const out = lines.filter((l) => !(l.length > 3 && l.length < 120 && (counts.get(l) ?? 0) >= 4));
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function contentHash(sections: Section[]): string {
  const h = createHash('sha256');
  for (const s of sections) h.update(s.ref).update('\u0000').update(s.text).update('\u0001');
  return h.digest('hex').slice(0, 40);
}

/** Stable id for a URL source, so the same page is never stored twice in one scope. */
export function urlSourceId(url: string): string {
  return 'u_' + createHash('sha1').update(normalizeUrl(url)).digest('hex').slice(0, 28);
}

export function normalizeUrl(raw: string): string {
  const u = new URL(raw);
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  for (const p of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|mc_)/i.test(p)) u.searchParams.delete(p);
  let s = u.toString();
  if (s.endsWith('/') && u.pathname !== '/') s = s.slice(0, -1);
  return s;
}

// ---- HTML to text ----

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", mdash: '—', ndash: '–', hellip: '…', copy: '©', reg: '®' };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16) || 32);
    if (k.startsWith('#')) return String.fromCodePoint(parseInt(k.slice(1), 10) || 32);
    return ENTITIES[k] ?? m;
  });
}

/**
 * Turn a web page into sections split at headings. Scripts, styles,
 * navigation, footers and forms are dropped; <main>/<article> is preferred.
 */
export function htmlToSections(html: string): { title: string; description: string; sections: Section[] } {
  const title = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim()).slice(0, 300);
  const description = decodeEntities(
    html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1] ??
      html.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)["']/i)?.[1] ??
      '',
  ).trim();
  let body = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<head\b[\s\S]*?<\/head>/i, ' ').replace(/<title\b[\s\S]*?<\/title>/gi, ' ');
  body = body.replace(/<(script|style|noscript|svg|template|iframe|canvas|form|select|button)\b[\s\S]*?<\/\1>/gi, ' ');
  const main = body.match(/<main\b[\s\S]*?<\/main>/i)?.[0] ?? body.match(/<article\b[\s\S]*?<\/article>/i)?.[0];
  if (main && main.replace(/<[^>]+>/g, '').trim().length > 400) body = main;
  else body = body.replace(/<(nav|footer|header|aside)\b[\s\S]*?<\/\1>/gi, ' ');
  // mark headings, then blocks
  body = body
    .replace(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, _l, inner: string) => `\n\u0002${inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}\u0003\n`)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|section|tr|li|h[4-6]|blockquote|pre|table|ul|ol|dd|dt)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ');
  const text = decodeEntities(body);
  const sections: Section[] = [];
  let heading = title || 'Page';
  let buf: string[] = [];
  const flush = () => {
    const t = cleanText(buf.join('\n'));
    if (t) sections.push({ ref: `§ ${heading}`.slice(0, 200), text: t });
    buf = [];
  };
  // eslint-disable-next-line no-control-regex
  for (const part of text.split(/(\u0002[^\u0003]*\u0003)/)) {
    if (part.startsWith('\u0002')) {
      flush();
      heading = part.slice(1, -1).trim() || heading;
    } else buf.push(part);
  }
  flush();
  if (description && !sections.some((s) => s.text.includes(description.slice(0, 60)))) {
    sections.unshift({ ref: '§ Description', text: description });
  }
  return { title, description, sections };
}
