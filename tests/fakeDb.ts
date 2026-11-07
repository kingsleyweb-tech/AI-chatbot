import { SERVER_TIME, type FsDoc, type Write } from '../server/firestore.js';
import type { Firestore } from '../server/firestore.js';

/** In-memory stand-in for the server Firestore client (enough for unit tests). */
export class FakeDb {
  docs = new Map<string, Record<string, unknown>>();
  reads = 0;
  denyPrefix: string[] = [];

  private check(path: string) {
    if (this.denyPrefix.some((p) => path.startsWith(p))) throw Object.assign(new Error('forbidden'), { status: 403 });
  }
  private clean(data: object): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) out[k] = v === SERVER_TIME ? new Date().toISOString() : v;
    return out;
  }
  async get<T>(path: string): Promise<FsDoc<T> | null> {
    this.check(path);
    this.reads++;
    const d = this.docs.get(path);
    return d ? { id: path.split('/').pop()!, path, data: structuredClone(d) as T } : null;
  }
  async list<T>(
    coll: string,
    opts: { orderBy?: string; direction?: 'ASCENDING' | 'DESCENDING'; limit?: number; where?: [string, string, unknown][] } = {},
  ): Promise<FsDoc<T>[]> {
    this.check(coll);
    const depth = coll.split('/').length + 1;
    let rows = [...this.docs.entries()]
      .filter(([p]) => p.startsWith(coll + '/') && p.split('/').length === depth)
      .filter(([, d]) => (opts.where ?? []).every(([f, op, v]) => op === 'EQUAL' && d[f] === v))
      .map(([p, d]) => ({ id: p.split('/').pop()!, path: p, data: structuredClone(d) as T }));
    if (opts.orderBy) {
      const f = opts.orderBy;
      rows.sort((a, b) => ((a.data as Record<string, number>)[f] > (b.data as Record<string, number>)[f] ? 1 : -1) * (opts.direction === 'DESCENDING' ? -1 : 1));
    }
    if (opts.limit) rows = rows.slice(0, opts.limit);
    this.reads += Math.max(1, rows.length);
    return rows;
  }
  async set(path: string, data: object, merge = false) {
    await this.commit([{ op: 'set', path, data, merge }]);
  }
  async delete(path: string) {
    await this.commit([{ op: 'delete', path }]);
  }
  async commit(writes: Write[]) {
    for (const w of writes) {
      this.check(w.path);
      if (w.op === 'delete') this.docs.delete(w.path);
      else if (w.op === 'set') this.docs.set(w.path, w.merge ? { ...(this.docs.get(w.path) ?? {}), ...this.clean(w.data) } : this.clean(w.data));
      else {
        const d = { ...(this.docs.get(w.path) ?? {}), ...this.clean(w.data ?? {}) };
        for (const [k, n] of Object.entries(w.increments)) d[k] = ((d[k] as number) ?? 0) + n;
        this.docs.set(w.path, d);
      }
    }
  }
  /** paths under a prefix */
  under(prefix: string) {
    return [...this.docs.keys()].filter((p) => p.startsWith(prefix));
  }
  asFirestore() {
    return this as unknown as Firestore;
  }
}
