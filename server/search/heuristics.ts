/**
 * Deterministic rules for *whether* to search and *how*. No model call, no
 * credits: a search only happens when the user asks for one or the message
 * clearly needs current information.
 */
import type { SearchIntent, SearchKind } from './types.js';

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/gi;

export function extractUrls(text: string): string[] {
  return [...new Set((text.match(URL_RE) ?? []).map((u) => u.replace(/[.,;:!?]+$/, '')))].slice(0, 5);
}

const EXPLICIT =
  /\b(search|google|look\s*up|lookup|browse|find (?:me )?(?:online|on the web|sources|articles|links)|check (?:online|the web|the internet)|web results?)\b/i;
const STRONG =
  /\b(news|headlines?|breaking|weather|forecast|stock price|share price|exchange rate|price of|prices? (?:today|now)|how much (?:does|is) .{1,40} cost|scores?|standings|fixtures|election results?|release date|box office|trending|live updates?)\b/i;
const RECENCY =
  /\b(latest|current(?:ly)?|today|tonight|yesterday|tomorrow|this (?:week|month|year|morning|evening)|right now|recent(?:ly)?|up[- ]to[- ]date|as of|upcoming|just (?:announced|released|launched)|new(?:est)? version|still (?:open|available|alive|in office))\b/i;
const QUESTION = /\?|^\s*(who|what|when|where|which|how|is|are|did|does|has|have|will|can)\b/i;
const CODEY = /```|\b(function|const|let|var|def|class|import|return|SELECT|npm|git|directory|folder|variable|array|loop)\b|[{};]\s*$/m;

/** Year at or after which we assume the model may lack knowledge. */
export const KNOWLEDGE_YEAR = 2026;

/**
 * Should this message trigger a web search on its own (auto mode)?
 * Errs on the side of NOT searching: each search costs a credit.
 */
export function needsWebSearch(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 2000) return false;
  if (extractUrls(t).length) return true;
  if (EXPLICIT.test(t)) return true;
  const codey = CODEY.test(t);
  if (STRONG.test(t) && !codey) return true;
  const years = (t.match(/\b(20\d{2})\b/g) ?? []).map(Number);
  const futureYear = years.some((y) => y >= KNOWLEDGE_YEAR);
  if ((RECENCY.test(t) || futureYear) && QUESTION.test(t) && !codey) return true;
  return false;
}

export function classifyIntent(text: string): { intent: SearchIntent; kind: SearchKind } {
  const t = text.toLowerCase();
  if (/\b(news|headlines?|breaking|announced|today|yesterday|this week|election|scores?|live updates?)\b/.test(t))
    return { intent: 'news', kind: 'news' };
  if (/\b(research|in[- ]depth|compare|comparison|versus|vs\.?|analysis|studies|study|evidence|pros and cons|literature|report on)\b/.test(t))
    return { intent: 'research', kind: 'web' };
  if (/\b(documentation|docs|api reference|reference|specification|spec|manual|how to install|changelog|definition of)\b/.test(t))
    return { intent: 'reference', kind: 'web' };
  return { intent: 'general', kind: 'web' };
}

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
