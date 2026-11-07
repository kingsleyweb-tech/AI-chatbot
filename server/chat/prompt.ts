import type { ChatTurn } from '../shared/types.js';
import { estimateTokens } from '../docs/chunk.js';
import type { ContentPart, ProviderMessage } from '../providers/types.js';

export interface UserSettings {
  displayName?: string;
  customInstructions?: string;
  aboutMe?: string;
  responseStyle?: 'balanced' | 'concise' | 'detailed';
  tone?: 'professional' | 'casual' | 'friendly';
  technicalLevel?: 'beginner' | 'intermediate' | 'expert';
  language?: string;
  memoryEnabled?: boolean;
}

export interface PromptContext {
  settings: UserSettings;
  projectName?: string | null;
  projectInstructions?: string | null;
  memories?: string;
  relatedConversations?: { title: string; summary: string }[];
  documents?: string;
  failedDocuments?: string[];
  webResults?: string;
  webSearchFailed?: string | null;
  now?: Date;
}

const STYLE: Record<string, string> = {
  concise: 'Keep answers brief and to the point unless the user asks for depth.',
  detailed: 'Give thorough, well-structured answers with relevant detail and examples.',
  balanced: 'Match answer length to the question: short for simple questions, structured depth for complex ones.',
};
const TONE: Record<string, string> = {
  professional: 'Use a professional, polished tone.',
  casual: 'Use a relaxed, conversational tone.',
  friendly: 'Use a warm, friendly tone.',
};
const LEVEL: Record<string, string> = {
  beginner: 'Explain technical concepts simply and avoid unexplained jargon.',
  intermediate: 'Assume moderate technical familiarity.',
  expert: 'Assume expert knowledge; skip basics and be precise.',
};

export function buildSystemPrompt(ctx: PromptContext): string {
  const s = ctx.settings;
  const now = ctx.now ?? new Date();
  const parts: string[] = [
    `You are Tessera, a capable and trustworthy personal AI assistant.`,
    `Current date: ${now.toISOString().slice(0, 10)}.`,
    [
      'Be accurate, helpful and natural. Reason carefully through hard problems.',
      'Format responses in Markdown: headings for long answers, lists, tables where useful, fenced code blocks with a language tag.',
      'Write math with LaTeX using $...$ inline and $$...$$ for display.',
      'If you are unsure or do not know, say so plainly. Never invent facts, citations, links, or memories.',
      'Your knowledge has a cutoff; for recent events say you may be out of date unless web results are provided.',
    ].join(' '),
  ];
  const prefs = [
    STYLE[s.responseStyle ?? 'balanced'],
    s.tone ? TONE[s.tone] : '',
    s.technicalLevel ? LEVEL[s.technicalLevel] : '',
    s.language && s.language !== 'auto' ? `Respond in ${s.language} unless asked otherwise.` : '',
  ].filter(Boolean);
  parts.push(prefs.join(' '));
  if (s.displayName) parts.push(`The user's name is ${s.displayName}.`);
  if (s.aboutMe?.trim()) parts.push(`## About the user (provided by them)\n${s.aboutMe.trim().slice(0, 3000)}`);
  if (s.customInstructions?.trim()) {
    parts.push(`## The user's custom instructions\n${s.customInstructions.trim().slice(0, 4000)}`);
  }
  if (ctx.projectInstructions?.trim()) {
    parts.push(
      `## Project: ${ctx.projectName ?? 'Untitled'}\nInstructions for conversations in this project:\n${ctx.projectInstructions.trim().slice(0, 4000)}`,
    );
  }
  if (ctx.memories) {
    parts.push(
      `## Long-term memory\nNotes saved from earlier conversations with this user. They may be incomplete or outdated. ` +
        `Use them only when relevant, and don't recite them unprompted. If the user asks what you remember and it isn't here, say you don't have it in memory. ` +
        `If the user corrects one, follow the correction.\n${ctx.memories}`,
    );
  }
  if (ctx.relatedConversations?.length) {
    parts.push(
      `## Possibly related earlier conversations (summaries)\n` +
        ctx.relatedConversations.map((c) => `- "${c.title}": ${c.summary}`).join('\n'),
    );
  }
  if (ctx.documents) {
    parts.push(
      `## Attached document excerpts\nAnswer questions about the documents using these excerpts. Cite them inline like [D1]. ` +
        `If the excerpts don't contain the answer, say so rather than guessing.\n\n${ctx.documents}`,
    );
  }
  if (ctx.failedDocuments?.length) {
    parts.push(
      `Note: these attached documents could not be read: ${ctx.failedDocuments.join('; ')}. Tell the user if they ask about them.`,
    );
  }
  if (ctx.webResults) {
    parts.push(
      `## Web search results\nUse these for current information. Cite sources inline with their number, like [1]. ` +
        `Clearly distinguish information from these sources from your own background knowledge. ` +
        `If the results don't answer the question, say so. Only cite the numbers listed here.\n\n${ctx.webResults}`,
    );
  } else if (ctx.webSearchFailed) {
    parts.push(`Note: a web search was requested but failed (${ctx.webSearchFailed}). Tell the user you couldn't search, and answer from your own knowledge with that caveat.`);
  }
  return parts.join('\n\n');
}

/** Convert turns to provider messages, keeping images only on recent user turns. */
export function toProviderMessages(
  system: string,
  turns: ChatTurn[],
  opts: { vision: boolean; budgetTokens: number },
): { messages: ProviderMessage[]; droppedTurns: number } {
  const systemTokens = estimateTokens(system);
  let remaining = Math.max(opts.budgetTokens - systemTokens, 2000);
  const kept: ChatTurn[] = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    const cost = estimateTokens(t.content) + (t.attachments?.length ?? 0) * 800 + 8;
    if (kept.length > 0 && cost > remaining) break;
    kept.unshift(t);
    remaining -= cost;
  }
  const lastUserIdx = kept.map((t) => t.role).lastIndexOf('user');
  const messages: ProviderMessage[] = [{ role: 'system', content: system }];
  kept.forEach((t, idx) => {
    const images =
      opts.vision && t.role === 'user' && idx >= lastUserIdx - 2
        ? (t.attachments ?? []).filter((a) => a.kind === 'image')
        : [];
    if (images.length) {
      const parts: ContentPart[] = [{ type: 'text', text: t.content || 'Describe this image.' }];
      for (const img of images) if (img.kind === 'image') parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
      messages.push({ role: t.role, content: parts });
    } else {
      const note =
        t.attachments?.some((a) => a.kind === 'image') && !opts.vision
          ? '\n\n[An image was attached, but the current model cannot view images.]'
          : '';
      messages.push({ role: t.role, content: (t.content || '') + note });
    }
  });
  return { messages, droppedTurns: turns.length - kept.length };
}
