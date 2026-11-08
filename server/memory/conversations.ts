import { embed, rank } from '../embeddings.js';
import { Firestore, SERVER_TIME } from '../firestore.js';
import type { ChatTurn } from '../shared/types.js';
import { stripThinking, utilityComplete } from '../utility.js';

interface ConvVector {
  embedding: number[];
  model: string;
  summary: string;
  title: string;
  updatedAt?: string;
}

export interface RelatedConversation {
  id: string;
  title: string;
  summary: string;
}

export async function generateTitle(userText: string, assistantText: string): Promise<string | null> {
  const out = await utilityComplete(
    [
      {
        role: 'system',
        content:
          'Write a short, specific title (max 6 words) for this conversation. No quotes, no trailing punctuation, no emojis. Reply with the title only.',
      },
      { role: 'user', content: `User: ${userText.slice(0, 1500)}\nAssistant: ${assistantText.slice(0, 800)}` },
    ],
    { maxTokens: 400 },
  );
  if (!out) return null;
  const title = stripThinking(out).split('\n').filter(Boolean).pop() ?? '';
  return title.replace(/^["'#*\s]+|["'.*\s]+$/g, '').slice(0, 80) || null;
}

/**
 * Keep a rolling summary + embedding per conversation so later
 * conversations can recall relevant earlier ones without loading them.
 */
export async function updateConversationSummary(args: {
  db: Firestore;
  uid: string;
  conversationId: string;
  title: string;
  messages: ChatTurn[];
}): Promise<void> {
  const transcript = args.messages
    .slice(-16)
    .map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 1200)}`)
    .join('\n');
  const out = await utilityComplete(
    [
      {
        role: 'system',
        content:
          'Summarize this conversation in 2-3 sentences for future reference: the topic, key facts, and any decisions or conclusions. Plain text only.',
      },
      { role: 'user', content: transcript },
    ],
    { maxTokens: 500 },
  );
  if (!out) return;
  const summary = stripThinking(out).slice(0, 800);
  const e = await embed([`${args.title}\n${summary}`]);
  const base = `users/${args.uid}`;
  await args.db.commit([
    {
      op: 'set',
      path: `${base}/conversations/${args.conversationId}`,
      data: { summary, summaryAt: SERVER_TIME },
      merge: true,
    },
    ...(e
      ? [
          {
            op: 'set' as const,
            path: `${base}/convVectors/${args.conversationId}`,
            data: { embedding: e.vectors[0], model: e.model, summary, title: args.title, updatedAt: SERVER_TIME },
          },
        ]
      : []),
  ]);
}

export async function relatedConversations(args: {
  db: Firestore;
  uid: string;
  excludeId: string;
  query: { text: string; vector?: number[] | null; model?: string | null };
  limit?: number;
}): Promise<RelatedConversation[]> {
  const docs = await args.db.list<ConvVector>(`users/${args.uid}/convVectors`, { limit: 300 });
  const ranked = rank(
    docs.filter((d) => d.id !== args.excludeId),
    args.query,
    (d) => ({ text: `${d.data.title} ${d.data.summary}`, vector: d.data.embedding, model: d.data.model }),
  );
  return ranked
    .filter((r) => r.score > 0.45)
    .slice(0, args.limit ?? 3)
    .map((r) => ({ id: r.item.id, title: r.item.data.title, summary: r.item.data.summary }));
}

/** Turns kept verbatim at the end of a conversation; older ones are summarized. */
export const VERBATIM_TURNS = 16;
/** Fold older turns into the summary once at least this many are unsummarized. */
const FOLD_MIN = 6;

export interface HistorySummaryState {
  historySummary?: string;
  /** number of turns (from the start) the summary covers */
  historySummaryCount?: number;
}

/**
 * Hierarchical (rolling) summary of a long conversation: the previous
 * summary plus the next block of older turns are folded into a new summary,
 * so the summary always covers everything before the last VERBATIM_TURNS
 * turns without ever re-reading the whole chat. Kept on the conversation doc.
 */
export async function updateHistorySummary(args: {
  db: Firestore;
  uid: string;
  conversationId: string;
  state: HistorySummaryState;
  /** total turns in the conversation after this exchange */
  total: number;
  complete?: typeof utilityComplete;
}): Promise<boolean> {
  const covered = args.state.historySummaryCount ?? 0;
  const upTo = args.total - VERBATIM_TURNS;
  if (upTo - covered < FOLD_MIN) return false;
  const convPath = `users/${args.uid}/conversations/${args.conversationId}`;
  const msgs = await args.db.list<{ role?: string; content?: string; status?: string }>(`${convPath}/messages`, {
    orderBy: 'createdAt',
    limit: Math.min(upTo, 600),
  });
  const block = msgs
    .slice(covered, upTo)
    .filter((m) => (m.data.role === 'user' || m.data.role === 'assistant') && m.data.content)
    .map((m) => `${m.data.role === 'user' ? 'USER' : 'ASSISTANT'}: ${m.data.content!.slice(0, 1500)}`);
  if (!block.length) return false;
  const out = await (args.complete ?? utilityComplete)(
    [
      {
        role: 'system',
        content:
          'You keep a running summary of the earlier part of a long conversation so an assistant can continue it. ' +
          'Merge the PREVIOUS SUMMARY with the NEW TURNS into one updated summary (max 250 words). ' +
          'Preserve: the user\'s instructions and preferences for this chat, facts they shared, decisions made, code or design choices, open questions and pending tasks. ' +
          'Drop small talk. Never include secrets (passwords, keys). Plain text, short paragraphs or bullet points.',
      },
      { role: 'user', content: `PREVIOUS SUMMARY:\n${args.state.historySummary || '(none)'}\n\nNEW TURNS:\n${block.join('\n').slice(0, 24_000)}` },
    ],
    { maxTokens: 700 },
  );
  if (!out) return false;
  await args.db.set(
    convPath,
    { historySummary: stripThinking(out).slice(0, 3000), historySummaryCount: upTo, historySummaryAt: SERVER_TIME },
    true,
  );
  return true;
}
