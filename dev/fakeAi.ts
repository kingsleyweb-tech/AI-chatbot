import { deflateSync } from 'node:zlib';
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
export function scriptedReply(messages: ProviderMessage[]): { pieces: string[]; delayMs: number; reasoning?: string[] } {
  const last = text([...messages].reverse().find((m) => m.role === 'user') ?? { role: 'user', content: '' });
  // a reasoning model: thinks (reasoning chunks, no answer text) before answering
  if (/step by step/i.test(last)) {
    return {
      reasoning: ['Let me work through this. ', 'First, the facts. ', 'Then the conclusion. ', 'Checking the result. '],
      pieces: ['Step 1: gather the facts.\n', 'Step 2: compare them.\n', 'Step 3: conclude.\n', '\nAnswer: REASONED'],
      delayMs: 400,
    };
  }
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
      const { pieces, delayMs, reasoning = [] } = scriptedReply(p.messages);
      await sleep(200, p.signal);
      for (const piece of reasoning) {
        yield { type: 'reasoning', text: piece };
        await sleep(delayMs, p.signal);
      }
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

/* ------------------------- Cloudflare Workers AI (images) ------------------------- */


const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A real PNG of the requested size (diagonal colour bands derived from the prompt). */
export function fakePng(width: number, height: number, seed: string): Uint8Array {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const base = [h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff];
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      const band = Math.floor((x + y) / 64) % 2 ? 40 : 0;
      row[1 + x * 3] = (base[0] + band) & 0xff;
      row[2 + x * 3] = (base[1] + band) & 0xff;
      row[3 + x * 3] = (base[2] + band) & 0xff;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return new Uint8Array(
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(Buffer.concat(rows))), pngChunk('IEND', Buffer.alloc(0))]),
  );
}

/**
 * Scripted image model and safety classifier. Prompts containing FAILIMAGE fail,
 * UNSAFEGUARD is classified unsafe; every image takes about 1.5 s.
 */
export const fakeCloudflare = {
  async image(model: string, body: { json?: Record<string, unknown>; form?: FormData }, signal?: AbortSignal) {
    const prompt = String(body.json?.prompt ?? body.form?.get('prompt') ?? '');
    const width = Number(body.form?.get('width') ?? 1024) || 1024;
    const height = Number(body.form?.get('height') ?? 1024) || 1024;
    await sleep(1500, signal);
    if (/FAILIMAGE/.test(prompt)) {
      const { ProviderError } = await import('../server/providers/types.js');
      throw new ProviderError('provider_error', 'Cloudflare Workers AI had a temporary problem.', 502);
    }
    // smaller than requested keeps the test fast; the shape (aspect ratio) is kept
    const scale = 256 / Math.max(width, height);
    const bytes = fakePng(Math.round(width * scale), Math.round(height * scale), `${model}|${prompt}|${body.form?.has('input_image_0') ? 'edit' : ''}`);
    return { bytes, mime: 'image/png', neurons: 104.2 };
  },
  async chat(_model: string, messages: { role: string; content: string }[]) {
    const text = messages.map((m) => m.content).join(' ');
    return { text: /UNSAFEGUARD/.test(text) ? 'unsafe\nS1' : 'safe', neurons: 9.1 };
  },
};

/** A short silent MP3 frame (MPEG-1 Layer III header), enough for the browser to play "something". */
function fakeMp3(): Uint8Array {
  const frame = new Uint8Array(417);
  frame.set([0xff, 0xfb, 0x90, 0x64]);
  return frame;
}

/**
 * Scripted speech models: every recording transcribes to a fixed sentence (recordings
 * under 1 kB fail), the natural voice returns a silent MP3, and translation wraps
 * the text in [target] markers so tests can see what was translated.
 */
export const fakeSpeech = {
  async transcribe(audio: Uint8Array) {
    await sleep(300);
    if (audio.byteLength < 1000) {
      const { ProviderError } = await import('../server/providers/types.js');
      throw new ProviderError('provider_error', 'Cloudflare Workers AI had a temporary problem.', 502);
    }
    return { text: 'Hello Atlas, what is the capital of France?', language: 'en', duration: 3.2, neurons: 2.5 };
  },
  async speak(text: string) {
    await sleep(200);
    return { bytes: fakeMp3(), neurons: Math.round(text.length * 1.3637 * 100) / 100 };
  },
  async translate(text: string, _source: string, target: string) {
    return { text: `[${target}] ${text}`, neurons: 1.2 };
  },
  async turn(pcm: Float32Array) {
    await sleep(100);
    return { complete: pcm.length >= 16_000, probability: pcm.length >= 16_000 ? 0.9 : 0.1, neurons: 0 };
  },
};
