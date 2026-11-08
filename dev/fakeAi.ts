import type { ChatProvider, CompletionParams, ProviderChunk, ProviderMessage } from '../server/providers/types.js';

/**
 * Scripted AI for local end-to-end tests (dev server only, `E2E_FAKE_AI=1` together with the
 * Firebase emulators). Replies are deterministic and streamed in small pieces, so persistence,
 * streaming and interruption can be tested without spending any provider quota. Never deployed.
 */
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('aborted', 'AbortError'));
    });
  });

const text = (m: ProviderMessage) => (typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join(' '));

/** The scripted answer to the latest user message, as pieces to stream. */
export function scriptedReply(messages: ProviderMessage[]): { pieces: string[]; delayMs: number } {
  const last = text([...messages].reverse().find((m) => m.role === 'user') ?? { role: 'user', content: '' });
  let m = /reply with only the number (\d+)/i.exec(last);
  if (m) return { pieces: [m[1]], delayMs: 50 };
  m = /reply with only the word (\w+)/i.exec(last);
  if (m) return { pieces: [m[1]], delayMs: 50 };
  m = /(?:list|write) (\d+) numbered/i.exec(last);
  if (m) {
    const n = Number(m[1]);
    const tail = /then the word (\w+)/i.exec(last)?.[1];
    const lines = Array.from({ length: n }, (_, i) => `${i + 1}. Scripted line number ${i + 1}.\n`);
    return { pieces: tail ? [...lines, `\n${tail}`] : lines, delayMs: 120 };
  }
  m = /then the word (\w+)/i.exec(last);
  if (m) return { pieces: ['The sea is wide. ', 'It is also deep. ', m[1]], delayMs: 300 };
  return { pieces: ['Scripted reply.'], delayMs: 50 };
}

export function fakeProvider(id: string): Pick<ChatProvider, 'stream' | 'complete' | 'embed'> {
  return {
    embed: undefined, // no embeddings: memory and related-chat lookups are skipped
    async *stream(p: CompletionParams): AsyncGenerator<ProviderChunk> {
      const { pieces, delayMs } = scriptedReply(p.messages);
      await sleep(200, p.signal);
      for (const piece of pieces) {
        yield { type: 'delta', text: piece };
        await sleep(delayMs, p.signal);
      }
      yield { type: 'finish', reason: 'stop', model: p.model };
    },
    async complete(p: CompletionParams): Promise<string> {
      return p.json ? '{}' : `Scripted ${id} title`;
    },
  };
}
