import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initAnalytics } from './lib/firebase';
import { reloadForNewBuild } from './lib/reload';
import './index.css';

// A lazy chunk of an older build failed to load (a deploy happened while the page was open).
window.addEventListener('vite:preloadError', (e) => {
  if (reloadForNewBuild()) e.preventDefault();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Analytics is non-essential: load it after the app has rendered.
window.setTimeout(() => void initAnalytics(), 4000);

// Service worker (PWA). Auto-updates in the background.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  import('virtual:pwa-register').then(({ registerSW }) => {
    registerSW({ immediate: true });
  });
}
