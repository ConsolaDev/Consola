import { hashOfSection, sectionIdOfHash } from '../domain/sections';

/*
 * The dashboard's section, as the address bar holds it: only the hash, so a reload or a link
 * opens the same section, and the browser's back and forward move between sections. Nothing
 * here reads or writes the query string before the hash, which belongs to whatever page reads it
 * (`takeSignInErrorCode`, and a page sent back with a result of its own).
 */

/** The section the address names, or null when it names none. */
export function currentSectionId(): string | null {
  return sectionIdOfHash(window.location.hash);
}

/** Opens the section `id`, as a new entry in the browser's history. */
export function openSection(id: string): void {
  window.location.hash = hashOfSection(id);
}

/**
 * Hears every change of the address's section, a link followed or back and forward included,
 * with the section it names now. Returns what stops it.
 */
export function onSectionChange(listener: (id: string | null) => void): () => void {
  const heard = () => listener(currentSectionId());
  window.addEventListener('hashchange', heard);
  return () => window.removeEventListener('hashchange', heard);
}
