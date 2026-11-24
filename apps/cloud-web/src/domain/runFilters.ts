import { BACKGROUND_TRIGGERS, isPhase, isRunTrigger, PHASES, RUN_TRIGGERS } from './runs';
import type { Phase, RunFacets, RunTrigger } from './runs';

/**
 * What the Runs list is narrowed to. The address holds it (`#/runs?…`, `queryOfFilters`), so a
 * reload or a shared link shows the same list.
 *
 * - A factory and a team are never both set: a factory belongs to one team, and the picker sets
 *   one or the other.
 * - An automation is a name, matched in every factory the person sees unless `factoryId`
 *   narrows it, so an automation picked from the menu brings its factory along.
 * - "My runs" and "Background runs" exclude each other: a background run has no person who
 *   started it.
 */
export type RunFilters = {
  /** Any of these phases; none is every phase. In `PHASES` order. */
  phases: Phase[];
  factoryId: string | null;
  teamId: string | null;
  automation: string | null;
  /** Started any of these ways; none is every way. In `RUN_TRIGGERS` order. */
  triggers: RunTrigger[];
  /** Only the runs the person started. */
  mine: boolean;
  /** Words in a run's title or its automation's name, as typed. */
  q: string;
};

export const NO_FILTERS: RunFilters = {
  phases: [],
  factoryId: null,
  teamId: null,
  automation: null,
  triggers: [],
  mine: false,
  q: '',
};

/** The longest search the cell takes, in characters. */
export const SEARCH_MAX = 200;

/** `values` in `order`'s order, each once, keeping only what `order` holds. */
function ordered<Value extends string>(order: readonly Value[], values: readonly Value[]): Value[] {
  return order.filter((value) => values.includes(value));
}

function cutSearch(q: string): string {
  return Array.from(q).slice(0, SEARCH_MAX).join('');
}

/** A value of the address worth keeping: present, and not blank. */
function present(value: string | null): string | null {
  return value !== null && value.trim() !== '' ? value : null;
}

/**
 * The filters an address's query names (what follows `#/runs?`). A value this build does not
 * know (a phase, a trigger) is dropped and a contradiction settled, so an old or edited link
 * still opens a list.
 */
export function filtersOfQuery(query: string): RunFilters {
  const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
  const phases = params.getAll('phase').filter(isPhase);
  const triggers = params.getAll('trigger').filter(isRunTrigger);
  if (params.get('background') === '1') triggers.push(...BACKGROUND_TRIGGERS);
  const factoryId = present(params.get('factory'));
  const mine = params.get('mine') === '1';
  return {
    phases: ordered(PHASES, phases),
    factoryId,
    teamId: factoryId === null ? present(params.get('team')) : null,
    automation: present(params.get('automation')),
    // My runs and background runs exclude each other: the person's choice wins.
    triggers: ordered(
      RUN_TRIGGERS,
      mine ? triggers.filter((trigger) => !BACKGROUND_TRIGGERS.includes(trigger)) : triggers,
    ),
    mine,
    q: cutSearch(params.get('q') ?? ''),
  };
}

/**
 * The query that names `filters` in the address, without its `?`: empty for none. One set of
 * filters always gives the same query, in one order, so equal lists have equal addresses. The
 * three background triggers are written as `background=1`.
 */
export function queryOfFilters(filters: RunFilters): string {
  const params = new URLSearchParams();
  if (filters.factoryId) params.set('factory', filters.factoryId);
  else if (filters.teamId) params.set('team', filters.teamId);
  if (filters.automation) params.set('automation', filters.automation);
  if (filters.mine) params.set('mine', '1');
  const triggers = ordered(RUN_TRIGGERS, filters.triggers);
  if (isBackground(filters)) params.set('background', '1');
  else for (const trigger of triggers) params.append('trigger', trigger);
  for (const phase of ordered(PHASES, filters.phases)) params.append('phase', phase);
  const q = filters.q.trim();
  if (q) params.set('q', cutSearch(q));
  return params.toString();
}

/** Whether the list is narrowed at all. */
export function hasFilters(filters: RunFilters): boolean {
  return queryOfFilters(filters) !== '';
}

/** Whether the list is narrowed to background runs: exactly the three triggers no person pulls. */
export function isBackground(filters: RunFilters): boolean {
  return (
    filters.triggers.length === BACKGROUND_TRIGGERS.length &&
    BACKGROUND_TRIGGERS.every((trigger) => filters.triggers.includes(trigger))
  );
}

/** A phase chip pressed: the phase joins the ones shown, or leaves them. */
export function togglePhase(filters: RunFilters, phase: Phase): RunFilters {
  const phases = filters.phases.includes(phase)
    ? filters.phases.filter((shown) => shown !== phase)
    : [...filters.phases, phase];
  return { ...filters, phases: ordered(PHASES, phases) };
}

/** "My runs" pressed. Turned on, it drops the background triggers, which no person pulls. */
export function toggleMine(filters: RunFilters): RunFilters {
  if (filters.mine) return { ...filters, mine: false };
  return {
    ...filters,
    mine: true,
    triggers: filters.triggers.filter((trigger) => !BACKGROUND_TRIGGERS.includes(trigger)),
  };
}

/** "Background runs" pressed: on, the three background triggers and not "My runs"; off, any trigger. */
export function toggleBackground(filters: RunFilters): RunFilters {
  if (isBackground(filters)) return { ...filters, triggers: [] };
  return { ...filters, mine: false, triggers: [...BACKGROUND_TRIGGERS] };
}

/** A trigger picked in the Filter menu, or taken off. A background one turns "My runs" off. */
export function toggleTrigger(filters: RunFilters, trigger: RunTrigger): RunFilters {
  const on = !filters.triggers.includes(trigger);
  const triggers = on
    ? [...filters.triggers, trigger]
    : filters.triggers.filter((shown) => shown !== trigger);
  return {
    ...filters,
    mine: on && BACKGROUND_TRIGGERS.includes(trigger) ? false : filters.mine,
    triggers: ordered(RUN_TRIGGERS, triggers),
  };
}

/**
 * A factory picked, or every factory (null). It takes the team's place, and an automation picked
 * in another factory goes: its name is the other factory's.
 */
export function withFactory(filters: RunFilters, factoryId: string | null): RunFilters {
  return {
    ...filters,
    factoryId,
    teamId: null,
    automation: factoryId !== null && factoryId === filters.factoryId ? filters.automation : null,
  };
}

/** A team picked, or every team (null): every factory it owns, any automation in them. */
export function withTeam(filters: RunFilters, teamId: string | null): RunFilters {
  return { ...filters, teamId, factoryId: null, automation: null };
}

/** An automation picked from the menu, with its factory, or none. */
export function withAutomation(
  filters: RunFilters,
  automation: { factoryId: string; name: string } | null,
): RunFilters {
  if (automation === null) return { ...filters, automation: null };
  return { ...filters, automation: automation.name, factoryId: automation.factoryId, teamId: null };
}

export function withSearch(filters: RunFilters, q: string): RunFilters {
  return { ...filters, q: cutSearch(q) };
}

/** The automations the menu offers: the picked factory's, or every factory's. */
export function automationsOffered(
  facets: RunFacets,
  filters: Pick<RunFilters, 'factoryId'>,
): RunFacets['automations'] {
  return filters.factoryId === null
    ? facets.automations
    : facets.automations.filter((automation) => automation.factoryId === filters.factoryId);
}

/**
 * The factories the picker offers, under the team that owns each, the teams by name; a factory
 * whose team the person does not see sits in a group of its own (`team: null`) at the end.
 */
export function factoriesByTeam(facets: RunFacets): Array<{
  team: { id: string; name: string } | null;
  factories: RunFacets['factories'];
}> {
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  const teams = [...facets.teams].sort(byName);
  const groups = teams
    .map((team) => ({
      team,
      factories: facets.factories.filter((factory) => factory.teamId === team.id).sort(byName),
    }))
    .filter((group) => group.factories.length > 0);
  const known = new Set(teams.map((team) => team.id));
  const others = facets.factories.filter((factory) => !known.has(factory.teamId)).sort(byName);
  return others.length > 0 ? [...groups, { team: null, factories: others }] : groups;
}
