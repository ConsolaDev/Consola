import { filtersOfQuery, type RunFilters, queryOfFilters } from './runFilters';

/**
 * Where the Runs section is, as the address names it. The list is `#/runs`, its filters after a
 * `?` (`runFilters.ts`); one run is `#/runs/<runId>`. Both are the section's own part of the hash
 * (`sections.ts`), so the dashboard opens Runs for either.
 */

export const RUNS_SECTION_ID = 'runs';

export type RunsRoute = { kind: 'list'; filters: RunFilters } | { kind: 'run'; runId: string };

const RUNS_HASH = /^#\/runs(?:\/([^?]*))?(?:\?(.*))?$/s;

/** Where a hash puts the Runs section; a hash outside it, or one it cannot read, is the list. */
export function runsRouteOfHash(hash: string): RunsRoute {
  const match = RUNS_HASH.exec(hash);
  // One segment, a slash at its end allowed; an id's own slashes are escaped (`hashOfRun`).
  const path = (match?.[1] ?? '').replace(/\/+$/, '');
  if (path !== '' && !path.includes('/')) {
    try {
      return { kind: 'run', runId: decodeURIComponent(path) };
    } catch {
      // A malformed escape: no run, so the list.
    }
  }
  return { kind: 'list', filters: filtersOfQuery(match?.[2] ?? '') };
}

/** The hash that shows the list narrowed by `filters`. */
export function hashOfRunsList(filters: RunFilters): string {
  const query = queryOfFilters(filters);
  return query === '' ? `#/${RUNS_SECTION_ID}` : `#/${RUNS_SECTION_ID}?${query}`;
}

/** The hash that shows one run. */
export function hashOfRun(runId: string): string {
  return `#/${RUNS_SECTION_ID}/${encodeURIComponent(runId)}`;
}
