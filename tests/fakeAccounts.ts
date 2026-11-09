import type { AccountAdmin, AccountUpdate, AuthAccount } from '../server/admin.js';

/** In-memory stand-in for the Firebase Auth admin API. */
export class FakeAccounts implements AccountAdmin {
  users = new Map<string, AuthAccount & { password?: string }>();
  updates: { uid: string; change: AccountUpdate }[] = [];

  add(a: Partial<AuthAccount> & { uid: string }) {
    const acc: AuthAccount = {
      email: null,
      displayName: null,
      photoURL: null,
      emailVerified: true,
      disabled: false,
      providers: ['password'],
      createdAt: Date.parse('2026-01-01'),
      lastLoginAt: null,
      validSince: null,
      passwordUpdatedAt: null,
      claims: {},
      ...a,
    };
    this.users.set(acc.uid, acc);
    return acc;
  }
  async get(uid: string) {
    const u = this.users.get(uid);
    return u ? structuredClone(u) : null;
  }
  async getByEmail(email: string) {
    for (const u of this.users.values()) if (u.email?.toLowerCase() === email.toLowerCase()) return structuredClone(u);
    return null;
  }
  async list() {
    return [...this.users.values()].map((u) => structuredClone(u));
  }
  async update(uid: string, change: AccountUpdate) {
    const u = this.users.get(uid);
    if (!u) throw new Error('no user');
    this.updates.push({ uid, change });
    if (change.disabled !== undefined) u.disabled = change.disabled;
    if (change.emailVerified !== undefined) u.emailVerified = change.emailVerified;
    if (change.revokeSessions) u.validSince = Date.now();
    if (change.password) {
      u.password = change.password;
      u.passwordUpdatedAt = Date.now();
    }
  }
  async remove(uid: string) {
    this.users.delete(uid);
  }
  async mergeClaims(uid: string, claims: Record<string, unknown>) {
    const u = this.users.get(uid);
    if (!u) throw new Error('no user');
    for (const [k, v] of Object.entries(claims)) {
      if (v === null) delete u.claims[k];
      else u.claims[k] = v;
    }
  }
}
