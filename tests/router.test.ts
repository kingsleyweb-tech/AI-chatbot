import { describe, expect, it } from 'vitest';
import { estimateCost, routeModel, unfitReason } from '../server/router/route.js';
import { detectTask, docKind } from '../server/router/task.js';
import type { ChatTurn } from '../server/shared/types.js';
import { fakeModel } from './helpers.js';

const ULTRA = 'nvidia/nemotron-3-ultra-550b-a55b:free';
const VL = 'nvidia/nemotron-3.5-super-vl:free';
const GEMMA = 'google/gemma-4-26b-a4b-it:free';
const PAID_VISION = 'google/gemini-3.8-flash';
const PAID_TEXT = 'acme/big-text';

const img = { kind: 'image' as const, dataUrl: 'data:image/png;base64,AAAA', name: 'a.png', mime: 'image/png' };
const user = (content: string, withImage = false): ChatTurn => ({
  role: 'user',
  content,
  ...(withImage ? { attachments: [img] } : {}),
});

const catalog = () => [
  fakeModel(ULTRA, { contextLength: 1_000_000 }),
  fakeModel(VL, { vision: true, contextLength: 128_000 }),
  fakeModel(GEMMA, { vision: true, contextLength: 96_000 }),
  fakeModel(PAID_VISION, { vision: true, contextLength: 1_000_000, pricing: { prompt: 0.3, completion: 2.5 } }),
  fakeModel(PAID_TEXT, { contextLength: 200_000, pricing: { prompt: 1, completion: 4 } }),
];

describe('detectTask', () => {
  it('detects images, code and analysis intents', () => {
    expect(detectTask([user('What is in this picture?', true)]).needsVision).toBe(true);
    expect(detectTask([user('Hello there')]).intent).toBe('chat');
    expect(detectTask([user('Why does this Python function throw an exception?')]).intent).toBe('code');
    expect(detectTask([user('What is the average revenue?')], [{ name: 'sales.xlsx', mime: '' }]).intent).toBe('analysis');
    expect(detectTask([user('Summarize this')], [{ name: 'a.pdf', mime: 'application/pdf' }]).intent).toBe('summarize');
    expect(
      detectTask([user('Compare these two')], [
        { name: 'a.pdf', mime: '' },
        { name: 'b.docx', mime: '' },
      ]).intent,
    ).toBe('compare');
  });

  it('detects image generation and editing requests', () => {
    expect(detectTask([user('Generate an image of a lighthouse at dusk')]).intent).toBe('imageGen');
    expect(detectTask([user('Draw a logo for my bakery')]).intent).toBe('imageGen');
    expect(detectTask([user('Remove the background from this photo', true)]).intent).toBe('imageEdit');
    expect(detectTask([user('Describe this image', true)]).intent).toBe('chat');
  });

  it('classifies document kinds', () => {
    expect(docKind('report.PDF')).toBe('pdf');
    expect(docKind('deck.pptx')).toBe('pptx');
    expect(docKind('data.csv')).toBe('sheet');
    expect(docKind('main.rs')).toBe('code');
    expect(docKind('notes.md')).toBe('text');
  });

  it('estimates tokens for the newest message', () => {
    const t = detectTask([user('x'.repeat(40_000))]);
    expect(t.estTokens).toBeGreaterThan(10_000);
  });
});

describe('routeModel', () => {
  const opts = { paidAvailable: false };

  it('keeps a text model for a text-only request', () => {
    const r = routeModel(ULTRA, detectTask([user('Hi')]), catalog(), opts);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.chain[0]).toBe(ULTRA);
      expect(r.switched).toBeNull();
    }
  });

  it('switches an image request from a text model to a free vision model, once', () => {
    const r = routeModel(ULTRA, detectTask([user('What is this?', true)]), catalog(), opts);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.chain[0]).toBe(VL);
      expect(r.chain).not.toContain(ULTRA);
      expect(r.chain.every((id) => id.endsWith(':free'))).toBe(true);
      expect(r.switched).toMatchObject({ from: ULTRA, to: VL, reason: 'cannot read images' });
    }
  });

  it('keeps a vision model for an image request', () => {
    const r = routeModel(GEMMA, detectTask([user('What is this?', true)]), catalog(), opts);
    expect(r.kind === 'ok' && r.chain[0]).toBe(GEMMA);
    expect(r.kind === 'ok' && r.switched).toBeNull();
  });

  it('asks for approval when only a paid model fits, and never includes it in a chain', () => {
    const models = catalog().filter((m) => !(m.free && m.capabilities.vision));
    const r = routeModel(ULTRA, detectTask([user('What is this?', true)]), models, opts);
    expect(r.kind).toBe('approval');
    if (r.kind === 'approval') {
      expect(r.model.id).toBe(PAID_VISION);
      expect(r.creditsNeeded).toBe(true);
      expect(r.estCost).toBeGreaterThan(0);
      expect(r.reason).toMatch(/paid model/);
    }
  });

  it('uses an approved paid model when credits exist', () => {
    const models = catalog().filter((m) => !(m.free && m.capabilities.vision));
    const r = routeModel(ULTRA, detectTask([user('What is this?', true)]), models, {
      paidAvailable: true,
      approvedPaid: PAID_VISION,
    });
    expect(r.kind === 'ok' && r.chain[0]).toBe(PAID_VISION);
  });

  it('still asks when an approved paid model cannot run because there are no credits', () => {
    const r = routeModel(ULTRA, detectTask([user('What is this?', true)]), catalog(), {
      paidAvailable: false,
      approvedPaid: PAID_VISION,
    });
    expect(r.kind === 'approval' && r.creditsNeeded).toBe(true);
  });

  it('falls back to a free model when the selected one is unavailable', () => {
    const models = catalog().map((m) => (m.id === ULTRA ? { ...m, available: false } : m));
    const r = routeModel(ULTRA, detectTask([user('Hi')]), models, opts);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.chain[0]).not.toBe(ULTRA);
      expect(r.switched?.reason).toBe('is unavailable right now');
    }
  });

  it('falls back to a free model when a paid selection has no credits', () => {
    const r = routeModel(PAID_TEXT, detectTask([user('Hi')]), catalog(), opts);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.chain[0]).toBe(ULTRA);
      expect(r.switched?.reason).toBe('needs OpenRouter credits');
    }
  });

  it('moves a message that is too long to a model with a bigger context', () => {
    const task = detectTask([user('word '.repeat(150_000))]);
    const r = routeModel(GEMMA, task, catalog(), opts);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.chain[0]).toBe(ULTRA);
      expect(r.switched?.reason).toMatch(/context window/);
    }
  });

  it('keeps the text model for image generation requests (generation is not offered)', () => {
    const task = detectTask([user('Create an image of a red bicycle')]);
    expect(task.intent).toBe('imageGen');
    const r = routeModel(ULTRA, task, catalog(), opts);
    expect(r.kind === 'ok' && r.chain[0]).toBe(ULTRA);
  });

  it('reports none when nothing can read images', () => {
    const models = catalog().filter((m) => !m.capabilities.vision);
    const r = routeModel(ULTRA, detectTask([user('What is this?', true)]), models, opts);
    expect(r.kind).toBe('none');
  });

  it('uses the configured order when the catalog is unavailable', () => {
    const r = routeModel(ULTRA, detectTask([user('Hi')]), [], opts);
    expect(r.kind === 'ok' && r.chain[0]).toBe(ULTRA);
  });

  it('helpers: unfitReason and estimateCost', () => {
    const task = detectTask([user('What is this?', true)]);
    expect(unfitReason(fakeModel(ULTRA), task)).toBe('cannot read images');
    expect(unfitReason(undefined, task)).toMatch(/not currently offered/);
    expect(estimateCost(fakeModel('x', { pricing: { prompt: 1, completion: 2 } }), 1_000_000, 0)).toBe(1);
    expect(estimateCost(fakeModel('x'), 100)).toBeNull();
  });
});

describe('OpenRouter free daily limit', () => {
  it('maps the per-day 429 to a non-fallback daily_limit error and short-circuits free calls', async () => {
    const { mapError, freeDailyLimitActive, resetFreeDailyLimit, OpenRouterProvider } = await import('../server/providers/openrouter.js');
    resetFreeDailyLimit();
    const short = mapError(429, JSON.stringify({ error: { message: 'Rate limit exceeded: free-models-per-min.' } }));
    expect(short.code).toBe('rate_limited');
    expect(freeDailyLimitActive()).toBe(false);
    const daily = mapError(429, JSON.stringify({ error: { message: 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day' } }));
    expect(daily.code).toBe('daily_limit');
    expect(daily.fallbackable).toBe(false);
    expect(daily.retryable).toBe(false);
    expect(freeDailyLimitActive()).toBe(true);
    process.env.OPENROUTER_API_KEY ??= 'test-key';
    const p = new OpenRouterProvider();
    await expect(p.complete({ model: 'x/y:free', messages: [] })).rejects.toMatchObject({ code: 'daily_limit' });
    resetFreeDailyLimit();
  });
});
