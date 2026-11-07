import { useEffect, useState } from 'react';

/**
 * Track the visual viewport (what is actually visible above the iOS
 * keyboard) and expose it as CSS variables used by `.app-frame`.
 */
export function useVisualViewport() {
  useEffect(() => {
    const vv = window.visualViewport;
    const root = document.documentElement;
    if (!vv) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        root.style.setProperty('--app-height', `${vv.height}px`);
        root.style.setProperty('--app-top', `${vv.offsetTop}px`);
        const keyboard = window.innerHeight - vv.height > 120;
        root.classList.toggle('keyboard-open', keyboard);
        // iOS may scroll the layout viewport when focusing an input; undo it.
        if (!keyboard && window.scrollY !== 0) window.scrollTo(0, 0);
      });
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    window.addEventListener('orientationchange', update);
    return () => {
      cancelAnimationFrame(frame);
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);
}

export function useMediaQuery(q: string): boolean {
  const [match, setMatch] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => {
    const mql = window.matchMedia(q);
    const on = () => setMatch(mql.matches);
    on();
    mql.addEventListener('change', on);
    return () => mql.removeEventListener('change', on);
  }, [q]);
  return match;
}

export const useIsDesktop = () => useMediaQuery('(min-width: 900px)');

export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}
