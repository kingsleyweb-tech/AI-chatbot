/**
 * After a deploy, a page that was opened on the previous build can no longer
 * load its lazy chunks (their hashed files are gone). Browsers report this in
 * different words; all of them mean "reload to get the new build".
 */
export const CHUNK_ERROR =
  /dynamically imported module|Loading chunk|Loading CSS chunk|Importing a module script failed|error loading dynamically imported|Unable to preload|not a valid JavaScript MIME type|Expected a JavaScript module script/i;

const KEY = 'atlas:chunk-reload';

/** Reload once to pick up the new build; never loop if the reload did not help. */
export function reloadForNewBuild(): boolean {
  try {
    const last = Number(sessionStorage.getItem(KEY) ?? 0);
    if (Date.now() - last < 30_000) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}
