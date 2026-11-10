import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { saveSettings } from '@/lib/db';
import { DEFAULT_SETTINGS, type UserSettings } from '@/lib/types';
import { useMediaQuery } from '@/lib/viewport';
import { useAuth } from './auth';

interface SettingsCtx {
  settings: UserSettings;
  update: (patch: Partial<UserSettings>) => Promise<void>;
  isDark: boolean;
}

const Ctx = createContext<SettingsCtx | null>(null);

function readLocal(): Partial<UserSettings> {
  try {
    return JSON.parse(localStorage.getItem('tessera.appearance') ?? '{}');
  } catch {
    return {};
  }
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const { user, profile } = useAuth();
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)');
  const settings = useMemo<UserSettings>(
    () => ({ ...DEFAULT_SETTINGS, ...readLocal(), ...(profile?.settings ?? {}) }),
    [profile],
  );
  const isDark = settings.theme === 'dark' || (settings.theme === 'system' && systemDark);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', isDark);
    root.dataset.accent = settings.accent;
    document
      .querySelectorAll('meta[name="theme-color"]')
      .forEach((m) => m.setAttribute('content', isDark ? '#000000' : '#f5f1e8'));
    try {
      localStorage.setItem('tessera.appearance', JSON.stringify({ theme: settings.theme, accent: settings.accent }));
    } catch {
      /* ignore */
    }
  }, [isDark, settings.theme, settings.accent]);

  const update = useCallback(
    async (patch: Partial<UserSettings>) => {
      if (!user) return;
      if (patch.theme || patch.accent) {
        try {
          localStorage.setItem('tessera.appearance', JSON.stringify({ theme: patch.theme ?? settings.theme, accent: patch.accent ?? settings.accent }));
        } catch {
          /* ignore */
        }
      }
      await saveSettings(user.uid, patch);
    },
    [user, settings.theme, settings.accent],
  );

  return <Ctx.Provider value={{ settings, update, isDark }}>{children}</Ctx.Provider>;
}

export function useSettings(): SettingsCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSettings outside SettingsProvider');
  return v;
}
