import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { startMonitoring } from './lib/api';
import { startAnalyticsIfAllowed } from './lib/analyticsConsent';
import { reloadForNewBuild } from './lib/reload';
import './index.css';

// A lazy chunk of an older build failed to load (a deploy happened while the page was open).
window.addEventListener('vite:preloadError', (e) => {
  if (reloadForNewBuild()) e.preventDefault();
});

startMonitoring();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Analytics loads only if this browser allowed it, after the app has rendered.
window.setTimeout(startAnalyticsIfAllowed, 4000);

// Service worker (PWA). Auto-updates in the background.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  import('virtual:pwa-register').then(({ registerSW }) => {
    registerSW({
      immediate: true,
      // Browsers only look for a new version on a fresh start, so an open tab
      // or installed app could keep an old build for days. Check whenever the
      // app comes back into view and every 30 minutes; a new version then
      // activates and the page reloads into it (autoUpdate).
      onRegisteredSW(_url, reg) {
        if (!reg) return;
        let last = Date.now();
        const check = () => {
          if (!navigator.onLine || Date.now() - last < 60_000) return;
          last = Date.now();
          void reg.update().catch(() => undefined);
        };
        window.setInterval(check, 30 * 60_000);
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') check();
        });
      },
    });
  });
}
