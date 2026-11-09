/**
 * Translation that keeps the text's shape: Markdown structure (headings, list markers,
 * quotes, table pipes), line breaks and code are preserved; only the words are sent
 * to the translation model, one line or table cell at a time.
 */
import { TRANSLATE_CHUNK_CHARS, TRANSLATE_CODES } from '../config/speech.js';

export interface Piece {
  /** text sent to the model; empty for parts kept as they are */
  text: string;
  /** rebuilds the line from the translated text */
  render: (translated: string) => string;
}

const PREFIX = /^(\s*(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|>\s*)*)(.*)$/;
const ONLY_SYMBOLS = /^[\s\d\p{P}\p{S}]*$/u;
const URLISH = /^(https?:\/\/|www\.)\S+$/i;

function splitLong(text: string, max = TRANSLATE_CHUNK_CHARS): string[] {
  if (text.length <= max) return [text];
  const sentences = text.match(/[^.!?。！？]+[.!?。！？]*\s*/g) ?? [text];
  const out: string[] = [];
  let buf = '';
  for (const s of sentences) {
    if ((buf + s).length > max && buf) {
      out.push(buf);
      buf = '';
    }
    if (s.length > max) {
      for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
    } else buf += s;
  }
  if (buf) out.push(buf);
  return out;
}

/** Break Markdown into translatable pieces plus the parts to keep. */
export function planTranslation(md: string): Piece[] {
  const pieces: Piece[] = [];
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let inFence = false;
  lines.forEach((line, i) => {
    const nl = i < lines.length - 1 ? '\n' : '';
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      pieces.push({ text: '', render: () => line + nl });
      return;
    }
    if (inFence || ONLY_SYMBOLS.test(line) || URLISH.test(line.trim())) {
      pieces.push({ text: '', render: () => line + nl });
      return;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      // table row: translate each cell, keep the pipes and the alignment row
      const cells = line.split('|');
      cells.forEach((cell, c) => {
        const sep = c < cells.length - 1 ? '|' : nl;
        if (ONLY_SYMBOLS.test(cell)) pieces.push({ text: '', render: () => cell + sep });
        else {
          const lead = cell.match(/^\s*/)?.[0] ?? '';
          const trail = cell.match(/\s*$/)?.[0] ?? '';
          pieces.push({ text: cell.trim(), render: (t) => lead + t + trail + sep });
        }
      });
      return;
    }
    const m = PREFIX.exec(line)!;
    const prefix = m[1];
    const body = m[2];
    const parts = splitLong(body);
    parts.forEach((p, k) => {
      const first = k === 0;
      const last = k === parts.length - 1;
      pieces.push({ text: p.trim(), render: (t) => (first ? prefix : ' ') + t + (last ? nl : '') });
    });
  });
  return pieces;
}

/* ------------------------------ language detection ------------------------------ */

const STOPWORDS: Record<string, string[]> = {
  english: ['the', 'and', 'is', 'are', 'you', 'what', 'this', 'that', 'with', 'for', 'how', 'of', 'to', 'in', 'it', 'i'],
  french: ['le', 'la', 'les', 'et', 'est', 'vous', 'je', 'une', 'des', 'pour', 'avec', 'que', 'pas', 'du', 'ce', 'bonjour'],
  spanish: ['el', 'los', 'las', 'es', 'y', 'que', 'una', 'por', 'para', 'con', 'cómo', 'está', 'hola', 'pero', 'muy', 'del'],
  portuguese: ['o', 'os', 'as', 'é', 'e', 'que', 'uma', 'para', 'com', 'não', 'você', 'está', 'olá', 'muito', 'do', 'da'],
  german: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ich', 'sie', 'ein', 'eine', 'mit', 'für', 'wie', 'auf', 'hallo', 'zu'],
  italian: ['il', 'gli', 'è', 'e', 'che', 'una', 'per', 'con', 'non', 'sono', 'ciao', 'come', 'della', 'del', 'questo', 'lo'],
  dutch: ['de', 'het', 'een', 'en', 'is', 'niet', 'ik', 'je', 'van', 'met', 'voor', 'hoe', 'dat', 'zijn', 'hallo', 'wat'],
  turkish: ['ve', 'bir', 'bu', 'için', 'ne', 'nasıl', 'merhaba', 'çok', 'ben', 'sen', 'değil', 'ile', 'mi', 'var', 'da', 'de'],
  swahili: ['na', 'ya', 'wa', 'kwa', 'ni', 'za', 'habari', 'jambo', 'mimi', 'wewe', 'sana', 'katika', 'hii', 'kuwa', 'asante', 'la'],
  hausa: ['da', 'na', 'ba', 'ya', 'ta', 'kuma', 'yana', 'ina', 'sannu', 'wannan', 'shi', 'ita', 'mu', 'ku', 'zuwa', 'daga'],
  yoruba: ['ni', 'ati', 'ti', 'mo', 'o', 'ẹ', 'bawo', 'jọwọ', 'kini', 'naa', 'wa', 'si', 'fun', 'ṣe', 'pẹlu', 'yii'],
  igbo: ['na', 'ka', 'm', 'ị', 'ndị', 'nke', 'kedu', 'biko', 'ya', 'gị', 'anyị', 'ha', 'bụ', 'ọ', 'dị', 'maka'],
  zulu: ['ukuthi', 'futhi', 'ngi', 'u', 'kakhulu', 'sawubona', 'ngiyabonga', 'yini', 'kanjani', 'lokhu', 'wena', 'mina', 'kodwa', 'noma', 'ngoba', 'kwa'],
};

/**
 * Best guess of the language of `text` (one of the offered languages), or null when unsure.
 * Free: no model call. Scripts decide most languages; Latin-script text is scored by common words.
 */
export function detectLanguage(text: string): string | null {
  const t = text.slice(0, 2000);
  const count = (re: RegExp) => (t.match(re) ?? []).length;
  if (count(/[぀-ヿ]/g) > 0) return 'japanese';
  if (count(/[가-힯]/g) > 2) return 'korean';
  if (count(/[一-鿿]/g) > 2) return 'chinese';
  if (count(/[؀-ۿ]/g) > 2) return 'arabic';
  if (count(/[ऀ-ॿ]/g) > 2) return 'hindi';
  if (count(/[Ѐ-ӿ]/g) > 2) return 'russian';
  const words = t.toLowerCase().match(/[\p{L}']+/gu) ?? [];
  if (!words.length) return null;
  const scores = Object.entries(STOPWORDS).map(([lang, list]) => {
    const set = new Set(list);
    return [lang, words.filter((w) => set.has(w)).length] as const;
  });
  scores.sort((a, b) => b[1] - a[1]);
  const [best, second] = scores;
  if (!best || best[1] === 0) return null;
  // need a clear lead: short or mixed text is left to the user to choose
  if (best[1] < 2 || best[1] < second[1] * 1.5) return null;
  return TRANSLATE_CODES.has(best[0]) ? best[0] : null;
}

/** Explicit request such as "translate this to French" / "in Spanish": the target language, if offered. */
export function requestedTarget(text: string): string | null {
  const m = /\b(?:translate|translation|say|write)\b[^.?!\n]{0,80}?\b(?:to|into|in)\s+([a-z]+)\b/i.exec(text);
  const lang = m?.[1]?.toLowerCase();
  return lang && TRANSLATE_CODES.has(lang) ? lang : null;
}

/** Run `fn` over items with at most `n` at a time, keeping order. */
export async function mapLimit<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
