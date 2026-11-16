import { activityOf, type AttentionState } from '../../shared/attention';
import type { Label, Session } from '../../shared/workspace';
import { attentionOf } from '../stores/attentionStore';
import { FACET_KEYS, facetValuesOf, type SessionFilters } from '../utils/sessionFilters';
import type { Entry, EntryKey } from './entry';
import type { FilterSelection } from './filter';

/** The key a session's entry has, and the id inside it. */
export const sessionKey = (sessionId: string): EntryKey => `session:${sessionId}`;

/** The id inside an entry's key, whatever its kind. A row uses it to look up its own record. */
export const idOfKey = (key: EntryKey): string => key.slice(key.indexOf(':') + 1);

/**
 * The session provider: one entry per session, joining the record with what
 * main derived for it. The entry carries no payload — a row looks its session
 * up by id — so a new source (slice 6's runs) is another provider and a
 * registry line, with nothing here or in bucketing to edit.
 *
 * Facets are the auto-derived ones (`harness`, `model`, `automation`, `repo`,
 * `readOnly`) plus `scope`. They use `FacetKey` spellings so that a selection
 * from the filter bar is a selection over entries with no renaming.
 */
export function sessionEntries(
  sessions: readonly Session[],
  snapshot: Pick<AttentionState, 'records' | 'attention'>,
  labels: readonly Label[]
): Entry[] {
  const liveLabels = new Set(labels.map((label) => label.id));
  return sessions.map((session) => {
    const record = snapshot.records[session.id];
    const facets: Record<string, string> = { scope: session.scopeId };
    for (const key of FACET_KEYS) {
      if (key === 'label') continue;
      const [value] = facetValuesOf(session, key);
      if (value !== undefined) facets[key] = value;
    }
    const activityAt = activityOf(session, record);
    return {
      key: sessionKey(session.id),
      kind: 'session',
      attention: attentionOf(snapshot.attention, session.id),
      // The ledger keeps no per-edge timestamp, so the last real activity is
      // the nearest honest answer to "since when": a waiting session stopped
      // being active when it began to wait.
      since: record?.finishedAt ?? activityAt,
      activityAt,
      ...(record?.finishedAt !== undefined ? { finishedAt: record.finishedAt } : {}),
      ...(session.parentSessionId ? { parent: sessionKey(session.parentSessionId) } : {}),
      labels: (session.labelIds ?? []).filter((id) => liveLabels.has(id)),
      facets,
    };
  });
}

/**
 * The selection `applyFilter` takes, from the two places the choices live:
 * the scope (`homeStore`) and the facets and labels (`sessionFilterStore`).
 */
export function filterSelection(scopeId: string | undefined, facets: SessionFilters): FilterSelection {
  const { label, ...rest } = facets;
  const chosen: Record<string, string[]> = {};
  for (const [key, values] of Object.entries(rest)) if (values?.length) chosen[key] = values;
  if (scopeId) chosen.scope = [scopeId];
  return { labels: label ?? [], facets: chosen };
}
