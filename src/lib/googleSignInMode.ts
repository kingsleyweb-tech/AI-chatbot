/**
 * How "Continue with Google" opens Google's page.
 *
 * 'redirect' (same tab) whenever it is reliable: in installed apps, and when
 * Google's sign-in handler is served from the app's own address (authDomain is
 * this site, proxied by vercel.json), so the result is stored on this site.
 * A popup opens a separate tab or window on phones and in many desktop set-ups,
 * and when it closes the browser can show whichever tab or window was used last
 * instead of Atlas AI.
 *
 * 'popup' only where a redirect could lose the result: the handler is on another
 * domain (local development uses <project>.firebaseapp.com).
 */
export function googleSignInMode(authDomain: string | undefined, host: string, standalone: boolean): 'redirect' | 'popup' {
  if (standalone) return 'redirect';
  return authDomain && authDomain.toLowerCase() === host.toLowerCase() ? 'redirect' : 'popup';
}
