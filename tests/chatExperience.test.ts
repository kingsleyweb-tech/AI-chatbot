import { describe, expect, it } from 'vitest';
import { documentStage, planSend, withoutSent } from '../src/features/chat/attachments.js';
import { activitySteps, activitySummary } from '../src/features/chat/activity.js';

type Doc = { id: string; name: string; mime: string; size: number; status: 'processing' | 'ready' | 'failed'; error?: string };
const doc = (id: string, status: Doc['status'], extra: Partial<Doc> = {}): Doc => ({
  id,
  name: `${id}.pdf`,
  mime: 'application/pdf',
  size: 1000,
  status,
  ...extra,
});

describe('attachments waiting in the composer', () => {
  it('maps each document to its stage', () => {
    expect(documentStage(doc('a', 'processing'))).toBe('processing');
    expect(documentStage(doc('a', 'ready'))).toBe('ready');
    expect(documentStage(doc('a', 'failed'))).toBe('failed');
  });

  it('a message carries references to every ready document', () => {
    const plan = planSend([doc('a', 'ready'), doc('b', 'ready')], []);
    expect(plan.waiting).toBe(false);
    expect(plan.sentIds).toEqual(['a', 'b']);
    expect(plan.attachments).toEqual([
      { kind: 'document', documentId: 'a', name: 'a.pdf', mime: 'application/pdf' },
      { kind: 'document', documentId: 'b', name: 'b.pdf', mime: 'application/pdf' },
    ]);
  });

  it('waits while a document is uploading or still being processed (it would be left out)', () => {
    expect(planSend([doc('a', 'processing')], []).waiting).toBe(true);
    expect(planSend([doc('a', 'ready')], [{ status: 'uploading' }]).waiting).toBe(true);
    // a failed upload does not block: it stays behind with Retry
    expect(planSend([doc('a', 'ready')], [{ status: 'failed' }]).waiting).toBe(false);
  });

  it('partial failure: ready documents are sent, failed ones stay in the composer', () => {
    const pending = [doc('a', 'ready'), doc('b', 'failed', { error: 'No readable text' }), doc('c', 'ready')];
    const plan = planSend(pending, []);
    expect(plan.sentIds).toEqual(['a', 'c']);
    expect(withoutSent(pending.map((d) => d.id), plan.sentIds)).toEqual(['b']);
  });

  it('only ids that were sent leave the composer (nothing is sent twice)', () => {
    expect(withoutSent(['a', 'b', 'c'], [])).toEqual(['a', 'b', 'c']);
    expect(withoutSent(['a', 'b', 'c'], ['b'])).toEqual(['a', 'c']);
    // a second removal of the same ids changes nothing
    expect(withoutSent(withoutSent(['a', 'b'], ['a']), ['a'])).toEqual(['b']);
  });
});

describe('activity panel', () => {
  it('shows nothing for a plain answer without tools', () => {
    expect(activitySteps({ live: false, status: 'complete', hasContent: true })).toEqual([]);
    expect(activitySteps({ live: true, status: 'streaming', hasContent: true, context: { memories: 0, documents: 0, conversations: 0 } })).toEqual([]);
  });

  it('lists a web search and the answer being written, in order', () => {
    const steps = activitySteps({
      live: true,
      status: 'streaming',
      search: { status: 'ok', mode: 'search', provider: 'tavily', query: 'weather in Accra', cached: false, trigger: 'auto' },
      hasContent: true,
    });
    expect(steps.map((s) => [s.label, s.state])).toEqual([
      ['Searched the web', 'done'],
      ['Writing the answer', 'active'],
    ]);
    expect(steps[0].detail).toBe('weather in Accra · Tavily');
    expect(activitySummary(steps)).toBe('Writing the answer…');
  });

  it('research in progress has one active step; finished research is all done', () => {
    const research = [
      { kind: 'plan' as const, text: '3 searches' },
      { kind: 'search' as const, text: 'solar panel prices', provider: 'serpapi' as const },
      { kind: 'read' as const, text: 'example.com/prices', provider: 'tavily' as const },
    ];
    const running = activitySteps({ live: true, status: 'streaming', researchSteps: research, hasContent: false });
    expect(running.map((s) => s.state)).toEqual(['done', 'done', 'done', 'active']);
    expect(running.at(-1)?.label).toBe('Researching');
    const done = activitySteps({
      live: false,
      status: 'complete',
      researchSteps: [...research, { kind: 'done', text: 'Report ready' }],
      search: { status: 'ok', mode: 'research', provider: null, query: 'solar', cached: false, trigger: 'research' },
      hasContent: true,
    });
    expect(done.every((s) => s.state === 'done')).toBe(true);
    expect(done.filter((s) => s.label === 'Finished researching')).toHaveLength(1);
    expect(activitySummary(done)).toBe('4 steps');
  });

  it('documents and knowledge come from what the server retrieved', () => {
    const steps = activitySteps({ live: false, status: 'complete', context: { memories: 2, documents: 3, conversations: 0, knowledge: 1 }, hasContent: true });
    expect(steps.map((s) => s.label)).toEqual(['Searched the knowledge base', 'Read your documents', 'Recalled your memories', 'Wrote the answer']);
    expect(steps[1].detail).toBe('3 excerpts used');
  });

  it('a search that could not run is shown as not completed', () => {
    const steps = activitySteps({
      live: false,
      status: 'complete',
      search: { status: 'unavailable', mode: 'search', provider: null, query: 'x', cached: false, trigger: 'manual', message: 'daily search limit reached' },
      hasContent: true,
    });
    expect(steps[0]).toMatchObject({ label: 'Web search not used', state: 'failed', detail: 'daily search limit reached' });
    expect(activitySummary(steps)).toBe('Web search not used');
    const mixed = activitySteps({
      live: false,
      status: 'complete',
      search: { status: 'unavailable', mode: 'search', provider: null, query: 'x', cached: false, trigger: 'manual', message: 'limit' },
      context: { memories: 0, documents: 2, conversations: 0, knowledge: 0 },
      hasContent: true,
    });
    expect(activitySummary(mixed)).toBe('2 steps · 1 failed');
  });

  it('image stages follow the real stage the server reports', () => {
    const at = (stage: 'checking' | 'generating' | 'saving') => activitySteps({ live: true, status: 'streaming', imageStage: stage, hasContent: false }).map((s) => s.state);
    expect(at('checking')).toEqual(['active', 'pending', 'pending']);
    expect(at('generating')).toEqual(['done', 'active', 'pending']);
    expect(at('saving')).toEqual(['done', 'done', 'active']);
    const finished = activitySteps({ live: false, status: 'complete', imageCount: 1, hasContent: true });
    expect(finished.map((s) => s.label)).toEqual(['Checked the request', 'Created the image', 'Saved the image']);
    expect(activitySummary(finished)).toBe('3 steps');
  });

  it('a stopped or failed reply marks the running step as not completed, and lists no later stages', () => {
    const steps = activitySteps({ live: true, status: 'stopped', imageStage: 'generating', hasContent: false });
    expect(steps.map((s) => [s.label, s.state])).toEqual([
      ['Checked the request', 'done'],
      ['Creating the image', 'failed'],
    ]);
  });
});
