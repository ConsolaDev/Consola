/*
 * The dashboard's page, as the address bar holds it: only the hash, so a reload or a link opens
 * the same page, and the browser's back and forward move between pages. The hash names a section
 * (`#/<id>`, `sectionIdOfHash`), Settings (`#/settings/<page>`) or a factory's page
 * (`#/factories/<id>/<page>`, `factoryRouteOfHash`); the dashboard reads it whole. Nothing here
 * reads or writes the query string before the hash, which belongs to whatever page reads it
 * (`takeSignInErrorCode`, and a page sent back with a result of its own).
 */

/** The address's hash, as the page holds it now. */
export function currentHash(): string {
  return window.location.hash;
}

/** Opens `hash`, as a new entry in the browser's history. */
export function openHash(hash: string): void {
  window.location.hash = hash;
}

/**
 * Puts `hash` in the address in place of the one there, with no new entry in the history: where
 * an address that names nothing of its own (`#/factories` alone) lands, so back does not return
 * to it only to land again.
 */
export function replaceHash(hash: string): void {
  window.location.replace(hash);
}

/**
 * Hears every change of the hash, a link followed or back and forward included. Returns what
 * stops it.
 */
export function onHashChange(listener: () => void): () => void {
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
}
