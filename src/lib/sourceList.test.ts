import { describe, expect, it } from 'vitest';
import { stripSourceList } from './sourceList';

describe('a sources list the model wrote at the end is removed', () => {
  it('removes a heading followed by linked list items, and the separator before it', () => {
    const md = [
      'He is remembered for a historic comeback [1].',
      '',
      '---',
      '',
      '### Sources and Further Reading',
      '',
      '* [Wikipedia: John Mahama](https://en.wikipedia.org/wiki/John_Mahama) [1]',
      '* [The Presidency: Official Profile](https://presidency.gov.gh/profile) [3]',
    ].join('\n');
    expect(stripSourceList(md)).toBe('He is remembered for a historic comeback [1].');
  });

  it('handles bold headings and numbered citation lists', () => {
    expect(stripSourceList('Answer.\n\n**Sources:**\n1. BBC News [2]\n2. Reuters [4]')).toBe('Answer.');
    expect(stripSourceList('Answer.\n\nReferences\n- https://example.com/a')).toBe('Answer.');
  });

  it('keeps sections that are real content', () => {
    const essay = 'Intro.\n\n## Sources of energy\n\n- Solar power is growing quickly.\n- Wind is cheaper than coal.';
    expect(stripSourceList(essay)).toBe(essay);
    const mixed = 'Intro.\n\n## Sources\n\nThe data come from two surveys, described below.\n- [Survey](https://x.org)';
    expect(stripSourceList(mixed)).toBe(mixed);
  });

  it('leaves answers without such a section alone', () => {
    expect(stripSourceList('Just an answer [1].')).toBe('Just an answer [1].');
  });
});
