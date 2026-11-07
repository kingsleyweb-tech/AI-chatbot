/**
 * Deterministic helpers for building search queries. The decision whether to
 * search at all lives in decide.ts.
 */
import { classifyIntent, decideSearch, KNOWLEDGE_YEAR } from './decide.js';

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/gi;

export function extractUrls(text: string): string[] {
  return [...new Set((text.match(URL_RE) ?? []).map((u) => u.replace(/[.,;:!?]+$/, '')))].slice(0, 5);
}

/**
 * Kept for callers/tests: true when the decision engine would search on its own
 * (auto mode, no toggles).
 */
export function needsWebSearch(text: string): boolean {
  return decideSearch(text).action !== 'none';
}

export { classifyIntent, KNOWLEDGE_YEAR };

const FILLER =
  /^(?:(?:hey|hi|hello|ok|okay|so|please|pls|can you|could you|would you|will you|i want you to|i need you to|help me)[\s,]+)*(?:(?:search|google|look\s*up|find|check)(?: (?:the )?(?:web|internet|online))?(?: for)?[\s,:]+)?/i;

/** Turn a chat message into a compact search query (deterministic). */
export function toSearchQuery(text: string): string {
  let q = text.replace(URL_RE, ' ').replace(/\s+/g, ' ').trim();
  q = q.replace(FILLER, '').trim();
  if (q.length > 300) {
    const firstQuestion = q.match(/[^.?!]{8,300}\?/);
    q = firstQuestion ? firstQuestion[0] : q.slice(0, 300).replace(/\s+\S*$/, '');
  }
  return q;
}

/** Short follow-ups ("and in 2025?", "what about him") need the conversation to make sense. */
export function looksLikeFollowUp(text: string): boolean {
  const words = text.trim().split(/\s+/).length;
  return words <= 8 && /\b(it|its|that|this|they|them|their|he|him|his|she|her|those|these|there|same|what about|and|also)\b/i.test(text);
}
