import { describe, expect, it } from 'vitest';
import { replyPhase } from './phase';

describe('replyPhase (generation indicator)', () => {
  it('is thinking until answer text arrives, even after the server sent `start`', () => {
    expect(replyPhase({ status: 'connecting', content: '' })).toBe('thinking');
    expect(replyPhase({ status: 'streaming', content: '' })).toBe('thinking');
  });
  it('stays visible while the answer streams', () => {
    expect(replyPhase({ status: 'streaming', content: 'Hello' })).toBe('streaming');
  });
  it('stays visible after the model finished until the reply is stored', () => {
    expect(replyPhase({ status: 'done', content: 'Hello' })).toBe('saving');
    expect(replyPhase({ status: 'done', content: 'Hello', settled: false })).toBe('saving');
    expect(replyPhase({ status: 'done', content: 'Hello', settled: true })).toBe('completed');
  });
  it('ends on failure or stop', () => {
    expect(replyPhase({ status: 'error', content: '' })).toBe('failed');
    expect(replyPhase({ status: 'error', content: 'partial' })).toBe('failed');
    expect(replyPhase({ status: 'stopped', content: 'partial' })).toBe('interrupted');
  });
});
