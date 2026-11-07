/**
 * Minimal Firestore REST client that acts *as the signed-in user*.
 *
 * Every call forwards the user's Firebase ID token, so Firestore Security
 * Rules are enforced for server-side reads and writes exactly as they are
 * for the browser. No service-account credentials are required.
 */
import { env } from './env.js';
import { HttpError } from './http.js';

type FsValue =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { timestampValue: string }
  | { stringValue: string }
  | { arrayValue: { values?: FsValue[] } }
  | { mapValue: { fields?: Record<string, FsValue> } };

export type Fields = Record<string, FsValue>;
export interface FsDoc<T = Record<string, unknown>> {
  id: string;
  path: string;
  data: T;
}

/** Marker for server timestamps in writes. */
export const SERVER_TIME = Symbol('serverTime');

export function encodeValue(v: unknown): FsValue {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (typeof v === 'string') return { stringValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === 'object') return { mapValue: { fields: encodeFields(v as object) } };
  throw new Error(`Cannot encode value of type ${typeof v}`);
}

export function encodeFields(obj: object): Fields {
  const out: Fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === SERVER_TIME) continue;
    out[k] = encodeValue(v);
  }
  return out;
}

export function decodeValue(v: FsValue): unknown {
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('stringValue' in v) return v.stringValue;
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(decodeValue);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields ?? {});
  return null;
}

export function decodeFields(fields: Fields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = decodeValue(v);
  return out;
}

function serverTimeFields(obj: object): string[] {
  return Object.entries(obj)
    .filter(([, v]) => v === SERVER_TIME)
    .map(([k]) => k);
}

/** Backtick-quote a field path segment when it is not a simple identifier. */
export function fieldPath(...segments: string[]): string {
  return segments.map((s) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s) ? s : '`' + s.replace(/`/g, '\\`') + '`')).join('.');
}

export type Write =
  | { op: 'set'; path: string; data: object; merge?: boolean }
  | { op: 'delete'; path: string }
  | { op: 'increment'; path: string; increments: Record<string, number>; data?: object };

export class Firestore {
  private base: string;
  private dbRoot: string;

  constructor(
    private token: string,
    projectId = env().projectId,
  ) {
    if (!projectId) throw new HttpError(500, 'config', 'FIREBASE_PROJECT_ID is not configured.');
    this.dbRoot = `projects/${projectId}/databases/(default)/documents`;
    const emulator = env().firestoreEmulator;
    const host = emulator ? `http://${emulator}` : 'https://firestore.googleapis.com';
    this.base = `${host}/v1/${this.dbRoot}`;
  }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(url, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
        ...init.headers,
      },
      signal: init.signal ?? AbortSignal.timeout(15_000),
    });
    return res;
  }

  private async fail(res: Response, what: string): Promise<never> {
    const body = await res.text().catch(() => '');
    if (res.status === 403) throw new HttpError(403, 'forbidden', `Access denied (${what}).`);
    if (res.status === 401) throw new HttpError(401, 'invalid_token', 'Session expired.');
    console.error(`[firestore] ${what} failed: ${res.status} ${body.slice(0, 300)}`);
    throw new HttpError(502, 'firestore_error', `Database request failed (${what}).`);
  }

  async get<T = Record<string, unknown>>(path: string): Promise<FsDoc<T> | null> {
    const res = await this.request(`${this.base}/${path}`);
    if (res.status === 404) return null;
    if (!res.ok) return this.fail(res, `get ${path.split('/')[0]}`);
    const doc = (await res.json()) as { name: string; fields?: Fields };
    return this.toDoc<T>(doc);
  }

  private toDoc<T>(doc: { name: string; fields?: Fields }): FsDoc<T> {
    const path = doc.name.slice(this.dbRoot.length + 1);
    return { id: path.split('/').pop()!, path, data: decodeFields(doc.fields ?? {}) as T };
  }

  /** List a collection (optionally ordered). */
  async list<T = Record<string, unknown>>(
    collectionPath: string,
    opts: { orderBy?: string; direction?: 'ASCENDING' | 'DESCENDING'; limit?: number; where?: [string, string, unknown][] } = {},
  ): Promise<FsDoc<T>[]> {
    const parts = collectionPath.split('/');
    const collectionId = parts.pop()!;
    const parent = parts.length ? `/${parts.join('/')}` : '';
    const structuredQuery: Record<string, unknown> = { from: [{ collectionId }] };
    if (opts.where?.length) {
      const filters = opts.where.map(([field, op, value]) => ({
        fieldFilter: { field: { fieldPath: field }, op, value: encodeValue(value) },
      }));
      structuredQuery.where =
        filters.length === 1 ? filters[0] : { compositeFilter: { op: 'AND', filters } };
    }
    if (opts.orderBy) {
      structuredQuery.orderBy = [
        { field: { fieldPath: opts.orderBy }, direction: opts.direction ?? 'ASCENDING' },
      ];
    }
    if (opts.limit) structuredQuery.limit = opts.limit;
    const res = await this.request(`${this.base}${parent}:runQuery`, {
      method: 'POST',
      body: JSON.stringify({ structuredQuery }),
    });
    if (!res.ok) return this.fail(res, `query ${collectionId}`);
    const rows = (await res.json()) as { document?: { name: string; fields?: Fields } }[];
    return rows.filter((r) => r.document).map((r) => this.toDoc<T>(r.document!));
  }

  async set(path: string, data: object, merge = false): Promise<void> {
    await this.commit([{ op: 'set', path, data, merge }]);
  }

  async delete(path: string): Promise<void> {
    await this.commit([{ op: 'delete', path }]);
  }

  /** Atomic batch of writes (max 500). */
  async commit(writes: Write[]): Promise<void> {
    if (!writes.length) return;
    for (let i = 0; i < writes.length; i += 450) {
      const chunk = writes.slice(i, i + 450).map((w) => this.toWrite(w));
      const res = await this.request(`${this.base}:commit`, {
        method: 'POST',
        body: JSON.stringify({ writes: chunk }),
      });
      if (!res.ok) await this.fail(res, 'commit');
    }
  }

  private toWrite(w: Write): object {
    const name = `${this.dbRoot}/${w.path}`;
    if (w.op === 'delete') return { delete: name };
    if (w.op === 'increment') {
      const data = w.data ?? {};
      const fields = encodeFields(data);
      return {
        update: { name, fields },
        updateMask: { fieldPaths: Object.keys(fields).map((k) => fieldPath(k)) },
        updateTransforms: [
          ...serverTimeFields(data).map((f) => ({ fieldPath: fieldPath(f), setToServerValue: 'REQUEST_TIME' })),
          ...Object.entries(w.increments).map(([f, n]) => ({
            fieldPath: f,
            increment: Number.isInteger(n) ? { integerValue: String(n) } : { doubleValue: n },
          })),
        ],
      };
    }
    const fields = encodeFields(w.data);
    const write: Record<string, unknown> = { update: { name, fields } };
    if (w.merge) write.updateMask = { fieldPaths: Object.keys(fields).map((k) => fieldPath(k)) };
    const times = serverTimeFields(w.data);
    if (times.length) {
      write.updateTransforms = times.map((f) => ({ fieldPath: fieldPath(f), setToServerValue: 'REQUEST_TIME' }));
    }
    return write;
  }
}
