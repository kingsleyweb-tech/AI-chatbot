import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { USER_COLLECTIONS } from '../server/account/lifecycle.js';

/**
 * Permanent deletion removes the collections in USER_COLLECTIONS. Every
 * collection the rules allow under users/{uid} must be in that list, or a
 * purge would leave data behind.
 */
describe('USER_COLLECTIONS', () => {
  it('covers every collection the rules allow under users/{uid}', () => {
    const rules = readFileSync('firebase/firestore.rules', 'utf8');
    const start = rules.indexOf('match /users/{uid}');
    const block = rules.slice(start, rules.indexOf('match /accessRequests/', start));
    const named = [...block.matchAll(/match \/([A-Za-z]+)\/\{/g)].map((m) => m[1]).filter((n) => n !== 'users');
    const listed = [...block.matchAll(/\b(?:sub|collection) in \[([^\]]+)\]/g)].flatMap((m) => [...m[1].matchAll(/'([A-Za-z]+)'/g)].map((x) => x[1]));
    const allowed = new Set([...named, ...listed]);
    expect(allowed.size).toBeGreaterThan(10);
    for (const name of allowed) expect(USER_COLLECTIONS, `missing ${name}`).toContain(name);
  });
});
