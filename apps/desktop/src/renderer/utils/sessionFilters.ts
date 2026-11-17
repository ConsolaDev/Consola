import type { Session, Workspace } from '../../shared/workspace';

/**
 * Facets a person can narrow the session list by, other than scope (which
 * keeps its own store: much of the app reads "the scope the list is narrowed
 * to"). Every one but `label` is derived from fields a session already has,
 * so none needs upkeep and none can be stale.
 */
export type FacetKey = 'harness' | 'model' | 'automation' | 'repo' | 'readOnly' | 'label';

export const FACET_KEYS: readonly FacetKey[] = [
  'harness',
  'model',
  'automation',
  'repo',
  'readOnly',
  'label',
];

/** Selected values per facet. Values within a facet are OR'd; facets are AND'd. */
export type SessionFilters = Partial<Record<FacetKey, string[]>>;

export interface FacetValue {
  value: string;
  count: number;
}

/** The single value of the read-only facet: it is a toggle, not a list. */
export const READ_ONLY_VALUE = 'read-only';

/** What a session has for a facet. Labels are by id, as stored. */
export function facetValuesOf(session: Session, key: FacetKey): string[] {
  switch (key) {
    case 'harness':
      return [session.harnessId];
    case 'model':
      return session.model ? [session.model] : [];
    case 'automation':
      return session.automation?.name ? [session.automation.name] : [];
    case 'repo':
      return session.workItem?.repo ? [session.workItem.repo] : [];
    case 'readOnly':
      return session.toolPolicy === 'read-only' ? [READ_ONLY_VALUE] : [];
    case 'label':
      return session.labelIds ?? [];
  }
}

/**
 * Every value each derived facet takes across these sessions, with counts, in
 * first-seen order. Labels are not here: they come from the workspace's own
 * list, so a label no session carries yet can still be picked.
 */
export function deriveFacets(
  sessions: readonly Session[],
): Record<Exclude<FacetKey, 'label'>, FacetValue[]> {
  const derived = { harness: [], model: [], automation: [], repo: [], readOnly: [] } as Record<
    Exclude<FacetKey, 'label'>,
    FacetValue[]
  >;
  for (const session of sessions) {
    for (const key of Object.keys(derived) as (keyof typeof derived)[]) {
      for (const value of facetValuesOf(session, key)) {
        const entry = derived[key].find((candidate) => candidate.value === value);
        if (entry) entry.count += 1;
        else derived[key].push({ value, count: 1 });
      }
    }
  }
  return derived;
}

/**
 * The filters that mean something right now. A selection naming something
 * that no longer exists (a deleted label, a model no session runs any more)
 * is dropped on read rather than hiding every row with no way to see why —
 * the same resolve-on-read rule a remembered view follows.
 */
export function effectiveFilters(
  workspace: Workspace,
  sessions: readonly Session[],
  filters: SessionFilters | undefined,
): SessionFilters {
  if (!filters) return {};
  const derived = deriveFacets(sessions);
  const labelIds = new Set(workspace.labels.map((label) => label.id));
  const effective: SessionFilters = {};
  for (const key of FACET_KEYS) {
    const chosen = filters[key];
    if (!chosen?.length) continue;
    const live =
      key === 'label'
        ? chosen.filter((id) => labelIds.has(id))
        : chosen.filter((value) => derived[key].some((candidate) => candidate.value === value));
    if (live.length > 0) effective[key] = live;
  }
  return effective;
}

/** Whether the session passes every selected facet. Hides rows; never moves them. */
export function matchesFilters(session: Session, filters: SessionFilters): boolean {
  return FACET_KEYS.every((key) => {
    const chosen = filters[key];
    if (!chosen?.length) return true;
    const has = facetValuesOf(session, key);
    return chosen.some((value) => has.includes(value));
  });
}

export function hasActiveFilters(filters: SessionFilters): boolean {
  return FACET_KEYS.some((key) => (filters[key]?.length ?? 0) > 0);
}
