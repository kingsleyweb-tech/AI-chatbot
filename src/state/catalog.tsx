import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AppCapabilities, ModelCatalog, ModelInfo } from '@shared/types';
import { api } from '@/lib/api';
import { useAuth } from './auth';

type Caps = AppCapabilities & { admin: boolean };

interface CatalogCtx {
  catalog: ModelCatalog | null;
  caps: Caps | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
  getModel: (id: string | null | undefined) => ModelInfo | undefined;
}

const Ctx = createContext<CatalogCtx | null>(null);
const CACHE_KEY = 'tessera.catalog.v1';

function readCache(): ModelCatalog | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as ModelCatalog) : null;
  } catch {
    return null;
  }
}

export function CatalogProvider({ children }: { children: ReactNode }) {
  const { access } = useAuth();
  const [catalog, setCatalog] = useState<ModelCatalog | null>(readCache);
  const [caps, setCaps] = useState<Caps | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (access !== 'allowed') return;
    let cancelled = false;
    setLoading(true);
    Promise.allSettled([api<ModelCatalog>('models'), api<Caps>('config')]).then(([m, c]) => {
      if (cancelled) return;
      if (m.status === 'fulfilled') {
        setCatalog(m.value);
        setError(null);
        try {
          localStorage.setItem(CACHE_KEY, JSON.stringify(m.value));
        } catch {
          /* quota */
        }
      } else {
        setError(m.reason instanceof Error ? m.reason.message : 'Could not load models.');
      }
      if (c.status === 'fulfilled') setCaps(c.value);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [access, nonce]);

  const byId = useMemo(() => new Map((catalog?.models ?? []).map((m) => [m.id, m])), [catalog]);
  const getModel = useCallback((id: string | null | undefined) => (id ? byId.get(id) : undefined), [byId]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return (
    <Ctx.Provider value={{ catalog, caps, loading, error, reload, getModel }}>{children}</Ctx.Provider>
  );
}

export function useCatalog(): CatalogCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useCatalog outside CatalogProvider');
  return v;
}
