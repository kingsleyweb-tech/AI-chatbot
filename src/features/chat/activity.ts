/**
 * The steps behind one reply, for the activity panel (pure: shared by the panel and the tests).
 *
 * Every step comes from an event the server actually sent (or stored with the message):
 * a model switch, research steps, the web search result, what was retrieved from documents,
 * the knowledge base, memories and past chats, and the stages of creating a picture. Nothing is
 * invented, timed or estimated, and nothing internal (prompts, keys, account names) appears.
 * The order is the order in which the server runs these steps.
 */
// relative import (no path alias): the tests import this file directly
import type { ImageStage, ResearchStep, RouteInfo, SearchInfo } from '../../../server/shared/types.js';

export type StepState = 'pending' | 'active' | 'done' | 'failed';

export interface ActivityStep {
  id: string;
  kind: 'route' | 'plan' | 'search' | 'read' | 'skip' | 'research' | 'knowledge' | 'documents' | 'memory' | 'history' | 'image' | 'write';
  label: string;
  detail?: string;
  state: StepState;
}

export interface ActivityInput {
  /** the reply is still being generated in this browser */
  live: boolean;
  status?: 'connecting' | 'streaming' | 'done' | 'stopped' | 'error' | 'processing' | 'complete';
  route?: RouteInfo | null;
  search?: SearchInfo | null;
  researchSteps?: ResearchStep[];
  context?: { memories: number; documents: number; conversations: number; knowledge?: number } | null;
  imageStage?: ImageStage;
  imageCount?: number;
  hasContent: boolean;
}

const PROVIDER: Record<string, string> = { serpapi: 'SerpAPI', tavily: 'Tavily' };
const IMAGE_STAGES: { stage: ImageStage; active: string; done: string }[] = [
  { stage: 'checking', active: 'Checking the request', done: 'Checked the request' },
  { stage: 'generating', active: 'Creating the image', done: 'Created the image' },
  { stage: 'saving', active: 'Saving the image', done: 'Saved the image' },
];

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

export function activitySteps(a: ActivityInput): ActivityStep[] {
  const steps: ActivityStep[] = [];
  const running = a.live && (a.status === 'connecting' || a.status === 'streaming');
  const research = a.researchSteps ?? [];

  if (a.route) steps.push({ id: 'route', kind: 'route', label: `Switched to ${a.route.toName}`, detail: `${a.route.fromName} ${a.route.reason}`, state: 'done' });

  research.forEach((s, i) => {
    const provider = s.provider ? `${PROVIDER[s.provider] ?? s.provider}${s.cached ? ' (cache)' : ''}` : undefined;
    if (s.kind === 'plan') steps.push({ id: `r${i}`, kind: 'plan', label: 'Planned the research', detail: s.text, state: 'done' });
    else if (s.kind === 'search') steps.push({ id: `r${i}`, kind: 'search', label: 'Searched the web', detail: provider ? `${s.text} · ${provider}` : s.text, state: 'done' });
    else if (s.kind === 'read') steps.push({ id: `r${i}`, kind: 'read', label: 'Read a page', detail: provider ? `${s.text} · ${provider}` : s.text, state: 'done' });
    else if (s.kind === 'skip') steps.push({ id: `r${i}`, kind: 'skip', label: 'Skipped', detail: s.text, state: 'failed' });
    else steps.push({ id: `r${i}`, kind: 'research', label: 'Finished researching', detail: s.text, state: 'done' });
  });

  const s = a.search;
  if (s) {
    const provider = s.provider ? PROVIDER[s.provider] ?? s.provider : undefined;
    if (s.status === 'unavailable') steps.push({ id: 'search', kind: 'search', label: 'Web search not used', detail: s.message, state: 'failed' });
    else if (s.mode === 'research') {
      if (!research.some((r) => r.kind === 'done')) steps.push({ id: 'search', kind: 'research', label: 'Finished researching', detail: s.message, state: 'done' });
    } else if (s.mode === 'extract') steps.push({ id: 'search', kind: 'read', label: 'Read the linked page', detail: s.cached ? 'from cache' : provider, state: 'done' });
    else
      steps.push({
        id: 'search',
        kind: 'search',
        label: 'Searched the web',
        detail: [s.query, s.cached ? 'from cache' : provider].filter(Boolean).join(' · ') || undefined,
        state: 'done',
      });
  } else if (research.length && running) {
    steps.push({ id: 'researching', kind: 'research', label: 'Researching', state: 'active' });
  }

  const c = a.context;
  if (c) {
    if (c.knowledge) steps.push({ id: 'kb', kind: 'knowledge', label: 'Searched the knowledge base', detail: `${plural(c.knowledge, 'excerpt')} used`, state: 'done' });
    if (c.documents) steps.push({ id: 'docs', kind: 'documents', label: 'Read your documents', detail: `${plural(c.documents, 'excerpt')} used`, state: 'done' });
    if (c.memories) steps.push({ id: 'mem', kind: 'memory', label: 'Recalled your memories', detail: plural(c.memories, 'memory', 'memories'), state: 'done' });
    if (c.conversations) steps.push({ id: 'chats', kind: 'history', label: 'Checked earlier chats', detail: plural(c.conversations, 'chat'), state: 'done' });
  }

  const images = a.imageCount ?? 0;
  if (a.imageStage || images) {
    const at = images ? IMAGE_STAGES.length : IMAGE_STAGES.findIndex((x) => x.stage === a.imageStage);
    IMAGE_STAGES.forEach((x, i) => {
      const state: StepState = i < at ? 'done' : i === at ? (running ? 'active' : 'failed') : 'pending';
      // a finished reply without its picture: only the stages that ran are listed
      if (state === 'pending' && !running) return;
      steps.push({ id: `img-${x.stage}`, kind: 'image', label: state === 'done' ? x.done : x.active, state });
    });
  } else if (steps.length && a.hasContent) {
    steps.push({ id: 'write', kind: 'write', label: running ? 'Writing the answer' : 'Wrote the answer', state: running ? 'active' : 'done' });
  }

  // a reply that failed or was stopped: the step that was running did not finish
  if (!running && (a.status === 'error' || a.status === 'stopped')) {
    for (const st of steps) if (st.state === 'active') st.state = 'failed';
  }
  return steps;
}

/** One line for the collapsed panel. */
export function activitySummary(steps: ActivityStep[]): string {
  const active = steps.find((s) => s.state === 'active');
  if (active) return `${active.label}…`;
  const failed = steps.filter((s) => s.state === 'failed' && s.kind !== 'skip');
  const done = steps.filter((s) => s.state === 'done' && s.kind !== 'write');
  if (!done.length && failed.length) return failed[0].label;
  const searches = steps.filter((s) => s.kind === 'search' && s.state === 'done').length;
  const reads = steps.filter((s) => s.kind === 'read' && s.state === 'done').length;
  const parts: string[] = [];
  if (steps.some((s) => s.kind === 'image' && s.state === 'done' && s.id === 'img-generating')) parts.push('Created an image');
  if (searches) parts.push(searches > 1 ? `Searched the web ${searches} times` : 'Searched the web');
  if (reads) parts.push(`read ${plural(reads, 'page')}`);
  if (steps.some((s) => s.kind === 'documents')) parts.push('read your documents');
  if (steps.some((s) => s.kind === 'knowledge')) parts.push('used the knowledge base');
  if (!parts.length) return `${plural(steps.length, 'step')}`;
  const text = parts.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
