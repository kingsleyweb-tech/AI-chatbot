// Live smoke test: one streamed completion through the real provider + fallback chain.
// Usage: npx tsx --env-file=.env.local dev/smoke.ts   (never prints the key)
import { getCatalog, fallbackChain, providerFor } from '../server/providers/registry.js';

const catalog = await getCatalog();
console.log(`catalog: ${catalog.models.length} models, paidAvailable=${catalog.paidAvailable}`);
const { chain, skipped } = fallbackChain(catalog.defaultModel, catalog.models, { needsVision: false, paidAvailable: catalog.paidAvailable });
console.log('chain:', chain.join(' -> '), skipped.length ? `(skipped ${skipped.map((s) => s.id).join(', ')})` : '');
for (const model of chain) {
  const started = Date.now();
  try {
    let text = '';
    let first = 0;
    let reasoning = '';
    for await (const c of providerFor(model).stream({ model, messages: [{ role: 'user', content: 'Reply with exactly: Tessera online.' }], maxTokens: 8192 })) {
      if (c.type === 'reasoning') reasoning += c.text;
      if (c.type === 'delta') { if (!first) first = Date.now() - started; text += c.text; }
      if (c.type === 'usage') console.log('usage:', c.usage);
      if (c.type === 'finish') console.log('finish:', c.reason, 'model:', c.model);
    }
    console.log(`OK ${model}: first token ${first}ms, total ${Date.now() - started}ms -> ${JSON.stringify(text.trim().slice(0, 120))} (reasoning chars: ${reasoning.length})`);
    break;
  } catch (err) {
    console.log(`FAIL ${model}:`, (err as { code?: string }).code, (err as Error).message);
  }
}
