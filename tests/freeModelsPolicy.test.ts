import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  allowedBy,
  assertCompletionAllowed,
  assertEmbeddingAllowed,
  FREE_LIMIT_MESSAGE,
  isFreeModelId,
  normalizeBilling,
  saveBilling,
  setBillingForTests,
} from '../server/billing/policy.js';
import { modelConfig, FEATURED_MODELS, TASK_PREFERENCES } from '../server/config/models.js';
import { mapGeminiModel } from '../server/providers/gemini.js';
import { fallbackChain, providerFor } from '../server/providers/registry.js';
import { ProviderError } from '../server/providers/types.js';
import { routeModel } from '../server/router/route.js';
import { detectTask } from '../server/router/task.js';
import { fakeModel } from './helpers.js';

const FREE_OR = 'nvidia/nemotron-3-ultra-550b-a55b:free';
const PAID_OR = 'google/gemini-3.8-flash';
const user = (content: string) => ({ role: 'user' as const, content });

beforeEach(() => setBillingForTests({ approvedModels: null }));
afterEach(() => {
  setBillingForTests(null);
  delete process.env.GEMINI_BILLING;
});

describe('Free Models Only: what counts as free', () => {
  it('OpenRouter: only ":free" variants; routers, paid variants and paid embeddings are refused', () => {
    expect(isFreeModelId(FREE_OR)).toBe(true);
    expect(isFreeModelId(PAID_OR)).toBe(false);
    expect(isFreeModelId('openrouter/auto')).toBe(false);
    expect(isFreeModelId('openai/text-embedding-3-small')).toBe(false);
    expect(isFreeModelId('free')).toBe(false);
  });

  it('Gemini: only Free Tier models, and none at all when billing is declared paid', () => {
    expect(isFreeModelId('gemini:gemini-3.8-flash')).toBe(true);
    expect(isFreeModelId('gemini:gemini-3.5-flash-lite')).toBe(true);
    expect(isFreeModelId('gemini:gemini-3.5-flash')).toBe(false);
    expect(isFreeModelId('gemini:gemini-3.1-pro-preview')).toBe(false);
    process.env.GEMINI_BILLING = 'paid';
    expect(isFreeModelId('gemini:gemini-3.8-flash')).toBe(false);
  });

  it('Gemini catalog entries are marked free only when on the Free Tier', () => {
    const map = (name: string) => mapGeminiModel({ name: `models/${name}`, supportedGenerationMethods: ['generateContent'] });
    expect(map('gemini-3.8-flash')?.free).toBe(true);
    expect(map('gemini-3.1-pro-preview')?.free).toBe(false);
    expect(map('gemini-3.5-flash')?.free).toBe(false);
  });

  it('Cloudflare: curated models only', () => {
    expect(isFreeModelId('@cf/google/gemma-4-26b-a4b-it')).toBe(true);
    expect(isFreeModelId('@cf/some/unknown-model')).toBe(false);
  });

  it('the built-in configuration lists free models only', () => {
    const cfg = modelConfig();
    const ids = [
      cfg.defaultModel,
      ...cfg.fallbackModels,
      ...cfg.utilityModels,
      ...cfg.embeddingModels,
      ...FEATURED_MODELS.map((m) => m.id),
      ...Object.values(TASK_PREFERENCES).flat(),
    ];
    for (const id of ids) expect(isFreeModelId(id), id).toBe(true);
  });
});

describe('Free Models Only: enforcement before any request leaves the server', () => {
  it('refuses a paid completion, stream and embedding without calling the provider', async () => {
    await expect(assertCompletionAllowed(PAID_OR)).rejects.toMatchObject({ code: 'paid_blocked' });
    await expect(providerFor(PAID_OR).complete({ model: PAID_OR, messages: [] })).rejects.toMatchObject({ code: 'paid_blocked' });
    const stream = providerFor('gemini:gemini-3.1-pro-preview').stream({ model: 'gemini:gemini-3.1-pro-preview', messages: [] });
    await expect(stream.next()).rejects.toMatchObject({ code: 'paid_blocked' });
    expect(() => assertEmbeddingAllowed('openai/text-embedding-3-small')).toThrow(ProviderError);
    await expect(providerFor('openai/text-embedding-3-small').embed!('openai/text-embedding-3-small', ['x'])).rejects.toMatchObject({
      code: 'paid_blocked',
    });
  });

  it('background jobs never run on Cloudflare (no Neuron reservation there)', async () => {
    const id = '@cf/google/gemma-4-26b-a4b-it';
    await expect(providerFor(id).complete({ model: id, messages: [] })).rejects.toMatchObject({ code: 'paid_blocked' });
  });

  it('the administrator list can only narrow the free models', async () => {
    const s = { approvedModels: [FREE_OR] };
    expect(allowedBy(s, FREE_OR)).toBe(true);
    expect(allowedBy(s, 'gemini:gemini-3.8-flash')).toBe(false);
    expect(allowedBy({ approvedModels: [PAID_OR] }, PAID_OR)).toBe(false);
    expect(normalizeBilling({ approvedModels: [PAID_OR, FREE_OR] }).approvedModels).toEqual([FREE_OR]);
    await expect(saveBilling([PAID_OR], 'admin')).rejects.toMatchObject({ code: 'bad_request' });
    setBillingForTests({ approvedModels: [FREE_OR] });
    await expect(assertCompletionAllowed('gemini:gemini-3.8-flash')).rejects.toMatchObject({ code: 'paid_blocked' });
    await expect(assertCompletionAllowed(FREE_OR)).resolves.toBeUndefined();
  });

  it('fallback chains drop paid models', () => {
    const { chain, skipped } = fallbackChain(PAID_OR, [], { needsVision: false, paidAvailable: true });
    expect(chain).not.toContain(PAID_OR);
    expect(skipped).toContainEqual({ id: PAID_OR, reason: 'not a free model' });
  });
});

describe('Free Models Only: routing', () => {
  const paid = fakeModel(PAID_OR, { vision: true, free: false, pricing: { prompt: 1, completion: 4 } });
  const free = fakeModel(FREE_OR, { free: true, contextLength: 1_000_000 });

  it('never asks to use a paid model, even when the client claims it was approved', () => {
    const task = detectTask([user('hello')]);
    const r = routeModel(PAID_OR, task, [paid, free], { paidAvailable: true, approvedPaid: PAID_OR });
    expect(r.kind).toBe('ok');
    expect(r.kind === 'ok' && r.chain).toEqual([FREE_OR]);
    expect(r.kind === 'ok' && r.switched?.reason).toBe('is not a free model');
  });

  it('when only a paid model could answer, says no free model can (no approval prompt)', () => {
    const task = detectTask([
      { role: 'user', content: 'what is this', attachments: [{ kind: 'image', dataUrl: 'data:image/png;base64,AA', name: 'a.png', mime: 'image/png' }] },
    ]);
    const r = routeModel(FREE_OR, task, [paid, free], { paidAvailable: true });
    expect(r.kind).toBe('none');
  });

  it('the free-limit message tells people to try later', () => {
    expect(FREE_LIMIT_MESSAGE).toMatch(/free AI usage limit has been reached/);
    expect(FREE_LIMIT_MESSAGE).toMatch(/try again later/);
  });
});
