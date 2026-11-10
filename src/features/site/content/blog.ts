/**
 * Blog posts. Each one describes a feature that is live in the app, as it
 * works today. Cover photos are credited Unsplash photographs (photos.ts).
 */
import { PHOTOS, type Photo } from './photos.js';

export interface BlogPost {
  slug: string;
  title: string;
  excerpt: string;
  category: 'Product' | 'Guides' | 'Behind the build';
  date: string; // ISO
  author: string;
  image: Photo;
  body: string;
}

export const BLOG_CATEGORIES = ['Product', 'Guides', 'Behind the build'] as const;

export const POSTS: BlogPost[] = [
  {
    slug: 'why-sources-matter',
    title: 'Why every web answer in Atlas AI shows its sources',
    excerpt: 'An answer is only as good as what it is built on. Here is how Atlas AI decides when to search, and why the Sources button exists.',
    category: 'Product',
    date: '2026-11-09',
    author: 'Atlas AI',
    image: PHOTOS.blogSources,
    body: `Language models are good at sounding right. That is exactly why we wanted every answer that uses the web to show where it came from.

## Search only when it helps

Most questions do not need the web. "Explain recursion" or "rewrite this paragraph" are answered directly, which is faster and uses none of the search allowance. When a question depends on something that changes, such as news, prices, scores or opening hours, Atlas searches first.

## Sources you can open

Web answers carry a **Sources** button with the logos of the sites used. Open it and you see every source with its site and, where known, its date. Numbers in the answer point back to them.

## Dates, checked

For news, a date is not taken on trust. Atlas compares the feed, the search provider and the page address, and marks each date as confirmed, reported or unknown. Old stories are not presented as new.

## What this does not do

Sources make answers checkable, not infallible. A model can still misread a page. For anything important, open the source.`,
  },
  {
    slug: 'getting-more-from-deep-research',
    title: 'Getting more from Deep Research',
    excerpt: 'Five practical ways to ask for a research report that is focused, current and easy to check.',
    category: 'Guides',
    date: '2026-11-09',
    author: 'Atlas AI',
    image: PHOTOS.blogResearch,
    body: `Deep Research runs several searches, reads a selection of pages and writes a structured report with numbered sources. A few habits make the result much better.

## 1. Say who the report is for

"For a first-year student" and "for a procurement manager" lead to very different reports.

## 2. Name the scope

Give a region, a time range or a list of options to compare. "Solar inverters for small offices in Ghana, 2025 to 2026" beats "solar inverters".

## 3. Ask for a format

A comparison table, a one-page summary or a list of risks. Atlas follows the shape you ask for.

## 4. Follow up in the same conversation

The context is kept, so "now focus on the cheapest two" works without repeating yourself.

## 5. Open the key sources

The report links every claim it can. Read the ones your decision depends on.`,
  },
  {
    slug: 'building-voice-mode',
    title: 'Building Voice Mode: talking with an assistant that listens',
    excerpt: 'Turn-taking, interruptions and echo: what it took to make a spoken conversation with Atlas AI feel natural.',
    category: 'Behind the build',
    date: '2026-11-09',
    author: 'Atlas AI',
    image: PHOTOS.blogVoice,
    body: `Typing has natural turns: you press send. Speaking does not. Voice Mode had to work out when you are finished, when you want to interrupt and when a sound is just the room.

## One open microphone

Voice Mode keeps a single microphone open with echo cancellation and noise suppression. A voice activity detector separates speech from background sound and notices the pause at the end of a turn.

## Speaking while writing

Waiting for a full reply before speaking feels slow. Atlas speaks each sentence as soon as it is written, so the answer starts almost at once.

## Interruptions that feel human

While Atlas talks, the microphone stays open. Speech that is clearly yours, louder than Atlas's own echo and sustained, lowers its voice straight away. When the words are recognised as a real phrase, the reply stops and your new message is sent. Coughs, distant voices and Atlas's own words do not count.

## Still a conversation

Everything said in Voice Mode is saved in the conversation like typed messages, so you can scroll back, switch to text or share the thread.`,
  },
];

export function readingMinutes(text: string): number {
  return Math.max(1, Math.round(text.split(/\s+/).length / 220));
}
