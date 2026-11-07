import { onSnapshot, type DocumentReference, type Query } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { fromSnap } from './db';

/** Live Firestore query subscription. Pass `null` to disable. */
export function useQuery<T>(q: Query | null, deps: unknown[]): { data: T[]; loading: boolean; error: string | null } {
  const [state, setState] = useState<{ data: T[]; loading: boolean; error: string | null }>({
    data: [],
    loading: Boolean(q),
    error: null,
  });
  useEffect(() => {
    if (!q) {
      setState({ data: [], loading: false, error: null });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    return onSnapshot(
      q,
      (snap) => setState({ data: snap.docs.map((d) => fromSnap<T>(d)), loading: false, error: null }),
      (err) => setState({ data: [], loading: false, error: err.message }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

export function useDocument<T>(ref: DocumentReference | null, deps: unknown[]): { data: T | null; loading: boolean; exists: boolean } {
  const [state, setState] = useState<{ data: T | null; loading: boolean; exists: boolean }>({
    data: null,
    loading: Boolean(ref),
    exists: false,
  });
  useEffect(() => {
    if (!ref) {
      setState({ data: null, loading: false, exists: false });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    return onSnapshot(
      ref,
      (snap) =>
        setState({
          data: snap.exists() ? ({ id: snap.id, ...snap.data({ serverTimestamps: 'estimate' }) } as T) : null,
          loading: false,
          exists: snap.exists(),
        }),
      () => setState({ data: null, loading: false, exists: false }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}
