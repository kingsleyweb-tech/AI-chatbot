import { describe, expect, it } from 'vitest';
import type { Source } from '@shared/types';
import { linkCitations } from './Markdown';

const sources: Source[] = [
  { index: 1, title: 'Example', url: 'https://example.com/a?b=1', snippet: '', kind: 'web' },
  { index: 1, title: 'report.pdf', url: '', snippet: '', kind: 'document' },
];

describe('linkCitations', () => {
  it('turns known web and document markers into cite links', () => {
    expect(linkCitations('Fact [1] and doc [D1].', sources)).toBe(
      `Fact [1](cite:${encodeURIComponent('https://example.com/a?b=1')}) and doc [D1](cite:doc).`,
    );
  });

  it('leaves unknown markers, existing links and code untouched', () => {
    const md = 'See [2], [1](http://x) and `arr[1]`\n```\nx = a[1]\n```';
    expect(linkCitations(md, sources)).toBe(md);
  });

  it('is a no-op without sources', () => {
    expect(linkCitations('a [1]', [])).toBe('a [1]');
  });
});
