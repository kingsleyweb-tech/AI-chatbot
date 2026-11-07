import { modelConfig } from './config/models.js';
import { embeddingProvider } from './providers/registry.js';

export interface Embedded {
  model: string;
  vectors: number[][];
}

let lastGood: string | null = null;

/**
 * Embed texts with the first working embedding model. Returns null when no
 * embedding model is reachable; callers then fall back to lexical scoring.
 */
export async function embed(texts: string[], preferredModel?: string): Promise<Embedded | null> {
  if (!texts.length) return { model: preferredModel ?? lastGood ?? '', vectors: [] };
  const candidates = [preferredModel, lastGood, ...modelConfig().embeddingModels].filter(
    (m, i, a): m is string => Boolean(m) && a.indexOf(m) === i && embeddingProvider(m!).isConfigured(),
  );
  const inputs = texts.map((t) => t.slice(0, 8000));
  for (const model of candidates) {
    const provider = embeddingProvider(model);
    if (!provider.embed) continue;
    try {
      const vectors: number[][] = [];
      for (let i = 0; i < inputs.length; i += 64) {
        vectors.push(...(await provider.embed(model, inputs.slice(i, i + 64))));
      }
      lastGood = model;
      return { model, vectors };
    } catch (err) {
      console.warn(`[embed] ${model} failed: ${err instanceof Error ? err.message : err}`);
      if (preferredModel === model) {
        // stored vectors are tied to this model; don't silently switch
        return null;
      }
    }
  }
  return null;
}

export function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

const STOP = new Set(
  'a an and are as at be but by for from has have i in is it its me my of on or our so that the their them they this to was we were what when where which who why will with you your do does did can could would should about into than then there these those how'.split(' '),
);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1 && !STOP.has(w));
}

/** Simple lexical overlap score in [0,1], used when embeddings are unavailable. */
export function lexicalScore(query: string, text: string): number {
  const q = new Set(tokenize(query));
  if (!q.size) return 0;
  const t = new Set(tokenize(text));
  let hit = 0;
  for (const w of q) if (t.has(w)) hit++;
  return hit / q.size;
}

export interface Scored<T> {
  item: T;
  score: number;
}

/** Rank items by vector similarity when possible, else lexically. */
export function rank<T>(
  items: T[],
  query: { text: string; vector?: number[] | null; model?: string | null },
  get: (item: T) => { text: string; vector?: number[] | null; model?: string | null },
): Scored<T>[] {
  return items
    .map((item) => {
      const v = get(item);
      const useVec =
        query.vector && v.vector && v.model && v.model === query.model && v.vector.length === query.vector.length;
      const score = useVec ? cosine(query.vector!, v.vector!) : lexicalScore(query.text, v.text) * 0.8;
      return { item, score };
    })
    .sort((a, b) => b.score - a.score);
}
