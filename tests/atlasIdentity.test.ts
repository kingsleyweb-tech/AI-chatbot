/**
 * Atlas AI identity: questions about who built or owns Atlas AI, or what it
 * runs on, get the verified record in the system prompt for every model, and
 * are not sent to web search (which finds other organisations with the same
 * name). Ordinary questions are unaffected.
 */
import { describe, expect, it } from 'vitest';
import { atlasIdentityBrief, modelName } from '../server/chat/identity.js';
import { buildSystemPrompt } from '../server/chat/prompt.js';
import { decideSearch } from '../server/search/decide.js';
import { ATLAS_IDENTITY, isAboutAtlas } from '../server/shared/identity.js';

const IDENTITY_QUESTIONS = [
  'Who built Atlas AI?',
  'Who created Atlas AI?',
  'Who owns Atlas AI?',
  'Who is the founder of Atlas AI?',
  'Who is behind Atlas AI?',
  'Who developed Atlas AI?',
  'who made you',
  'Who built you?',
  'who owns this app',
  'Who are you?',
  'What models do you use?',
  'Which AI model are you?',
  'What technology powers Atlas AI?',
  'What is Atlas AI built on?',
  'Are you ChatGPT?',
  'Tell me about Atlas AI',
  'What are your underlying models?',
  'Who’s the creator of Atlas AI',
  'Which AI models and providers do you use?',
  'What technologies is Atlas AI built with?',
];

const ORDINARY = [
  'Who built the pyramids?',
  'Who owns Tesla?',
  'Can you build me a website?',
  'What models of Toyota are best for a family?',
  'Write a poem about the ocean',
  'Who won the match yesterday?',
  'Explain how transformers work',
  'Thank you, you made my day',
  'What do you think about this plan?',
  'What models do you recommend for a small car?',
  'Which services do you think are best for hosting?',
];

describe('isAboutAtlas', () => {
  it('recognises identity, ownership and technology questions', () => {
    for (const q of IDENTITY_QUESTIONS) expect(isAboutAtlas(q), q).toBe(true);
  });
  it('leaves ordinary questions alone', () => {
    for (const q of ORDINARY) expect(isAboutAtlas(q), q).toBe(false);
  });
});

describe('identity brief', () => {
  const brief = atlasIdentityBrief();

  it('names Anaab Kingsley as creator, developer and owner', () => {
    expect(ATLAS_IDENTITY.creator).toBe('Anaab Kingsley');
    expect(ATLAS_IDENTITY.owner).toBe('Anaab Kingsley');
    expect(brief).toContain('Creator and developer: Anaab Kingsley. Owner: Anaab Kingsley.');
    expect(brief).toContain('Think Further. Do More.');
  });

  it('rules out the similarly named organisation', () => {
    for (const name of ['Stanford University', 'David Lobell', 'Marshall Burke', 'Stefano Ermon', 'The Rockefeller Foundation', 'public benefit corporation']) {
      expect(brief).toContain(name);
    }
  });

  it('lists every provider', () => {
    for (const p of ['Google Gemini', 'OpenRouter', 'Cloudflare Workers AI', 'ElevenLabs', 'Tavily', 'SerpAPI', 'Firebase', 'Vercel', 'Brevo']) expect(brief).toContain(p);
  });

  it('lists only models the configuration allows', () => {
    expect(brief).toContain('Gemini 3.8 Flash');
    expect(brief).toContain('Gemini 3.5 Flash-Lite');
    // configured but not in the free tier, so blocked by the Free Models Only policy
    expect(brief).not.toMatch(/Gemini 3\.5 Flash(?!-Lite)/);
    expect(brief).not.toContain('Pro Preview');
    expect(brief).toContain('NVIDIA Nemotron 3 Ultra 550B A55B (free)');
    expect(brief).toContain('NVIDIA Nemotron 3.5 Super VL (free)');
    for (const m of ['Gemma 4 26B', 'GPT-OSS 120B', 'Llama 4 Scout', 'Mistral Small 3.1', 'Qwen2.5 Coder 32B']) expect(brief).toContain(m);
    expect(brief).toMatch(/FLUX\.2 \[klein\] 4B/);
    expect(brief).toMatch(/FLUX\.1 \[schnell\]/);
    expect(brief).toContain('Llama Guard 3 8B');
    expect(brief).toContain('eleven_flash_v2_5');
  });

  it('formats model ids', () => {
    expect(modelName('gemini:gemini-3.5-flash-lite')).toBe('Gemini 3.5 Flash-Lite');
    expect(modelName('google/gemma-4-26b-a4b-it:free')).toBe('Google Gemma 4 26B A4B IT');
  });
});

describe('system prompt', () => {
  const settings = {} as Parameters<typeof buildSystemPrompt>[0]['settings'];

  it('always knows its owner, adds the full record only for identity questions', () => {
    const plain = buildSystemPrompt({ settings });
    expect(plain).toContain('created, developed and owned by Anaab Kingsley');
    expect(plain).not.toContain('About Atlas AI (verified');
    const withBrief = buildSystemPrompt({ settings, atlasIdentity: atlasIdentityBrief() });
    expect(withBrief).toContain('About Atlas AI (verified');
  });
});

describe('search decision', () => {
  it('answers identity questions from the record, not the web', () => {
    for (const q of IDENTITY_QUESTIONS) expect(decideSearch(q).action, q).toBe('none');
    expect(decideSearch('Who is the founder of Atlas AI?').reason).toBe('atlas_identity');
  });
  it('still searches when the user explicitly asks', () => {
    expect(decideSearch('Who built Atlas AI?', { webSearch: true }).action).toBe('search');
  });
  it('does not change unrelated questions', () => {
    expect(decideSearch('Who won the match yesterday?').action).toBe('search');
  });
});
