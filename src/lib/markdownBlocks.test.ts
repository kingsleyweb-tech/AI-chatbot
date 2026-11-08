import { describe, expect, it } from 'vitest';
import { splitBlocks } from './markdownBlocks';

describe('streaming markdown blocks', () => {
  it('splits at blank lines but keeps code fences, lists and tables whole', () => {
    const md = ['Intro paragraph.', '', '- one', '', '- two', '', '```js', 'a()', '', 'b()', '```', '', '| a | b |', '|---|---|', '| 1 | 2 |', '', 'Last'].join('\n');
    const blocks = splitBlocks(md);
    expect(blocks[0]).toBe('Intro paragraph.\n');
    expect(blocks.some((b) => b.includes('- one') && b.includes('- two'))).toBe(true);
    expect(blocks.find((b) => b.includes('```js'))).toContain('b()');
    expect(blocks[blocks.length - 1]).toBe('Last');
    expect(blocks.join('\n')).toBe(md);
  });
});
