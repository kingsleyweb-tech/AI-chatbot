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
  /** excerpts of earlier exchanges retrieved from past conversations */
  pastExchanges?: string;
  /** rolling summary of the earlier part of this conversation */
  historySummary?: string;
  /** structured brief of the project in focus */
  projectBrief?: { name: string; text: string } | null;
  documents?: string;
  failedDocuments?: string[];
  /** knowledge base excerpts ([K1] ...) */
  knowledge?: string;
  webResults?: string;
  webSearchFailed?: string | null;
  /** honest capability statements for this request */
  capabilityNotes?: string[];
  /** structure the answer as a research report */
  deepResearch?: boolean;
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
    `You are Atlas AI, a capable and trustworthy personal AI assistant.`,
    `Current date: ${now.toISOString().slice(0, 10)}.`,
    [
      'Be accurate, helpful and natural. Reason carefully through hard problems.',
      'Format responses in Markdown: headings for long answers, lists, tables where useful, fenced code blocks with a language tag.',
      'Write math with LaTeX using $...$ inline and $$...$$ for display.',
      'If you are unsure or do not know, say so plainly. Never invent facts, citations, links, or memories.',
      'For questions about a specific company, organization, person or product: use the knowledge base and web results below when present. ' +
        'If neither covers it, say clearly that you could not verify information about it, do not guess its history, services or activities, and suggest turning on web search or adding a source to the Knowledge Base. ' +
        'Never say you searched or looked something up unless web results or knowledge base excerpts are included below.',
      'Your knowledge has a cutoff; for recent events say you may be out of date unless web results are provided.',
    ].join(' '),
  ];
  if (ctx.capabilityNotes?.length) parts.push(ctx.capabilityNotes.join(' '));
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
  if (ctx.projectBrief?.text) {
    parts.push(
      `## Project memory: ${ctx.projectBrief.name}\nWhat you know about this project of the user's from earlier conversations. ` +
        `It may be outdated; the user's latest statements win. Only use it for this project.\n${ctx.projectBrief.text.slice(0, 4000)}`,
    );
  }
  if (ctx.relatedConversations?.length) {
    parts.push(
      `## Possibly related earlier conversations (summaries)\n` +
        ctx.relatedConversations.map((c) => `- "${c.title}": ${c.summary}`).join('\n'),
    );
  }
  if (ctx.pastExchanges) {
    parts.push(
      `## Relevant excerpts from earlier conversations\nRetrieved from the user's past chats for this message (chat title and date). ` +
        `Use them when the user refers to something discussed before; say which chat it came from when helpful. ` +
        `If they don't cover what the user asks about, say you can't find it in past conversations rather than guessing.\n\n${ctx.pastExchanges}`,
    );
  }
  if (ctx.historySummary) {
    parts.push(
      `## Earlier in this conversation (summary)\nThe oldest messages of this chat are summarized here; the recent ones follow in full.\n${ctx.historySummary.slice(0, 3500)}`,
    );
  }
  if (ctx.documents) {
    parts.push(
      `## Attached document excerpts\nAnswer questions about the documents using these excerpts. Cite them inline like [D1]. ` +
        `If the excerpts don't contain the answer, say so rather than guessing.\n\n${ctx.documents}`,
    );
  }
  if (ctx.knowledge) {
    parts.push(
      `## Knowledge base excerpts\nRetrieved from the user's knowledge base for this message (collection › source, location). ` +
        `Prefer them over your background knowledge for these subjects and cite them inline like [K1]. ` +
        `Keep what the sources state separate from your own inferences, and label inferences as such. ` +
        `An excerpt may be outdated; mention its indexed date when timing matters. If the excerpts don't answer the question, say so.\n\n${ctx.knowledge}`,
    );
  }
  if (ctx.failedDocuments?.length) {
    parts.push(
      `Note: these attached documents could not be read: ${ctx.failedDocuments.join('; ')}. Tell the user if they ask about them.`,
    );
  }
  if (ctx.webResults) {
    parts.push(
      `## Web search results\nThese were retrieved just now for this message. Use them for current information and cite them inline with their number, like [1]. ` +
        `Clearly distinguish what the sources say from your own background knowledge. ` +
        `Only cite numbers listed here; never invent sources, URLs, quotes or publication dates. Mention a date only if it is listed with the source. ` +
        `If the results don't answer the question, say so.\n\n${ctx.webResults}`,
    );
    if (ctx.deepResearch) {
      parts.push(
        `## Deep research report\nWrite a structured research report from the sources above: ` +
          `1) a short **Summary**; 2) **Key findings** with inline citations; 3) **Where sources disagree or are uncertain** (say "none found" if they agree); ` +
          `4) **Limitations** (what the sources did not cover); 5) **Sources** as a numbered list of the cited links. ` +
          `Base findings only on the sources; mark any inference as your interpretation.`,
      );
    }
  } else if (ctx.webSearchFailed) {
    parts.push(
      `Note: web search could not be used for this message (${ctx.webSearchFailed}). If the question needs current information, say briefly that you couldn't search the web, then answer from your own knowledge with that caveat.`,
    );
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
