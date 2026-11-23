import { hashOfSettingsPage, settingsPageIdOfHash } from '../domain/settings';

/*
 * The Settings section's page, as the address bar holds it: only the hash, like the section
 * itself (`address.ts`), so a reload or a link opens the same page.
 */

/** The settings page the address names, or null when it names none. */
export function currentSettingsPageId(): string | null {
  return settingsPageIdOfHash(window.location.hash);
}

/** Opens Settings on the page `id`, as a new entry in the browser's history. */
export function openSettingsPage(id: string): void {
  window.location.hash = hashOfSettingsPage(id);
}

/**
 * Hears every change of the address, a link followed or back and forward included, with the
 * settings page it names now. Returns what stops it.
 */
export function onSettingsPageChange(listener: (id: string | null) => void): () => void {
  const heard = () => listener(currentSettingsPageId());
  window.addEventListener('hashchange', heard);
  return () => window.removeEventListener('hashchange', heard);
}
