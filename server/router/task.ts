/**
 * Deterministic task detection for model routing: what does this request
 * need (images, long context, code) and what is the user trying to do.
 * No model call.
 */
import { estimateTokens } from '../docs/chunk.js';
import type { ChatTurn } from '../shared/types.js';

export type DocKind = 'pdf' | 'docx' | 'pptx' | 'sheet' | 'code' | 'text' | 'image' | 'other';
export type TaskIntent = 'chat' | 'code' | 'analysis' | 'summarize' | 'compare' | 'imageGen' | 'imageEdit';

export interface Task {
  needsVision: boolean;
  needsAudio: boolean;
  docKinds: DocKind[];
  intent: TaskIntent;
  /** rough minimum context the request needs, in tokens */
  estTokens: number;
}

const CODE_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|kts|swift|c|h|cc|cpp|hpp|cs|php|scala|sh|bash|ps1|sql|r|dart|lua|vue|svelte|html|css|scss|json|ya?ml|toml|xml|gradle|tf)$/i;

export function docKind(name: string, mime = ''): DocKind {
  const n = name.toLowerCase();
  if (n.endsWith('.pdf') || mime === 'application/pdf') return 'pdf';
  if (/\.docx?$/.test(n) || mime.includes('wordprocessingml') || mime === 'application/msword') return 'docx';
  if (/\.pptx?$/.test(n) || mime.includes('presentationml') || mime.includes('ms-powerpoint')) return 'pptx';
  if (/\.(xlsx|xlsm|xls|csv|tsv)$/.test(n) || mime.includes('spreadsheetml') || mime.includes('ms-excel') || mime === 'text/csv') return 'sheet';
  if (CODE_EXT.test(n)) return 'code';
  if (/\.(txt|md|markdown|rtf|log)$/.test(n) || mime.startsWith('text/')) return 'text';
  if (mime.startsWith('image/')) return 'image';
  return 'other';
}

const IMAGE_NOUN = '(image|picture|photo|illustration|logo|drawing|artwork|art|icon|wallpaper|poster|sticker|avatar|meme|portrait)';
const IMAGE_GEN = new RegExp(`\\b(generate|create|make|draw|design|render|paint|produce)\\b[^.?!]{0,40}\\b${IMAGE_NOUN}s?\\b`, 'i');
const IMAGE_EDIT =
  /\b(edit|remove|erase|replace|change|recolou?r|retouch|blur|crop|swap|add)\b[^.?!]{0,40}\b(background|object|person|people|sky|colou?rs?|this (image|photo|picture)|the (image|photo|picture))\b/i;
const CODE_CUE =
  /```|\b(code|function|method|class|bug|stack ?trace|exception|refactor|compile|typescript|javascript|python|java|rust|golang|sql|regex|api endpoint|unit test|debug)\b/i;
const ANALYSIS_CUE = /\b(calculate|compute|analy[sz]e|average|mean|median|sum|total|trend|growth|forecast|chart|graph|plot|statistics|correlat|percent(age)?)\b/i;

export function detectTask(turns: ChatTurn[], docs: { name: string; mime: string }[] = []): Task {
  const last = [...turns].reverse().find((t) => t.role === 'user');
  const text = last?.content ?? '';
  const recentUser = turns.slice(-3).filter((t) => t.role === 'user');
  const images = recentUser.flatMap((t) => t.attachments?.filter((a) => a.kind === 'image') ?? []);
  const needsVision = images.length > 0;
  const docKinds = [...new Set(docs.map((d) => docKind(d.name, d.mime)))];

  let intent: TaskIntent = 'chat';
  if (needsVision && IMAGE_EDIT.test(text)) intent = 'imageEdit';
  else if (IMAGE_GEN.test(text) && !/\b(describe|explain|what is in|analy[sz]e)\b/i.test(text)) intent = 'imageGen';
  else if (/\b(compare|comparison|differences? between|versus|vs\.?)\b/i.test(text) && docs.length > 1) intent = 'compare';
  else if (/\b(summari[sz]e|summary|tl;?dr|overview|key points)\b/i.test(text) && docs.length) intent = 'summarize';
  else if (docKinds.includes('sheet') && ANALYSIS_CUE.test(text)) intent = 'analysis';
  else if (docKinds.includes('code') || CODE_CUE.test(text)) intent = 'code';
  else if (ANALYSIS_CUE.test(text) && docs.length) intent = 'analysis';

  // The single newest message has to fit; older history is trimmed or summarized.
  const estTokens = estimateTokens(text) + images.length * 800 + 3000;
  return { needsVision, needsAudio: false, docKinds, intent, estTokens };
}
