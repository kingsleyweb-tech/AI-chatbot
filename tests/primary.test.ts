import { describe, expect, it } from 'vitest';
import { DEFAULT_AI_CONFIG, normalizeAiConfig } from '../server/config/ai.js';
import { modelConfig, TASK_PREFERENCES } from '../server/config/models.js';
import { mapGeminiError } from '../server/providers/gemini.js';
import { ProviderError } from '../server/providers/types.js';
import { applyFallbackPolicy, nextInChain, routeModel } from '../server/router/route.js';
import { detectTask } from '../server/router/task.js';
import type { ChatTurn, ModelInfo } from '../server/shared/types.js';
import { fakeModel } from './helpers.js';

const G_FLASH = 'gemini:gemini-3.8-flash';
const G_NEW = 'gemini:gemini-3.6-flash';
const G_LITE = 'gemini:gemini-3.5-flash-lite';
const ULTRA = 'nvidia/nemotron-3-ultra-550b-a55b:free';
const VL = 'nvidia/nemotron-3.5-super-vl:free';
const PAID = 'acme/paid-vision';

const gem = (id: string, o: Partial<ModelInfo> = {}) =>
  fakeModel(id, { provider: 'gemini', free: true, vision: true, audioInput: true, contextLength: 1_000_000, ...o });
const catalog = (o: { orDown?: boolean; gemDown?: boolean } = {}) => [
  gem(G_FLASH, { available: !o.gemDown }),
  gem(G_NEW, { available: !o.gemDown }),
  gem(G_LITE, { available: !o.gemDown }),
  fakeModel(ULTRA, { contextLength: 1_000_000, available: !o.orDown }),
  fakeModel(VL, { vision: true, available: !o.orDown }),
  fakeModel(PAID, { vision: true, pricing: { prompt: 1, completion: 4 } }),
];
const user = (content: string, image = false): ChatTurn => ({
  role: 'user',
  content,
  ...(image ? { attachments: [{ kind: 'image' as const, dataUrl: 'data:image/png;base64,AA', name: 'a.png', mime: 'image/png' }] } : {}),
});
const provOf = (id: string) => (id.startsWith('gemini:') ? 'gemini' : 'openrouter');
const opts = { paidAvailable: false, preferredProvider: 'gemini' as const, fallback: 'any' as const };

describe('Gemini as primary provider', () => {
  it('1. uses Gemini 3.6 Flash by default (Flash-Lite, then 3.8 Flash next), Flash-Lite for background jobs, Gemini first everywhere', () => {
    const saved = { key: process.env.GEMINI_API_KEY, def: process.env.DEFAULT_MODEL };
    process.env.GEMINI_API_KEY = 'x';
    delete process.env.DEFAULT_MODEL;
    try {
      const cfg = modelConfig();
      expect(cfg.defaultModel).toBe(G_NEW);
      expect(cfg.fallbackModels.slice(0, 3)).toEqual([G_NEW, G_LITE, G_FLASH]);
      // OpenRouter free models stay in the chain after Gemini; nothing paid
      expect(cfg.fallbackModels.slice(3).every((m) => m.endsWith(':free'))).toBe(true);
      expect(cfg.utilityModels[0]).toBe(G_LITE);
    } finally {
      if (saved.key === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = saved.key;
      if (saved.def !== undefined) process.env.DEFAULT_MODEL = saved.def;
    }
    for (const list of Object.values(TASK_PREFERENCES)) expect(list.slice(0, 2)).toEqual([G_NEW, G_FLASH]);
    for (const list of Object.values(TASK_PREFERENCES)) expect(provOf(list[0])).toBe('gemini');
    expect(DEFAULT_AI_CONFIG.preferredProvider).toBe('gemini');
  });

  it('1b. a manually selected Gemini 3.8 Flash is kept, with 3.6 Flash as its first fallback', () => {
    const r = routeModel(G_FLASH, detectTask([user('Explain recursion')]), catalog(), opts);
    expect(r.kind === 'ok' && r.chain.slice(0, 2)).toEqual([G_FLASH, G_NEW]);
    expect(r.kind === 'ok' && r.switched).toBeNull();
  });

  it('2. a normal text request on Gemini stays on Gemini, with OpenRouter as fallback', () => {
    const r = routeModel(G_FLASH, detectTask([user('Explain recursion')]), catalog(), opts);
    expect(r.kind === 'ok' && r.chain[0]).toBe(G_FLASH);
    expect(r.kind === 'ok' && r.switched).toBeNull();
    expect(r.kind === 'ok' && r.chain.some((id) => provOf(id) === 'openrouter')).toBe(true);
  });

  it('3. a manually selected OpenRouter model is respected', () => {
    const r = routeModel(ULTRA, detectTask([user('Explain recursion')]), catalog(), opts);
    expect(r.kind === 'ok' && r.chain[0]).toBe(ULTRA);
    expect(r.kind === 'ok' && r.switched).toBeNull();
  });

  it('4. OpenRouter free quota used up: the reply moves to Gemini and says so', () => {
    const r = routeModel(ULTRA, detectTask([user('hello')]), catalog({ orDown: true }), opts);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(provOf(r.chain[0])).toBe('gemini');
    expect(r.switched).toMatchObject({ from: ULTRA, to: G_NEW });
  });

  it('5. Gemini unavailable: falls back to a free OpenRouter model', () => {
    const r = routeModel(G_FLASH, detectTask([user('hello')]), catalog({ gemDown: true }), opts);
    expect(r.kind === 'ok' && provOf(r.chain[0])).toBe('openrouter');
    expect(r.kind === 'ok' && r.switched?.from).toBe(G_FLASH);
  });

  it('6. an image with a text-only model routes to a free Gemini vision model', () => {
    const r = routeModel(ULTRA, detectTask([user('What is in this picture?', true)]), catalog(), opts);
    expect(r.kind === 'ok' && r.chain[0]).toBe(G_NEW);
  });

  it('7. both providers down and only a paid model fits: no paid model is used or offered', () => {
    const r = routeModel(ULTRA, detectTask([user('Describe this', true)]), catalog({ orDown: true, gemDown: true }), opts);
    expect(r.kind).toBe('none');
  });

  it('8. paid models are never in an automatic chain', () => {
    const r = routeModel(G_FLASH, detectTask([user('hello')]), catalog(), { ...opts, paidAvailable: true });
    expect(r.kind === 'ok' && r.chain.includes(PAID)).toBe(false);
  });

  it('9. admin can prefer OpenRouter', () => {
    const r = routeModel(PAID, detectTask([user('hello')]), catalog(), { ...opts, preferredProvider: 'openrouter' });
    expect(r.kind === 'ok' && provOf(r.chain[0])).toBe('openrouter');
  });

  it('10. fallback policy: off keeps one model, same_provider stays on the provider', () => {
    const chain = [G_FLASH, ULTRA, G_LITE, VL];
    expect(applyFallbackPolicy(chain, catalog(), 'off')).toEqual([G_FLASH]);
    expect(applyFallbackPolicy(chain, catalog(), 'same_provider')).toEqual([G_FLASH, G_LITE]);
    expect(applyFallbackPolicy(chain, catalog(), 'any')).toEqual(chain);
    const r = routeModel(G_FLASH, detectTask([user('hello')]), catalog(), { ...opts, fallback: 'off' });
    expect(r.kind === 'ok' && r.chain).toEqual([G_FLASH]);
  });
});

describe('provider failures and fallback', () => {
  const chain = [G_FLASH, G_LITE, ULTRA, VL];
  const err = (code: ConstructorParameters<typeof ProviderError>[0]) => new ProviderError(code, 'x', 500);

  it('11. invalid Gemini key: skips the other Gemini models and goes to OpenRouter', () => {
    expect(mapGeminiError(403, '{"error":{"message":"API key not valid"}}').code).toBe('invalid_key');
    expect(mapGeminiError(400, '{"error":{"message":"API key not valid. Please pass a valid API key."}}').code).toBe('invalid_key');
    expect(nextInChain(chain, 0, err('invalid_key'), provOf)).toBe(2);
  });

  it('12. invalid OpenRouter key with no other provider left: stops', () => {
    expect(nextInChain(chain, 2, err('invalid_key'), provOf)).toBe(-1);
  });

  it('13. Gemini rate limit or outage: tries the next model', () => {
    expect(mapGeminiError(429, '{"error":{"message":"Resource exhausted"}}').code).toBe('rate_limited');
    expect(mapGeminiError(503, '{"error":{"message":"high demand"}}').code).toBe('provider_error');
    expect(nextInChain(chain, 0, err('rate_limited'), provOf)).toBe(1);
    expect(nextInChain(chain, 0, err('provider_error'), provOf)).toBe(1);
  });

  it('14. OpenRouter daily cap: jumps past every OpenRouter model', () => {
    expect(nextInChain([ULTRA, VL, G_FLASH], 0, err('daily_limit'), provOf)).toBe(2);
  });

  it('15. non-recoverable errors never fall back (no wasted requests)', () => {
    expect(nextInChain(chain, 0, err('bad_request'), provOf)).toBe(-1);
    expect(nextInChain(chain, 0, err('moderation'), provOf)).toBe(-1);
    expect(nextInChain(chain, 0, err('context_too_long'), provOf)).toBe(-1);
    expect(nextInChain(chain, 3, err('rate_limited'), provOf)).toBe(-1);
  });

  it('admin config is validated', () => {
    expect(normalizeAiConfig(null)).toEqual(DEFAULT_AI_CONFIG);
    expect(normalizeAiConfig({ preferredProvider: 'evil', fallback: 'x', defaultModel: 'a b <script>' })).toEqual(DEFAULT_AI_CONFIG);
    expect(normalizeAiConfig({ preferredProvider: 'openrouter', fallback: 'off', defaultModel: G_LITE })).toEqual({
      preferredProvider: 'openrouter',
      fallback: 'off',
      defaultModel: G_LITE,
    });
  });
});
