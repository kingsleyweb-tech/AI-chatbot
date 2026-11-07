import { useEffect, useState } from 'react';

/**
 * Frame geometry for the current visual viewport, or null when the page is
 * pinch-zoomed.
 *
 * The app frame follows the visual viewport so the iOS keyboard never covers
 * the composer. Pinch-zoom also shrinks and moves the visual viewport, though;
 * resizing the frame to match while the user zooms or pans made the whole page
 * jump on every frame. While zoomed we leave the frame alone and let the
 * browser pan over it, and pick up again when the zoom returns to normal.
 */
export function frameFor(vv: { height: number; offsetTop: number; scale: number }, innerHeight: number) {
  if (vv.scale > 1.01) return null;
  return {
    height: Math.round(vv.height),
    top: Math.max(0, Math.round(vv.offsetTop)),
    keyboard: innerHeight - vv.height > 120,
  };
}

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
    let last = '';
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const f = frameFor(vv, window.innerHeight);
        if (!f) return; // zoomed: never fight the browser's pan/zoom
        const key = `${f.height}:${f.top}:${f.keyboard}`;
        if (key === last) return; // avoid style writes (and re-layout) when nothing changed
        last = key;
        root.style.setProperty('--app-height', `${f.height}px`);
        root.style.setProperty('--app-top', `${f.top}px`);
        root.classList.toggle('keyboard-open', f.keyboard);
        // iOS may scroll the layout viewport when focusing an input; undo it (only at normal zoom).
        if (!f.keyboard && window.scrollY !== 0) window.scrollTo(0, 0);
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
