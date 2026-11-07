import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, Check, Info, X } from 'lucide-react';
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

type Kind = 'success' | 'error' | 'info';
interface Toast {
  id: number;
  kind: Kind;
  message: string;
}

const Ctx = createContext<((message: string, kind?: Kind) => void) | null>(null);
let seq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, kind: Kind = 'info') => {
    const id = ++seq;
    setToasts((t) => [...t.slice(-2), { id, kind, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3000);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 z-[100] flex flex-col items-center gap-2 px-4"
        style={{ top: 'calc(env(safe-area-inset-top) + 12px)' }}
        aria-live="polite"
      >
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, y: -8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.98 }}
              transition={{ duration: 0.16 }}
              className="pointer-events-auto flex max-w-md items-start gap-2.5 rounded-xl border border-border bg-elevated px-3.5 py-2.5 text-sm shadow-lg shadow-black/5"
            >
              {t.kind === 'success' ? (
                <Check className="mt-0.5 size-4 shrink-0 text-accent" />
              ) : t.kind === 'error' ? (
                <AlertCircle className="mt-0.5 size-4 shrink-0 text-danger" />
              ) : (
                <Info className="mt-0.5 size-4 shrink-0 text-muted" />
              )}
              <span className="min-w-0 flex-1">{t.message}</span>
              <button
                className="-mr-1 rounded p-0.5 text-subtle hover:text-fg"
                onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}
                aria-label="Dismiss"
              >
                <X className="size-3.5" />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useToast outside ToastProvider');
  return v;
}
