import { filtersOfQuery, type RunFilters, queryOfFilters } from './runFilters';

/**
 * Where the Runs section is, as the address names it. The list is `#/runs`, its filters after a
 * `?` (`runFilters.ts`); one run is `#/runs/<runId>`, with where on its page after a `?`: the view
 * (`view=file` for an automation run's file, `view=automations` for the automations a request
 * started), the step chosen (`step=<id>`) and the automation opened (`run=<id>`). All of it is the
 * section's own part of the hash (`sections.ts`), so the dashboard opens Runs for any.
 */

export const RUNS_SECTION_ID = 'runs';

/**
 * Which view of a run's page: its first (a request's conversation, an automation run's steps),
 * an automation run's file, or the automations a request started.
 */
export type RunView = 'main' | 'file' | 'automations';

/** Where on a run's page: the view, the step chosen and the automation opened, if any. */
export type RunPlace = { view: RunView; step: string | null; run: string | null };

export const RUN_START: RunPlace = { view: 'main', step: null, run: null };

/** What a step trace shows (`StepTrace`): its steps, or the file that defines them. */
export type TraceView = 'steps' | 'file';

/** Where in a step trace: the view, and the step chosen. */
export type TracePlace = { view: TraceView; step: string | null };

/** An automation run's place, as its page's trace reads it. */
export function traceOfPlace(place: RunPlace): TracePlace {
  return { view: place.view === 'file' ? 'file' : 'steps', step: place.step };
}

/** A trace's place, as an automation run's page writes it. */
export function placeOfTrace(trace: TracePlace): RunPlace {
  return { view: trace.view === 'file' ? 'file' : 'main', step: trace.step, run: null };
}

export type RunsRoute =
  | { kind: 'list'; filters: RunFilters }
  | { kind: 'run'; runId: string; place: RunPlace };

/** The longest id the address keeps for a step or a run; a longer one names none. */
const ID_MAX = 200;

/** An id as the address holds it, or null for a blank or unlikely one. */
function idOf(value: string | null): string | null {
  const id = value?.trim() ?? '';
  return id !== '' && id.length <= ID_MAX && !/\p{Cc}/u.test(id) ? id : null;
}

const VIEWS: readonly RunView[] = ['file', 'automations'];

/** Where on a run's page a query names: an unknown view is the first, a blank id none. */
export function placeOfQuery(query: string): RunPlace {
  const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
  const view = params.get('view');
  return {
    view: VIEWS.find((known) => known === view) ?? 'main',
    step: idOf(params.get('step')),
    run: idOf(params.get('run')),
  };
}

/** The query that names `place`, without its `?`: empty for the first view with nothing chosen. */
export function queryOfPlace(place: RunPlace): string {
  const params = new URLSearchParams();
  if (place.view !== 'main') params.set('view', place.view);
  if (place.step) params.set('step', place.step);
  if (place.run) params.set('run', place.run);
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

/** The hash that shows one run, at `place` on its page (its first view, nothing chosen, unless said). */
export function hashOfRun(runId: string, place: RunPlace = RUN_START): string {
  const query = queryOfPlace(place);
  const path = `#/${RUNS_SECTION_ID}/${encodeURIComponent(runId)}`;
  return query === '' ? path : `${path}?${query}`;
}
