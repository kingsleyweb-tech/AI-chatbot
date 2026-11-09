/**
 * Live check of every Cloudflare Workers AI model Atlas AI uses (free daily allowance only).
 *
 *   npx tsx --env-file=.env.local dev/smoke-cloudflare.ts [--only=translate,stt,tts,chat,image]
 *
 * About 1,000 Neurons in total (of the free 10,000 per day). Prints each call's exact cost from
 * the cf-ai-neurons header. Never prints credentials. Stops at once if the free allowance is used up.
 */
import { chatOnce, runImageModel, cloudflareConfigured, aiBase, authHeader, neuronsOf } from '../server/cloudflare/client.js';
import { speak, transcribe, translateText } from '../server/cloudflare/speech.js';
import { BACKUP_IMAGE_MODEL, IMAGE_MODELS, SAFETY_MODEL } from '../server/config/images.js';
import { TRANSLATE_LANGUAGES } from '../server/config/speech.js';

const only = (process.argv.find((a) => a.startsWith('--only='))?.slice(7) ?? 'translate,stt,tts,chat,image').split(',');
let total = 0;
const results: { what: string; ok: boolean; note: string; neurons: number }[] = [];
const log = (what: string, ok: boolean, note: string, neurons = 0) => {
  total += neurons;
  results.push({ what, ok, note, neurons });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what.padEnd(34)} ${neurons.toFixed(2).padStart(7)} N  ${note}`);
};
const fail = (err: unknown) => {
  const e = err as { code?: string; message?: string };
  if (e.code === 'daily_limit') {
    console.log('Free daily allowance used up: stopping (nothing paid is ever used).');
    process.exit(2);
  }
  return `${e.code ?? 'error'}: ${String(e.message ?? err).slice(0, 140)}`;
};

if (!cloudflareConfigured()) {
  console.log('CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN are not set.');
  process.exit(1);
}

/* ------------------------------ translation ------------------------------ */
// Each offered language: English -> language -> English. A language passes when the translation
// is non-empty, differs from the English, uses the expected script, and the round trip keeps the meaning.
const SENTENCE = 'The water is cold this morning, and the children are going to school.';
const KEYWORDS = [/water/i, /(morning|today)/i, /(child|kid)/i, /school/i];
const SCRIPT: Record<string, RegExp> = {
  arabic: /[؀-ۿ]/,
  chinese: /[一-鿿]/,
  japanese: /[぀-ヿ一-鿿]/,
  korean: /[가-힯]/,
  hindi: /[ऀ-ॿ]/,
  russian: /[Ѐ-ӿ]/,
};
if (only.includes('translate')) {
  for (const { code } of TRANSLATE_LANGUAGES) {
    if (code === 'english') continue;
    try {
      const there = await translateText(SENTENCE, 'english', code);
      const back = await translateText(there.text, code, 'english');
      const kept = KEYWORDS.filter((k) => k.test(back.text)).length;
      const scriptOk = SCRIPT[code] ? SCRIPT[code].test(there.text) : /\p{L}/u.test(there.text);
      const ok = Boolean(there.text.trim()) && there.text.trim() !== SENTENCE && scriptOk && kept >= 3;
      log(`translate english<->${code}`, ok, `"${there.text.slice(0, 50)}" | back: "${back.text.slice(0, 60)}" (${kept}/4)`, there.neurons + back.neurons);
    } catch (err) {
      log(`translate english<->${code}`, false, fail(err));
    }
  }
}

/* ------------------------------ voice ------------------------------ */
let englishAudio: Uint8Array | null = null;
if (only.includes('tts') || only.includes('stt')) {
  try {
    const out = await speak('Hello Atlas, what is the capital of France?');
    englishAudio = out.bytes;
    log('tts aura-1 (natural voice)', out.bytes.length > 1000, `${out.bytes.length} bytes of MP3`, out.neurons);
  } catch (err) {
    log('tts aura-1 (natural voice)', false, fail(err));
  }
}

/** MeloTTS (cheap, removed by Cloudflare on 2026-11-20) only to make non-English test speech. */
async function melo(text: string, lang: string): Promise<{ bytes: Uint8Array; neurons: number } | null> {
  const res = await fetch(`${aiBase()}/run/@cf/myshell-ai/melotts`, {
    method: 'POST',
    headers: { ...authHeader(), 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: text, lang }),
  });
  const neurons = neuronsOf(res);
  if (!res.ok) return null;
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('json')) {
    const j = (await res.json()) as { result?: { audio?: string }; audio?: string };
    const b64 = j.result?.audio ?? j.audio;
    return b64 ? { bytes: Uint8Array.from(Buffer.from(b64, 'base64')), neurons } : null;
  }
  return { bytes: new Uint8Array(await res.arrayBuffer()), neurons };
}

if (only.includes('stt')) {
  if (englishAudio) {
    try {
      const t = await transcribe(englishAudio);
      log('stt whisper (english)', /capital/i.test(t.text) && /france/i.test(t.text), `"${t.text}" lang=${t.language} ${t.duration}s`, t.neurons);
    } catch (err) {
      log('stt whisper (english)', false, fail(err));
    }
  }
  for (const [lang, text, expect] of [
    ['fr', 'Bonjour, quelle est la capitale de la France ?', /capitale/i],
    ['es', 'Hola, ¿cuál es la capital de España?', /capital/i],
  ] as const) {
    try {
      const audio = await melo(text, lang);
      if (!audio) {
        log(`stt whisper (${lang})`, false, 'could not make test speech (MeloTTS unavailable)');
        continue;
      }
      total += audio.neurons;
      const t = await transcribe(audio.bytes);
      log(`stt whisper (${lang})`, expect.test(t.text) && t.language === lang, `"${t.text}" lang=${t.language}`, t.neurons);
    } catch (err) {
      log(`stt whisper (${lang})`, false, fail(err));
    }
  }
}

/* ------------------------------ chat + safety ------------------------------ */
if (only.includes('chat')) {
  const CHAT = ['@cf/google/gemma-4-26b-a4b-it', '@cf/meta/llama-4-scout-17b-16e-instruct', '@cf/mistralai/mistral-small-3.1-24b-instruct', '@cf/openai/gpt-oss-120b', '@cf/qwen/qwen2.5-coder-32b-instruct'];
  for (const model of CHAT) {
    try {
      const r = await chatOnce(model, [{ role: 'user', content: 'Reply with exactly one word: the capital of France.' }], { maxTokens: 300 });
      log(`chat ${model.split('/').pop()}`, /paris/i.test(r.text), `"${r.text.trim().slice(0, 40)}"`, r.neurons);
    } catch (err) {
      log(`chat ${model.split('/').pop()}`, false, fail(err));
    }
  }
  try {
    const r = await chatOnce(SAFETY_MODEL, [{ role: 'user', content: 'Create an image of a sleek modern electric sedan in a studio.' }], { maxTokens: 20 });
    log('safety llama-guard-3-8b', /^\s*safe/i.test(r.text), `"${r.text.trim()}"`, r.neurons);
  } catch (err) {
    log('safety llama-guard-3-8b', false, fail(err));
  }
}

/* ------------------------------ images ------------------------------ */
if (only.includes('image')) {
  for (const m of IMAGE_MODELS) {
    try {
      let body: { json?: Record<string, unknown>; form?: FormData };
      if (m.request === 'json') body = { json: { prompt: 'a red bicycle leaning on a white wall, photo', steps: 4 } };
      else {
        const form = new FormData();
        form.append('prompt', 'a red bicycle leaning on a white wall, photo');
        form.append('width', '512');
        form.append('height', '512');
        body = { form };
      }
      const r = await runImageModel(m.id, body);
      log(`image ${m.id.split('/').pop()}${m.id === BACKUP_IMAGE_MODEL ? ' (backup)' : ''}`, r.bytes.length > 1000, `${r.mime} ${r.bytes.length} bytes`, r.neurons);
    } catch (err) {
      log(`image ${m.id.split('/').pop()}`, false, fail(err));
    }
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed, ${total.toFixed(1)} Neurons used (free allowance: 10,000/day).`);
if (failed.length) console.log('Failed:', failed.map((f) => f.what).join(', '));
