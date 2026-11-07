/**
 * Live check of the Gemini provider alongside OpenRouter (free tier only).
 *
 *   npx tsx --env-file=.env.local dev/smoke-gemini.ts
 *
 * Never prints API keys.
 */
import { deflateSync } from 'node:zlib';
import { embed } from '../server/embeddings.js';
import { getCatalog, providerFor } from '../server/providers/registry.js';
import { routeModel } from '../server/router/route.js';
import { detectTask } from '../server/router/task.js';
import { utilityComplete } from '../server/utility.js';

/** Build a small solid-colour PNG (no image files needed). */
function png(w: number, h: number, rgb: [number, number, number]): string {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).map((_, i) => rgb[i % 3])]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const file = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${file.toString('base64')}`;
}

async function run(model: string, content: Parameters<ReturnType<typeof providerFor>['complete']>[0]['messages'][0]['content']) {
  let text = '';
  let reasoning = 0;
  let usage = '';
  for await (const c of providerFor(model).stream({ model, messages: [{ role: 'user', content }], maxTokens: 400 })) {
    if (c.type === 'delta') text += c.text;
    if (c.type === 'reasoning') reasoning += c.text.length;
    if (c.type === 'usage') usage = `${c.usage.totalTokens} tokens, cost ${c.usage.cost ?? 'n/a'}`;
  }
  return `${text.trim().slice(0, 160)}  [reasoning chars: ${reasoning}; ${usage}]`;
}

const catalog = await getCatalog();
const gem = catalog.models.filter((m) => m.provider === 'gemini');
console.log(`catalog: ${catalog.models.length} models; gemini: ${gem.map((m) => m.id).join(', ')}`);
const orFree = catalog.models.filter((m) => m.provider === 'openrouter' && m.free);
console.log(`openrouter free models available now: ${orFree.filter((m) => m.available).length}/${orFree.length}`);

console.log('text  (gemini-3.5-flash):', await run('gemini:gemini-3.5-flash', 'In one sentence, what is retrieval-augmented generation?'));
console.log(
  'image (gemini-3.5-flash):',
  await run('gemini:gemini-3.5-flash', [
    { type: 'text', text: 'What single colour fills this image? Answer with one word.' },
    { type: 'image_url', image_url: { url: png(32, 32, [220, 20, 20]) } },
  ]),
);

const task = detectTask([{ role: 'user', content: 'What colour is this?', attachments: [{ kind: 'image', dataUrl: png(8, 8, [0, 0, 255]), name: 'b.png', mime: 'image/png' }] }]);
const route = routeModel('nvidia/nemotron-3-ultra-550b-a55b:free', task, catalog.models, { paidAvailable: catalog.paidAvailable });
console.log('router (image, text model selected):', JSON.stringify(route.kind === 'ok' ? { chain: route.chain, switched: route.switched } : route));

console.log('utility (title-style call):', await utilityComplete([{ role: 'user', content: 'Give a 3-word title for: planning a trip to Accra' }], { maxTokens: 50 }));
const e = await embed(['knowledge base', 'vector search']);
console.log(`embeddings: model ${e?.model}, ${e?.vectors.length} vectors x ${e?.vectors[0]?.length} dims`);
