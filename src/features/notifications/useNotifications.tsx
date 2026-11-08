import { collection, doc, limit, onSnapshot, orderBy, query, updateDoc } from 'firebase/firestore';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { db } from '@/lib/firebase';
import { useAuth, useUid } from '@/state/auth';
import type { AppNotification, NotificationKind } from '@shared/support';
import { supportApi } from '../support/api';

export interface NotificationItem extends AppNotification {
  scope: 'user' | 'admin';
}

interface Ctx {
  items: NotificationItem[];
  unread: number;
  markRead: (items: NotificationItem[]) => Promise<void>;
}
const NotificationsCtx = createContext<Ctx>({ items: [], unread: 0, markRead: async () => undefined });
export const useNotifications = () => useContext(NotificationsCtx);

interface RawUser {
  kind: NotificationKind;
  title: string;
  body: string;
  link: string;
  ref: string;
  count?: number;
  at: number;
  read?: boolean;
  readBy?: string[];
}

/**
 * Live in-app notifications: the user's own (support replies, status changes)
 * and, for administrators, the shared administrator notifications. The server
 * writes them; one document per report and kind, so there are no duplicates.
 * Listeners stay quiet when the rules have not been published yet.
 */
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const uid = useUid();
  const { admin } = useAuth();
  const [mine, setMine] = useState<NotificationItem[]>([]);
  const [admins, setAdmins] = useState<NotificationItem[]>([]);
  const seen = useRef(new Map<string, number>());

  useEffect(() => {
    const q = query(collection(db, 'users', uid, 'notifications'), orderBy('at', 'desc'), limit(50));
    return onSnapshot(
      q,
      (snap) => setMine(snap.docs.map((d) => { const v = d.data() as RawUser; return { ...v, id: d.id, count: v.count ?? 1, read: v.read === true, scope: 'user' as const }; })),
      () => setMine([]),
    );
  }, [uid]);

  useEffect(() => {
    if (!admin) {
      setAdmins([]);
      return;
    }
    const q = query(collection(db, 'adminNotifications'), orderBy('at', 'desc'), limit(50));
    return onSnapshot(
      q,
      (snap) => setAdmins(snap.docs.map((d) => { const v = d.data() as RawUser; return { ...v, id: d.id, count: v.count ?? 1, read: (v.readBy ?? []).includes(uid), scope: 'admin' as const }; })),
      () => setAdmins([]),
    );
  }, [admin, uid]);

  const items = useMemo(() => [...mine, ...admins].sort((a, b) => b.at - a.at), [mine, admins]);

  // Tell open report pages that something new arrived for them.
  useEffect(() => {
    const first = seen.current.size === 0;
    const changed: string[] = [];
    for (const n of items) {
      const key = `${n.scope}:${n.id}`;
      if (seen.current.get(key) !== n.at) {
        if (!first) changed.push(n.ref);
        seen.current.set(key, n.at);
      }
    }
    if (changed.length) window.dispatchEvent(new CustomEvent('atlas:notified', { detail: changed }));
  }, [items]);

  const markRead = useCallback(
    async (list: NotificationItem[]) => {
      const unread = list.filter((n) => !n.read);
      const own = unread.filter((n) => n.scope === 'user');
      const shared = unread.filter((n) => n.scope === 'admin').map((n) => n.id);
      await Promise.all([
        ...own.map((n) => updateDoc(doc(db, 'users', uid, 'notifications', n.id), { read: true }).catch(() => undefined)),
        shared.length ? supportApi.adminNotificationsRead(shared).catch(() => undefined) : Promise.resolve(),
      ]);
      // admin notifications are read through the server; reflect it at once
      if (shared.length) setAdmins((a) => a.map((n) => (shared.includes(n.id) ? { ...n, read: true } : n)));
    },
    [uid],
  );

  const value = useMemo(() => ({ items, unread: items.filter((n) => !n.read).length, markRead }), [items, markRead]);
  return <NotificationsCtx.Provider value={value}>{children}</NotificationsCtx.Provider>;
}

/** Mark the notifications of one report read while its page is open. */
export function useMarkRead(ref: string, scope: 'user' | 'admin' = 'user') {
  const { items, markRead } = useNotifications();
  useEffect(() => {
    const unread = items.filter((n) => n.ref === ref && n.scope === scope && !n.read);
    if (unread.length) void markRead(unread);
  }, [items, markRead, ref, scope]);
}
