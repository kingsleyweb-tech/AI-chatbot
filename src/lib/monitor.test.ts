import { describe, expect, it } from 'vitest';
import { scrub } from './monitor';

describe('client monitoring scrub', () => {
  it('removes emails, phone numbers, query strings and tokens', () => {
    const s = scrub('failed for ama@example.com on +233 24 123 4567 at /api/x?code=123456 Bearer abc.def');
    expect(s).not.toContain('ama@example.com');
    expect(s).not.toContain('123 4567');
    expect(s).not.toContain('code=123456');
    expect(s).not.toContain('abc.def');
  });
  it('limits the length', () => {
    expect(scrub('x'.repeat(1000))).toHaveLength(300);
  });
});
