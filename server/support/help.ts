/**
 * Administrator-managed Help Centre articles: helpArticles/{id}.
 * Approved users read them directly (firestore.rules); only the server writes,
 * after checking that the caller is an administrator.
 */
import { recordAdminAction } from '../account/events.js';
import type { Firestore } from '../firestore.js';
import { HttpError } from '../http.js';
import { HELP_ARTICLES } from '../shared/help.js';
import type { AdminActor } from './reports.js';

export const ARTICLE_ID = /^[a-z0-9][a-z0-9-]{1,59}$/;

export interface ArticleInput {
  id: string;
  title: string;
  category: string;
  summary: string;
  body: string;
  keywords?: string[];
}

export async function saveArticle(db: Firestore, actor: AdminActor, a: ArticleInput, now = Date.now()) {
  if (!ARTICLE_ID.test(a.id)) throw new HttpError(400, 'bad_id', 'Use lowercase letters, numbers and hyphens for the article id.');
  const builtIn = HELP_ARTICLES.some((x) => x.id === a.id);
  await db.set(`helpArticles/${a.id}`, {
    id: a.id,
    title: a.title.trim(),
    category: a.category.trim(),
    summary: a.summary.trim(),
    body: a.body.trim(),
    keywords: (a.keywords ?? []).map((k) => k.trim().toLowerCase()).filter(Boolean).slice(0, 20),
    hidden: false,
    custom: !builtIn,
    updatedAt: now,
    updatedBy: actor.email,
  });
  await recordAdminAction(db, { action: 'help_article_saved', adminUid: actor.uid, adminEmail: actor.email, targetUid: '-', targetEmail: null, detail: a.id });
}

/** Built-in articles are hidden (an override), custom ones are deleted. Restoring a built-in removes the override. */
export async function removeArticle(db: Firestore, actor: AdminActor, id: string, mode: 'remove' | 'restore', now = Date.now()) {
  if (!ARTICLE_ID.test(id)) throw new HttpError(400, 'bad_id', 'Unknown article.');
  const builtIn = HELP_ARTICLES.some((x) => x.id === id);
  if (mode === 'restore' || !builtIn) await db.delete(`helpArticles/${id}`);
  else await db.set(`helpArticles/${id}`, { id, hidden: true, updatedAt: now, updatedBy: actor.email });
  await recordAdminAction(db, { action: 'help_article_deleted', adminUid: actor.uid, adminEmail: actor.email, targetUid: '-', targetEmail: null, detail: `${mode} ${id}` });
}
