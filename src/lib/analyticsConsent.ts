/**
 * Consent for Google Analytics, per browser.
 *
 * Analytics is off until the visitor chooses "Allow" in the banner (or turns
 * it on in Settings → Security → Usage analytics). The choice is stored only
 * in this browser (localStorage); nothing is sent to our server. Declining or
 * withdrawing stops collection and removes the Google Analytics cookies.
 * Essential storage (sign-in session, preferences, offline copy) is not
 * covered by this choice; the Privacy Policy lists it.
 */
import { analyticsAvailable, initAnalytics, stopAnalytics } from './firebase';

export type AnalyticsChoice = 'granted' | 'denied';
export const CONSENT_KEY = 'atlas.analyticsConsent';
const EVENT = 'atlas:analytics-consent';

export function getAnalyticsChoice(): AnalyticsChoice | null {
  try {
    const v = localStorage.getItem(CONSENT_KEY);
    return v === 'granted' || v === 'denied' ? v : null;
  } catch {
    return null;
  }
}

/** Remove Google Analytics cookies (_ga, _ga_<id>) for this host and its parent domain forms. */
export function clearAnalyticsCookies(doc: Document = document, host = location.hostname) {
  const names = doc.cookie
    .split(';')
    .map((c) => c.split('=')[0].trim())
    .filter((n) => n === '_ga' || n.startsWith('_ga_') || n === '_gid');
  const parts = host.split('.');
  const domains = ['', host, `.${host}`];
  for (let i = 1; i < parts.length - 1; i++) domains.push(`.${parts.slice(i).join('.')}`);
  for (const n of names) {
    for (const d of domains) doc.cookie = `${n}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${d ? `; domain=${d}` : ''}`;
  }
}

export function setAnalyticsChoice(choice: AnalyticsChoice | null) {
  try {
    if (choice) localStorage.setItem(CONSENT_KEY, choice);
    else localStorage.removeItem(CONSENT_KEY);
  } catch {
    /* storage blocked: the banner simply shows again next time */
  }
  if (choice === 'granted') void initAnalytics();
  else {
    void stopAnalytics();
    clearAnalyticsCookies();
  }
  window.dispatchEvent(new Event(EVENT));
}

export function startAnalyticsIfAllowed() {
  if (getAnalyticsChoice() === 'granted') void initAnalytics();
}

/** Subscribe to changes made in this tab (banner, Settings, Privacy page). */
export function onAnalyticsChoice(cb: () => void): () => void {
  window.addEventListener(EVENT, cb);
  window.addEventListener('storage', cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener('storage', cb);
  };
}

export { analyticsAvailable };
