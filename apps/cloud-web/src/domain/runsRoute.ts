import { filtersOfQuery, type RunFilters, queryOfFilters } from './runFilters';

/**
 * Where the Runs section is, as the address names it. The list is `#/runs`, its filters after a
 * `?` (`runFilters.ts`); one run is `#/runs/<runId>`, with where on its page after a `?`: its
 * file rather than its steps (`view=file`), and the step chosen (`step=<id>`). All of it is the
 * section's own part of the hash (`sections.ts`), so the dashboard opens Runs for any.
 */

export const RUNS_SECTION_ID = 'runs';

/** What an automation run's pane shows: its steps, or the file that defines them. */
export type RunView = 'steps' | 'file';

/** Where on a run's page: which view, and the step chosen in it, if any. */
export type RunPlace = { view: RunView; step: string | null };

export const RUN_START: RunPlace = { view: 'steps', step: null };

export type RunsRoute =
  | { kind: 'list'; filters: RunFilters }
  | { kind: 'run'; runId: string; place: RunPlace };

/** The longest step id the address keeps; a longer one names no step a file could hold. */
const STEP_MAX = 100;

/** Where on a run's page a query names: an unknown view is the steps, a blank step none. */
export function placeOfQuery(query: string): RunPlace {
  const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
  const step = params.get('step')?.trim() ?? '';
  return {
    view: params.get('view') === 'file' ? 'file' : 'steps',
    step: step !== '' && step.length <= STEP_MAX && !/\p{Cc}/u.test(step) ? step : null,
  };
}

/** The query that names `place`, without its `?`: empty for the steps with none chosen. */
export function queryOfPlace(place: RunPlace): string {
  const params = new URLSearchParams();
  if (place.view === 'file') params.set('view', 'file');
  if (place.step) params.set('step', place.step);
  return params.toString();
}

const RUNS_HASH = /^#\/runs(?:\/([^?]*))?(?:\?(.*))?$/s;

/** Where a hash puts the Runs section; a hash outside it, or one it cannot read, is the list. */
export function runsRouteOfHash(hash: string): RunsRoute {
  const match = RUNS_HASH.exec(hash);
  // One segment, a slash at its end allowed; an id's own slashes are escaped (`hashOfRun`).
  const path = (match?.[1] ?? '').replace(/\/+$/, '');
  if (path !== '' && !path.includes('/')) {
    try {
      return {
        kind: 'run',
        runId: decodeURIComponent(path),
        place: placeOfQuery(match?.[2] ?? ''),
      };
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

/** The hash that shows one run, at `place` on its page (its steps, none chosen, unless said). */
export function hashOfRun(runId: string, place: RunPlace = RUN_START): string {
  const query = queryOfPlace(place);
  const path = `#/${RUNS_SECTION_ID}/${encodeURIComponent(runId)}`;
  return query === '' ? path : `${path}?${query}`;
}
