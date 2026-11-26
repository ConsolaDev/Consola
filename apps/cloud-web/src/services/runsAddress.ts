import type { RunFilters } from '../domain/runFilters';
import { hashOfRun, hashOfRunsList } from '../domain/runsRoute';
import type { RunPlace } from '../domain/runsRoute';

/*
 * The Runs section's place, as the address bar holds it: only the hash, like the section itself
 * (`address.ts`), so a reload or a shared link shows the same list, filters and all, or the same
 * run. A run opens as a new entry in the browser's history (its rows are links); a filter changed
 * replaces the list's entry, so back leaves the list rather than undoing each chip.
 */

const listeners = new Set<() => void>();

/** The hash as it is now, which the Runs section reads its place from (`runsRouteOfHash`). */
export function currentRunsHash(): string {
  return window.location.hash;
}

/**
 * Hears every change of the address: a link followed, back and forward, and the filters this
 * page writes itself, which change no history and so fire no `hashchange`. Returns what stops it.
 */
export function onRunsAddressChange(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('hashchange', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('hashchange', listener);
  };
}

/** Puts `hash` in the address in place of the entry it had, and tells whoever listens. */
function replaceWith(hash: string): void {
  if (hash === window.location.hash) return;
  const { pathname, search } = window.location;
  window.history.replaceState(window.history.state, '', `${pathname}${search}${hash}`);
  for (const listener of listeners) listener();
}

/** Puts the list's filters in the address, in place of the entry it had. */
export function showRunsFilters(filters: RunFilters): void {
  replaceWith(hashOfRunsList(filters));
}

/**
 * Puts where on a run's page the person is (its steps or its file, the step chosen) in the
 * address, in place of the entry it had: a link copied then opens the same view, and back leaves
 * the run rather than stepping through each choice.
 */
export function showRunPlace(runId: string, place: RunPlace): void {
  replaceWith(hashOfRun(runId, place));
}
