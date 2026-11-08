import { useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { analyticsAvailable, getAnalyticsChoice, onAnalyticsChoice, setAnalyticsChoice, type AnalyticsChoice } from '@/lib/analyticsConsent';
import { Button, Switch } from './ui';

/** Current choice for this browser, kept in sync across the banner, Settings and the Privacy page. */
export function useAnalyticsChoice(): AnalyticsChoice | null {
  return useSyncExternalStore(onAnalyticsChoice, getAnalyticsChoice, () => null);
}

/**
 * Shown until the visitor decides, in its own row below the app (never over
 * it). Not a modal: the app stays usable, and
 * analytics stays off while no choice has been made. Both buttons have the
 * same weight, so declining is as easy as allowing.
 */
export function AnalyticsConsentBanner() {
  const choice = useAnalyticsChoice();
  if (!analyticsAvailable || choice) return null;
  return (
    <section
      aria-label="Analytics choice"
      className="border-t border-border bg-elevated px-4 pt-3"
      style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-2.5 sm:flex-row sm:items-center sm:gap-4">
        <p className="flex-1 text-[13px] leading-snug text-fg">
          Allow Google Analytics to see how the app is used? It stays off unless you allow it.{' '}
          <Link to="/privacy" className="text-accent underline-offset-2 hover:underline">
            Privacy Policy
          </Link>
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" className="flex-1 sm:flex-none" onClick={() => setAnalyticsChoice('denied')}>
            Decline
          </Button>
          <Button size="sm" variant="outline" className="flex-1 sm:flex-none" onClick={() => setAnalyticsChoice('granted')}>
            Allow analytics
          </Button>
        </div>
      </div>
    </section>
  );
}

/** Switch used in Settings and on the Privacy page. */
export function AnalyticsSwitch() {
  const choice = useAnalyticsChoice();
  return (
    <Switch
      label="Usage analytics"
      checked={choice === 'granted'}
      disabled={!analyticsAvailable}
      onChange={(on) => setAnalyticsChoice(on ? 'granted' : 'denied')}
    />
  );
}
