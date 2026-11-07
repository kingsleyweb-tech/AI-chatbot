/**
 * Incremental Server-Sent Events parser shared by the server (reading the
 * provider stream) and the browser (reading our /api/chat stream).
 * Yields the payload of each `data:` event; comment lines are ignored.
 */
export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, '');
        const data = extractData(raw);
        if (data !== null) yield data;
      }
    }
    buffer += decoder.decode();
    const data = extractData(buffer);
    if (data !== null) yield data;
  } finally {
    reader.releaseLock();
  }
}

function extractData(raw: string): string | null {
  const lines = raw.split(/\r?\n/).filter((l) => l.startsWith('data:'));
  if (!lines.length) return null;
  return lines.map((l) => l.slice(5).replace(/^ /, '')).join('\n');
}
