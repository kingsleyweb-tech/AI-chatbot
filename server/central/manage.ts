/**
 * Administration of central knowledge. Every action checks the caller's role on the server, and
 * every change is written to the audit log. Records are never deleted automatically; permanent
 * deletion is a separate, confirmed action that needs the delete permission.
 */
import type { Firestore } from '../firestore.js';
import { HttpError } from '../http.js';
import { tierOf } from '../news/sources.js';
import { assess, compareExisting, computeConfidence, discoverFromUrl, jaccard, listAll, listCategories, normalizeForHash, numbersDiffer, recordTerms, submitCandidate, vectorFor, verifySource } from './pipeline.js';
import { invalidateCentralCache } from './retrieve.js';
import { screenCandidate, sanitize } from './screen.js';
import { audit, AUDIT, bump, CATEGORIES, centralDb, DISCOVERY, hash, loadConfig, newId, RECORDS, requirePermission, roleFor, saveConfig, STATS, TOPICS, type Role } from './store.js';
import { STATUSES, type Actor, type Category, type CentralConfig, type Flag, type KRecord, type RecordStatus } from './types.js';

export interface CentralCaller {
  db: Firestore;
  user: { uid: string; email: string | null; emailVerified?: boolean };
  admin: boolean;
}

/* ------------------------------ rate limit (per instance) ------------------------------ */

const recent = new Map<string, number[]>();
/** Tests: forget recent actions. */
export function resetCentralThrottle() {
  recent.clear();
}
function throttle(uid: string, max = 20, windowMs = 60_000) {
  const now = Date.now();
  const list = (recent.get(uid) ?? []).filter((t) => now - t < windowMs);
  if (list.length >= max) throw new HttpError(429, 'rate_limited', 'Too many knowledge actions at once. Wait a minute and try again.');
  list.push(now);
  recent.set(uid, list);
  if (recent.size > 500) recent.delete(recent.keys().next().value!);
}

/* ------------------------------ views ------------------------------ */

type Row = Omit<KRecord, 'vector' | 'terms'> & { id: string; hasVector: boolean };

function view(id: string, r: KRecord): Row {
  const { vector, terms: _terms, ...rest } = r;
  void _terms;
  return { id, ...rest, hasVector: Boolean(vector) };
}

const short = (r: Row) => ({ ...r, content: r.content.slice(0, 280) });

export interface ListQuery {
  q?: string;
  status?: RecordStatus | 'ALL';
  categoryId?: string | null;
  flag?: Flag | null;
  origin?: string | null;
  sort?: 'updated' | 'created' | 'confidence' | 'title';
  dir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export function filterRecords(rows: { id: string; data: KRecord }[], q: ListQuery) {
  const needle = q.q?.trim().toLowerCase();
  let out = rows.filter(
    (r) =>
      (!q.status || q.status === 'ALL' || r.data.status === q.status) &&
      (q.categoryId === undefined || q.categoryId === null || (q.categoryId === '' ? !r.data.categoryId : r.data.categoryId === q.categoryId)) &&
      (!q.flag || r.data.flags?.includes(q.flag)) &&
      (!q.origin || r.data.origin === q.origin) &&
      (!needle || r.data.title.toLowerCase().includes(needle) || r.data.content.toLowerCase().includes(needle) || r.data.tags?.some((t) => t.includes(needle)) || r.id === needle),
  );
  const dir = q.dir === 'asc' ? 1 : -1;
  const key = q.sort ?? 'updated';
  out = out.sort((a, b) => {
    const va = key === 'title' ? a.data.title.toLowerCase() : key === 'confidence' ? a.data.confidence : key === 'created' ? a.data.createdAt : a.data.updatedAt;
    const vb = key === 'title' ? b.data.title.toLowerCase() : key === 'confidence' ? b.data.confidence : key === 'created' ? b.data.createdAt : b.data.updatedAt;
    return (va > vb ? 1 : va < vb ? -1 : 0) * dir;
  });
  const pageSize = Math.min(100, Math.max(5, q.pageSize ?? 25));
  const page = Math.max(1, q.page ?? 1);
  return { total: out.length, page, pageSize, rows: out.slice((page - 1) * pageSize, page * pageSize).map((r) => short(view(r.id, r.data))) };
}

/* ------------------------------ intelligence ------------------------------ */

export function intelligence(rows: { id: string; data: KRecord }[], topics: { id: string; data: { terms?: string[]; count?: number; misses?: number; covered?: number; lastAt?: number } }[], categories: { id: string; name: string }[], now = Date.now()) {
  const live = rows.filter((r) => r.data.status !== 'REJECTED' && r.data.status !== 'ARCHIVED').slice(0, 1500);
  const pairs: { a: string; b: string; titleA: string; titleB: string; similarity: number }[] = [];
  const conflicts: typeof pairs = [];
  const termsOf = live.map((r) => (r.data.terms ? r.data.terms.split(' ') : []));
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const sim = jaccard(termsOf[i], termsOf[j]);
      if (sim < 0.35) continue;
      const p = { a: live[i].id, b: live[j].id, titleA: live[i].data.title, titleB: live[j].data.title, similarity: Math.round(sim * 100) / 100 };
      if (sim >= 0.6) pairs.push(p);
      if (live[i].data.status === 'VERIFIED' && live[j].data.status === 'VERIFIED' && numbersDiffer(live[i].data.content, live[j].data.content)) conflicts.push(p);
    }
  }
  const verified = rows.filter((r) => r.data.status === 'VERIFIED');
  const outdated = verified
    .filter((r) => (r.data.reviewAt != null && r.data.reviewAt < now) || r.data.sources?.some((s) => s.reachable === false))
    .map((r) => ({ id: r.id, title: r.data.title, reviewAt: r.data.reviewAt, unreachable: r.data.sources.filter((s) => s.reachable === false).length }));
  const frequent = topics
    .map((t) => ({ terms: t.data.terms ?? [], count: t.data.count ?? 0, misses: t.data.misses ?? 0, covered: t.data.covered ?? 0, lastAt: t.data.lastAt ?? null }))
    .sort((a, b) => b.count - a.count);
  const used = new Set(rows.map((r) => r.data.categoryId).filter(Boolean));
  return {
    frequentTopics: frequent.slice(0, 30),
    gaps: frequent.filter((t) => t.misses >= 2 && t.covered / Math.max(1, t.count) < 0.3).slice(0, 30),
    duplicates: pairs.sort((x, y) => y.similarity - x.similarity).slice(0, 50),
    conflicts: conflicts.slice(0, 50),
    outdated: outdated.slice(0, 100),
    lowConfidence: verified.filter((r) => r.data.confidence < 0.5).map((r) => ({ id: r.id, title: r.data.title, confidence: r.data.confidence })).slice(0, 50),
    emptyCategories: categories.filter((c) => !used.has(c.id)).map((c) => ({ id: c.id, name: c.name })),
  };
}

/* ------------------------------ helpers ------------------------------ */

async function getRecord(db: Firestore, id: string): Promise<KRecord> {
  const d = await db.get<KRecord>(`${RECORDS}/${id}`);
  if (!d) throw new HttpError(404, 'not_found', 'This knowledge record does not exist.');
  return d.data;
}

function reviewDays(cfg: CentralConfig, categoryId: string | null) {
  return (categoryId && cfg.categoryReviewDays[categoryId]) || cfg.reviewDays;
}

async function save(db: Firestore, id: string, r: KRecord, actor: Actor) {
  r.updatedAt = Date.now();
  r.updatedBy = actor.uid;
  r.version = (r.version ?? 1) + 1;
  r.confidence = computeConfidence(r);
  await db.set(`${RECORDS}/${id}`, r);
  invalidateCentralCache();
}

const without = (flags: Flag[], ...drop: Flag[]) => flags.filter((f) => !drop.includes(f));

/* ------------------------------ dispatcher ------------------------------ */

export type CentralAction =
  | { action: 'kcRole' }
  | { action: 'kcOverview' }
  | ({ action: 'kcList' } & ListQuery)
  | { action: 'kcGet'; id: string }
  | { action: 'kcSubmit'; title: string; content: string; sources: string[]; categoryId?: string | null; tags?: string[] }
  | { action: 'kcDiscoverUrl'; url: string; categoryId?: string | null }
  | { action: 'kcUpdate'; id: string; title?: string; content?: string; tags?: string[]; categoryId?: string | null; addSources?: string[]; removeSources?: string[] }
  | { action: 'kcStatus'; id: string; to: 'approve' | 'reject' | 'archive' | 'restore'; reason?: string; acknowledge?: boolean }
  | { action: 'kcDelete'; id: string; confirm: true }
  | { action: 'kcMerge'; targetId: string; sourceId: string }
  | { action: 'kcReverify'; id: string }
  | { action: 'kcCategories' }
  | { action: 'kcCategorySave'; id?: string; name: string; description?: string; reviewDays?: number | null }
  | { action: 'kcCategoryDelete'; id: string; moveTo?: string | null; confirm: true }
  | { action: 'kcCategoryMerge'; fromId: string; intoId: string }
  | { action: 'kcAudit'; limit?: number; recordId?: string }
  | { action: 'kcIntelligence' }
  | { action: 'kcSettings' }
  | { action: 'kcSettingsSave'; settings: Partial<CentralConfig> };

export async function handleCentral(caller: CentralCaller, b: CentralAction): Promise<Record<string, unknown>> {
  const db = await centralDb(caller.db);
  const cfg = await loadConfig(db, b.action === 'kcRole' || b.action === 'kcSettings');
  const role: Role = roleFor(caller.user, caller.admin, cfg);
  const actor: Actor = { uid: caller.user.uid, email: caller.user.email };
  const now = Date.now();

  if (b.action === 'kcRole') {
    return { role: role.kind, permissions: role.kind === 'super' ? 'all' : role.kind === 'knowledge_admin' ? role.permissions : [] };
  }
  requirePermission(role, 'view');

  switch (b.action) {
    case 'kcOverview': {
      const [rows, categories, stats] = await Promise.all([listAll(db), listCategories(db), db.list<Record<string, unknown>>(STATS, { orderBy: 'day', direction: 'DESCENDING', limit: 30 }).catch(() => [])]);
      const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<RecordStatus, number>;
      const byCategory: Record<string, number> = {};
      const flags: Record<string, number> = {};
      let confSum = 0;
      for (const r of rows) {
        byStatus[r.data.status]++;
        const c = r.data.categoryId ?? '';
        byCategory[c] = (byCategory[c] ?? 0) + 1;
        for (const f of r.data.flags ?? []) flags[f] = (flags[f] ?? 0) + 1;
        if (r.data.status === 'VERIFIED') confSum += r.data.confidence;
      }
      const days = stats.filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s.data.day)));
      const sum = (k: string, n = 30) => days.slice(0, n).reduce((t, d) => t + (typeof d.data[k] === 'number' ? (d.data[k] as number) : 0), 0);
      const maint = stats.find((s) => s.id === 'maintenance')?.data ?? (await db.get(`${STATS}/maintenance`).catch(() => null))?.data ?? null;
      return {
        total: rows.length,
        byStatus,
        byCategory: categories.map((c) => ({ id: c.id, name: c.name, count: byCategory[c.id] ?? 0 })).concat(byCategory[''] ? [{ id: '', name: 'Uncategorised', count: byCategory[''] }] : []),
        flags,
        averageConfidence: byStatus.VERIFIED ? Math.round((confSum / byStatus.VERIFIED) * 100) / 100 : null,
        dueForReview: rows.filter((r) => r.data.status === 'VERIFIED' && r.data.reviewAt != null && r.data.reviewAt < now).length,
        last30Days: { submitted: sum('submitted'), approved: sum('approved'), rejected: sum('rejected'), refused: sum('refused'), duplicates: sum('duplicates'), retrievals: sum('retrievals'), assessments: sum('assessments') },
        today: { assessments: sum('assessments', 1), cap: cfg.assessmentsDailyCap },
        maintenance: maint,
        settings: { retrievalEnabled: cfg.retrievalEnabled, discoveryFromWebSearch: cfg.discoveryFromWebSearch, topicInsights: cfg.topicInsights },
        role: role.kind,
        permissions: role.kind === 'super' ? 'all' : role.kind === 'knowledge_admin' ? role.permissions : [],
      };
    }

    case 'kcList':
      return filterRecords(await listAll(db), b);

    case 'kcGet': {
      const r = await getRecord(db, b.id);
      const dup = r.duplicateOf ? await db.get<KRecord>(`${RECORDS}/${r.duplicateOf}`).catch(() => null) : null;
      const trail = (await db.list<Record<string, unknown>>(AUDIT, { orderBy: 'at', direction: 'DESCENDING', limit: 500 }).catch(() => [])).filter((a) => a.data.recordId === b.id).map((a) => ({ id: a.id, ...a.data }));
      return { record: view(b.id, r), duplicate: dup ? { id: r.duplicateOf, title: dup.data.title, status: dup.data.status, content: dup.data.content.slice(0, 600) } : null, audit: trail.slice(0, 50) };
    }

    case 'kcSubmit': {
      requirePermission(role, 'submit');
      throttle(actor.uid);
      const res = await submitCandidate(db, { ...b, origin: 'admin' }, actor, cfg, now);
      await audit(db, { actor, action: res.ok ? 'submitted' : `submission_${res.reason}`, recordId: res.ok ? res.id : (res.existingId ?? null), detail: res.ok ? `origin admin, ${res.record.sources.length} sources` : res.messages.join(' ') });
      return res.ok ? { ok: true, id: res.id, record: view(res.id, res.record) } : res;
    }

    case 'kcDiscoverUrl': {
      requirePermission(role, 'submit');
      throttle(actor.uid, 6);
      const results = await discoverFromUrl(db, b.url, actor, cfg, { categoryId: b.categoryId ?? null, now });
      const created = results.filter((r) => r.ok) as { ok: true; id: string }[];
      await audit(db, { actor, action: 'discovered_from_url', recordId: null, detail: `${created.length} candidates from ${b.url.slice(0, 120)}` });
      return { ok: true, created: created.map((r) => r.id), skipped: results.filter((r) => !r.ok).map((r) => (r.ok ? '' : `${r.reason}: ${r.messages.join(' ')}`)) };
    }

    case 'kcUpdate': {
      requirePermission(role, 'edit');
      const r = await getRecord(db, b.id);
      const before = r.status;
      let contentChanged = false;
      if (b.title !== undefined || b.content !== undefined || b.tags !== undefined) {
        const s = screenCandidate({ title: b.title ?? r.title, content: b.content ?? r.content, tags: b.tags ?? r.tags });
        if (s.refused.length) return { ok: false, reason: 'refused', messages: s.refused };
        contentChanged = s.title !== r.title || s.content !== r.content;
        r.title = s.title;
        r.content = s.content;
        r.tags = s.tags;
        if (s.redacted.length && !r.flags.includes('pii_redacted')) r.flags.push('pii_redacted');
        r.terms = recordTerms(r.title, r.content, r.tags).join(' ');
        r.contentHash = hash(normalizeForHash(`${r.title}\n${r.content}`));
      }
      if (b.categoryId !== undefined) {
        const cats = await listCategories(db);
        if (b.categoryId && !cats.some((c) => c.id === b.categoryId)) throw new HttpError(400, 'bad_category', 'Unknown category.');
        r.categoryId = b.categoryId || null;
      }
      if (b.removeSources?.length) r.sources = r.sources.filter((s) => !b.removeSources!.includes(s.url));
      if (b.addSources?.length) {
        const fresh = [...new Set(b.addSources.filter((u) => /^https:\/\/\S{4,1990}$/.test(u) && !r.sources.some((s) => s.url === u)))].slice(0, Math.max(0, 5 - r.sources.length));
        r.sources.push(...(await Promise.all(fresh.map((u) => verifySource(u, r.terms.split(' '), now)))));
      }
      r.flags = without(r.flags, 'no_sources', 'source_unreachable', 'low_credibility');
      if (!r.sources.length) r.flags.push('no_sources');
      else {
        if (r.sources.every((s) => s.reachable === false)) r.flags.push('source_unreachable');
        if (r.sources.every((s) => s.tier === 'unknown' || s.tier === 'social')) r.flags.push('low_credibility');
      }
      // a changed fact needs a fresh decision before answers may use it again
      if (contentChanged && r.status === 'VERIFIED') {
        r.status = 'PENDING';
        r.vector = null;
        r.vectorModel = null;
      }
      await save(db, b.id, r, actor);
      await audit(db, { actor, action: 'edited', recordId: b.id, detail: `${contentChanged ? 'content changed' : 'details changed'}${before !== r.status ? `; ${before} -> ${r.status}` : ''}` });
      return { ok: true, record: view(b.id, r) };
    }

    case 'kcStatus': {
      requirePermission(role, 'review');
      const r = await getRecord(db, b.id);
      const before = r.status;
      if (b.to === 'approve') {
        if (r.status === 'VERIFIED') return { ok: true, record: view(b.id, r) };
        if (r.status !== 'PENDING') throw new HttpError(409, 'not_pending', 'Restore the record to the review queue before approving it.');
        if ((r.flags.includes('conflict_suspected') || r.flags.includes('duplicate_suspected')) && !b.acknowledge) {
          throw new HttpError(409, 'needs_acknowledgement', 'This record may duplicate or contradict verified knowledge. Compare them, then confirm the approval.');
        }
        const v = await vectorFor(r);
        r.vector = v?.vector ?? null;
        r.vectorModel = v?.model ?? null;
        r.status = 'VERIFIED';
        r.verifiedAt = now;
        r.verifiedBy = actor.uid;
        r.reviewAt = now + reviewDays(cfg, r.categoryId) * 86_400_000;
        r.rejectedReason = null;
        r.flags = without(r.flags, 'review_due');
        await bump(db, { approved: 1 }, now).catch(() => undefined);
      } else if (b.to === 'reject') {
        if (r.status !== 'PENDING' && r.status !== 'VERIFIED') throw new HttpError(409, 'bad_state', 'Only pending or verified records can be rejected.');
        r.status = 'REJECTED';
        r.rejectedReason = sanitize(b.reason ?? '', 300) || null;
        r.vector = null;
        await bump(db, { rejected: 1 }, now).catch(() => undefined);
      } else if (b.to === 'archive') {
        r.status = 'ARCHIVED';
      } else {
        // restore: back to the review queue, never straight to verified
        r.status = 'PENDING';
        r.rejectedReason = null;
      }
      await save(db, b.id, r, actor);
      await audit(db, { actor, action: b.to === 'approve' ? 'approved' : b.to === 'reject' ? 'rejected' : b.to === 'archive' ? 'archived' : 'restored', recordId: b.id, detail: `${before} -> ${r.status}${b.reason ? `; reason: ${sanitize(b.reason, 200)}` : ''}` });
      return { ok: true, record: view(b.id, r) };
    }

    case 'kcDelete': {
      requirePermission(role, 'delete');
      const r = await getRecord(db, b.id);
      await db.delete(`${RECORDS}/${b.id}`);
      invalidateCentralCache();
      await audit(db, { actor, action: 'deleted', recordId: b.id, detail: `permanently deleted (${r.status}): ${r.title.slice(0, 120)}` });
      return { ok: true };
    }

    case 'kcMerge': {
      requirePermission(role, 'edit');
      if (b.targetId === b.sourceId) throw new HttpError(400, 'same', 'Choose two different records.');
      const [t, s] = await Promise.all([getRecord(db, b.targetId), getRecord(db, b.sourceId)]);
      for (const src of s.sources) if (!t.sources.some((x) => x.url === src.url) && t.sources.length < 5) t.sources.push(src);
      t.tags = [...new Set([...t.tags, ...s.tags])].slice(0, 10);
      t.mergedFrom = [...new Set([...(t.mergedFrom ?? []), b.sourceId, ...(s.mergedFrom ?? [])])];
      t.flags = without(t.flags, 'duplicate_suspected', 'no_sources');
      if (t.duplicateOf === b.sourceId) t.duplicateOf = null;
      s.status = 'ARCHIVED';
      s.duplicateOf = b.targetId;
      s.vector = null;
      await save(db, b.targetId, t, actor);
      await save(db, b.sourceId, s, actor);
      await audit(db, { actor, action: 'merged', recordId: b.targetId, detail: `merged ${b.sourceId} into ${b.targetId}; ${b.sourceId} archived` });
      return { ok: true, record: view(b.targetId, t) };
    }

    case 'kcReverify': {
      requirePermission(role, 'review');
      throttle(actor.uid, 6);
      const r = await getRecord(db, b.id);
      const keyTerms = r.terms.split(' ');
      r.sources = await Promise.all(r.sources.map((s) => verifySource(s.url, keyTerms, now, s)));
      r.assessment = await assess(db, { title: r.title, content: r.content, sources: r.sources, categories: await listCategories(db) }, cfg, now);
      const existing = await listAll(db);
      const cmp = compareExisting(existing, { contentHash: r.contentHash, terms: keyTerms, content: r.content, categoryId: r.categoryId }, b.id);
      r.flags = without(r.flags, 'source_unreachable', 'source_unsupported', 'low_credibility', 'ai_unavailable', 'duplicate_suspected', 'conflict_suspected', 'no_sources');
      if (!r.sources.length) r.flags.push('no_sources');
      if (r.sources.length && r.sources.every((s) => !s.reachable)) r.flags.push('source_unreachable');
      if (r.sources.some((s) => s.reachable && s.supports === false)) r.flags.push('source_unsupported');
      if (r.sources.length && r.sources.every((s) => s.tier === 'unknown' || s.tier === 'social')) r.flags.push('low_credibility');
      if (r.assessment.by === 'rules') r.flags.push('ai_unavailable');
      if (cmp.near) r.flags.push('duplicate_suspected');
      if (cmp.conflict) r.flags.push('conflict_suspected');
      r.duplicateOf = cmp.near?.id ?? (cmp.exact?.id || null);
      await save(db, b.id, r, actor);
      await audit(db, { actor, action: 're_verified', recordId: b.id, detail: `assessment ${r.assessment.verdict} (${r.assessment.by}); confidence ${r.confidence}` });
      return { ok: true, record: view(b.id, r) };
    }

    case 'kcCategories': {
      const [cats, rows] = await Promise.all([listCategories(db), listAll(db)]);
      return { categories: cats.map((c) => ({ ...c, count: rows.filter((r) => r.data.categoryId === c.id).length, reviewDays: cfg.categoryReviewDays[c.id] ?? null })), uncategorised: rows.filter((r) => !r.data.categoryId).length };
    }

    case 'kcCategorySave': {
      requirePermission(role, 'categories');
      const name = sanitize(b.name, 60);
      if (name.length < 2) throw new HttpError(400, 'bad_name', 'Give the category a name.');
      const cats = await listCategories(db);
      if (cats.some((c) => c.name.toLowerCase() === name.toLowerCase() && c.id !== b.id)) throw new HttpError(409, 'exists', 'A category with this name already exists.');
      if (b.id && !cats.some((c) => c.id === b.id)) throw new HttpError(404, 'not_found', 'Unknown category.');
      const id = b.id ?? newId();
      const prev = b.id ? (await db.get<Category>(`${CATEGORIES}/${id}`))?.data : null;
      await db.set(`${CATEGORIES}/${id}`, { name, description: sanitize(b.description ?? '', 300), createdAt: prev?.createdAt ?? now, updatedAt: now } satisfies Category);
      if (b.reviewDays !== undefined && role.kind === 'super') {
        const next = { ...cfg, categoryReviewDays: { ...cfg.categoryReviewDays } };
        if (b.reviewDays) next.categoryReviewDays[id] = b.reviewDays;
        else delete next.categoryReviewDays[id];
        await saveConfig(db, next, actor);
      }
      await audit(db, { actor, action: b.id ? 'category_renamed' : 'category_created', detail: `${prev?.name && prev.name !== name ? `${prev.name} -> ` : ''}${name}` });
      return { ok: true, id };
    }

    case 'kcCategoryDelete':
    case 'kcCategoryMerge': {
      requirePermission(role, 'categories');
      const from = b.action === 'kcCategoryDelete' ? b.id : b.fromId;
      const into = b.action === 'kcCategoryDelete' ? (b.moveTo ?? null) : b.intoId;
      const cats = await listCategories(db);
      const fromCat = cats.find((c) => c.id === from);
      if (!fromCat) throw new HttpError(404, 'not_found', 'Unknown category.');
      if (into && (!cats.some((c) => c.id === into) || into === from)) throw new HttpError(400, 'bad_target', 'Choose another existing category.');
      const rows = (await listAll(db)).filter((r) => r.data.categoryId === from);
      // records keep their content and status; only their category changes
      for (let i = 0; i < rows.length; i += 400) {
        await db.commit(rows.slice(i, i + 400).map((r) => ({ op: 'set' as const, path: `${RECORDS}/${r.id}`, data: { categoryId: into, updatedAt: now, updatedBy: actor.uid }, merge: true })));
      }
      await db.delete(`${CATEGORIES}/${from}`);
      invalidateCentralCache();
      await audit(db, { actor, action: b.action === 'kcCategoryDelete' ? 'category_deleted' : 'category_merged', detail: `${fromCat.name}: ${rows.length} records moved to ${into ? (cats.find((c) => c.id === into)?.name ?? into) : 'Uncategorised'}` });
      return { ok: true, moved: rows.length };
    }

    case 'kcAudit': {
      const rows = await db.list<Record<string, unknown>>(AUDIT, { orderBy: 'at', direction: 'DESCENDING', limit: Math.min(500, b.limit ?? 200) }).catch(() => []);
      return { entries: rows.filter((r) => !b.recordId || r.data.recordId === b.recordId).map((r) => ({ id: r.id, ...r.data })) };
    }

    case 'kcIntelligence': {
      requirePermission(role, 'intelligence');
      const [rows, topics, cats] = await Promise.all([listAll(db), db.list<{ terms?: string[]; count?: number }>(TOPICS, { orderBy: 'count', direction: 'DESCENDING', limit: 200 }).catch(() => []), listCategories(db)]);
      return { ...intelligence(rows, topics, cats, now), topicInsightsEnabled: cfg.topicInsights };
    }

    case 'kcSettings':
      requirePermission(role, 'settings');
      return { settings: cfg };

    case 'kcSettingsSave': {
      requirePermission(role, 'settings');
      const next = await saveConfig(db, { ...cfg, ...b.settings }, actor);
      const changed = (Object.keys(b.settings) as (keyof CentralConfig)[]).filter((k) => JSON.stringify(cfg[k]) !== JSON.stringify(next[k]));
      await audit(db, { actor, action: 'settings_changed', detail: changed.map((k) => (k === 'admins' ? `knowledge administrators (${Object.keys(next.admins).length})` : `${k}: ${JSON.stringify(next[k]).slice(0, 60)}`)).join('; ') || 'no change' });
      invalidateCentralCache();
      return { ok: true, settings: next };
    }
  }
}

/* ------------------------------ discovery queue + maintenance ------------------------------ */

/**
 * Opt-in: remember credible public sources that answered a web-searched question, for the daily
 * job to turn into candidates. Only the address and its publisher tier are kept, never the
 * question or the conversation.
 */
export async function queueDiscovery(userDb: Firestore, urls: string[]): Promise<void> {
  const db = await centralDb(userDb);
  const cfg = await loadConfig(db);
  if (!cfg.discoveryFromWebSearch) return;
  const picked = [...new Set(urls)].filter((u) => /^https:\/\//.test(u) && ['official', 'wire', 'specialist'].includes(tierOf(u))).slice(0, 3);
  if (!picked.length) return;
  await db.commit(picked.map((url) => ({ op: 'increment' as const, path: `${DISCOVERY}/${hash(url)}`, increments: { seen: 1 }, data: { url, tier: tierOf(url), lastAt: Date.now() } })));
}

const SYSTEM_ACTOR: Actor = { uid: 'system', email: null };

/** Daily job (runs inside the existing purge cron): never deletes a record. */
export async function centralMaintenance(db: Firestore, now = Date.now()) {
  const cfg = await loadConfig(db, true);
  const rows = await listAll(db);
  let flagged = 0;
  let checked = 0;
  const due = rows.filter((r) => r.data.status === 'VERIFIED' && r.data.reviewAt != null && r.data.reviewAt < now);
  for (const r of due) {
    if (!r.data.flags.includes('review_due')) {
      await db.set(`${RECORDS}/${r.id}`, { flags: [...r.data.flags, 'review_due'] }, true);
      flagged++;
    }
  }
  // re-check the sources of up to 10 due records (free page reads)
  for (const r of due.slice(0, 10)) {
    const keyTerms = r.data.terms.split(' ');
    const sources = await Promise.all(r.data.sources.map((s) => verifySource(s.url, keyTerms, now, s)));
    const flags = without(r.data.flags.includes('review_due') ? r.data.flags : [...r.data.flags, 'review_due'], 'source_unreachable');
    if (sources.length && sources.every((s) => !s.reachable)) flags.push('source_unreachable');
    const next = { ...r.data, sources, flags };
    await db.set(`${RECORDS}/${r.id}`, { sources, flags, confidence: computeConfidence(next) }, true);
    checked++;
  }
  let discovered = 0;
  let discoveryErrors = 0;
  if (cfg.discoveryFromWebSearch && cfg.discoveryDailyCap > 0) {
    const queue = await db.list<{ url: string; seen?: number }>(DISCOVERY, { orderBy: 'seen', direction: 'DESCENDING', limit: cfg.discoveryDailyCap }).catch(() => []);
    for (const q of queue) {
      try {
        const res = await discoverFromUrl(db, q.data.url, SYSTEM_ACTOR, cfg, { origin: 'web_discovery', now });
        discovered += res.filter((x) => x.ok).length;
      } catch {
        discoveryErrors++;
      }
      // queue entries are addresses, not knowledge: processed ones are removed
      await db.delete(`${DISCOVERY}/${q.id}`).catch(() => undefined);
    }
  }
  if (flagged || checked || discovered) invalidateCentralCache();
  const summary = { at: now, reviewDue: due.length, newlyFlagged: flagged, sourcesChecked: checked, discovered, discoveryErrors };
  await db.set(`${STATS}/maintenance`, summary);
  if (discovered) await audit(db, { actor: SYSTEM_ACTOR, action: 'discovered_automatically', detail: `${discovered} candidates queued for review` });
  await bump(db, { maintenanceRuns: 1 }, now).catch(() => undefined);
  return summary;
}
