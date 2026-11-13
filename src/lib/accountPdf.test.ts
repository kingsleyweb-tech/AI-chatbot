import { describe, expect, it } from 'vitest';
import type { AccountExport } from './accountExport';
import { accountHtml } from './accountPdf';

const data: AccountExport = {
  format: 'atlas-account-export',
  version: 1,
  exportedAt: '2026-11-13T10:00:00.000Z',
  uid: 'u1',
  profile: { displayName: 'Ama Owusu', email: 'ama@example.com', phoneNumber: '+233241234567', createdAt: '2026-01-02T00:00:00.000Z' },
  conversations: [
    {
      id: 'c1',
      title: 'Trip <plan>',
      createdAt: '2026-11-01T09:00:00.000Z',
      messages: [
        { id: 'm1', role: 'user', content: 'Where should I go?', createdAt: '2026-11-01T09:00:00.000Z' },
        { id: 'm2', role: 'assistant', content: 'Try **Cape Coast**.', model: 'gemini-3.5-flash', createdAt: '2026-11-01T09:00:05.000Z', sources: [{ index: 1, title: 'Guide', url: 'https://example.com/g' }] },
      ],
    },
  ],
  memories: [{ id: 'x', text: 'Prefers short answers', category: 'preference', active: true }],
  projects: [{ id: 'p', name: 'Thesis', instructions: 'Formal tone' }],
  projectMemory: [],
  savedResponses: [],
  documents: [{ id: 'd', name: 'notes.pdf', size: 2_200_000, pageCount: 4 }],
  usage: [],
  securityEvents: [{ id: 'e', type: 'login', at: '2026-11-12T08:00:00.000Z', device: 'Chrome on Android' }],
  skipped: [],
};

describe('account PDF layout', () => {
  const html = accountHtml(data, (s) => `<p>${s}</p>`);

  it('has every part, in reading order', () => {
    const order = ['Your Atlas AI data', 'Profile', 'Conversations', 'Memories', 'Projects', 'Saved responses', 'Documents', 'Security activity'];
    const at = order.map((t) => html.indexOf(`>${t}</h`));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('shows the conversation with who said what and its sources', () => {
    expect(html).toContain('Trip &lt;plan&gt;'); // titles are escaped
    expect(html).toContain('Where should I go?');
    expect(html).toContain('https://example.com/g');
    expect(html).toContain('Signed in');
    expect(html).toContain('2.1 MB');
  });

  it('never prints the full phone number', () => {
    expect(html).not.toContain('+233241234567');
  });
});
