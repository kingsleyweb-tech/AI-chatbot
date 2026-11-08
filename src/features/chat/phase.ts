import type { LiveReply } from './engine';

/**
 * Where a reply is in its lifecycle, for the generation indicator:
 * - thinking: request sent, no answer text yet (includes search, reasoning and model fallback,
 *   which emit `start` before any text)
 * - streaming: answer text is arriving
 * - saving: the model finished; the reply is being stored
 * - completed / failed / interrupted: final; the indicator is hidden
 */
export type ReplyPhase = 'thinking' | 'streaming' | 'saving' | 'completed' | 'failed' | 'interrupted';

export function replyPhase(r: Pick<LiveReply, 'status' | 'content' | 'settled'>): ReplyPhase {
  switch (r.status) {
    case 'connecting':
    case 'streaming':
      return r.content ? 'streaming' : 'thinking';
    case 'done':
      return r.settled ? 'completed' : 'saving';
    case 'stopped':
      return 'interrupted';
    case 'error':
      return 'failed';
  }
}
