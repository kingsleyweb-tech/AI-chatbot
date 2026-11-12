import { describe, expect, it } from 'vitest';
import { choosePathway, thinkingSwitchable } from '../server/router/pathway.js';
import { geminiThinking } from '../server/providers/gemini.js';

const path = (t: string, o?: { hasCodeAttachment?: boolean }) => choosePathway(t, o).pathway;

describe('simple messages take the fast pathway (no thinking before answering)', () => {
  const simple = [
    'Hello',
    'Hi bro',
    'Good morning',
    'How are you?',
    'Thank you',
    'What is Atlas AI?',
    'What is an operating system?',
    'Explain LAN and WAN',
    'Translate "good morning, how was your night?" into French',
    'What is the capital of Ghana?',
    'Define photosynthesis',
    'What is 12 * 7?',
    'Write an email to my landlord asking for the gutter to be fixed',
    'Give me three tips for revising for my economics exam',
    'Can you summarise what we just discussed?',
    'And what about Kumasi?',
    'Briefly explain how a CPU works',
    'Who won the 2010 World Cup?',
    // long but simple: length alone never decides
    'I am planning to visit my grandmother this weekend and I would like to bring her something nice, she likes gardening and reading novels, what are some good gift ideas for her?',
  ];
  it.each(simple)('%s', (t) => expect(path(t)).toBe('fast'));
});

describe('complex messages take Advanced Reasoning', () => {
  const complex: [string, string][] = [
    ['A train leaves at 3:15 pm travelling at 80 km/h and a second leaves the same station at 4:00 pm at 120 km/h. At what time does the second train catch up?', 'math'],
    ['Solve 3x^2 - 5x + 2 = 0', 'math'],
    ['If a shirt costs 120 cedis after a 20% discount, what was the original price?', 'math'],
    ['Find the derivative of sin(x) * e^x', 'math'],
    ['Why does this throw a TypeError?\n```js\nconst a = undefined; a.map(x => x)\n```', 'debugging'],
    ['My React component re-renders forever when I call setState inside useEffect, why does this happen and how can I fix it?', 'debugging'],
    ['What is the time complexity of building a heap and why?', 'algorithm'],
    ['Compare PostgreSQL, MongoDB and DynamoDB for a write-heavy analytics workload', 'comparison'],
    ['Microservices vs monolith: what are the trade-offs for a team of five engineers?', 'comparison'],
    ['Create a detailed 12-week study plan with milestones for learning machine learning', 'planning'],
    ['Three boxes are labelled apples, oranges and mixed, and every label is wrong. You may take one fruit from one box. Solve the puzzle.', 'logic'],
    ['Think step by step: should I take the job offer?', 'explicit'],
    ['Please think deeply about this before answering: is free will compatible with determinism?', 'explicit'],
    ['Explain how public-key cryptography works', 'deep_explanation'],
    ['Explain in depth how database indexing affects write performance', 'deep_explanation'],
    ['Calculate the acceleration of a 5 kg block pushed with a force of 20 N on a frictionless surface', 'math'],
  ];
  it.each(complex)('%s', (t, reason) => {
    const d = choosePathway(t);
    expect(d.pathway).toBe('reasoning');
    expect(d.reason).toBe(reason);
  });

  it('debugging an attached code file uses reasoning', () => {
    expect(path('Why does this crash on startup?', { hasCodeAttachment: true })).toBe('reasoning');
    expect(path('Summarise this file', { hasCodeAttachment: true })).toBe('fast');
  });

  it('a request for a quick answer stays fast even on a technical topic', () => {
    expect(path('In one sentence, what is quantum entanglement?')).toBe('fast');
  });
});

describe('thinking is switched per pathway only on models that support it', () => {
  it('Gemini Flash and Flash-Lite can switch; Pro and other providers keep their own behaviour', () => {
    expect(thinkingSwitchable('gemini:gemini-3.8-flash')).toBe(true);
    expect(thinkingSwitchable('gemini:gemini-3.5-flash-lite')).toBe(true);
    expect(thinkingSwitchable('gemini:gemini-3.1-pro-preview')).toBe(false);
    expect(thinkingSwitchable('deepseek/deepseek-r1:free')).toBe(false);
    expect(thinkingSwitchable('@cf/openai/gpt-oss-120b')).toBe(false);
  });

  it('the fast pathway answers without thinking; Advanced Reasoning streams its thoughts', () => {
    expect(geminiThinking('gemini-3.8-flash', { maxTokens: 8192, reasoning: false })).toEqual({ thinkingBudget: 0 });
    expect(geminiThinking('gemini-3.5-flash-lite', { maxTokens: 8192, reasoning: false })).toEqual({ thinkingLevel: 'minimal' });
    expect(geminiThinking('gemini-3.8-flash', { maxTokens: 8192, reasoning: true })).toEqual({ includeThoughts: true });
  });

  it('Pro models always think, and calls that do not say keep the previous default', () => {
    expect(geminiThinking('gemini-3.1-pro-preview', { reasoning: false })).toEqual({ includeThoughts: true });
    expect(geminiThinking('gemini-3.8-flash', { maxTokens: 8192 })).toEqual({ includeThoughts: true });
    expect(geminiThinking('gemini-3.8-flash', { maxTokens: 600 })).toEqual({ thinkingBudget: 0 });
  });
});
