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
