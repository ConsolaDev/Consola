import type { Attention } from '../../shared/attention';
import { FACET_KEYS } from '../utils/sessionFilters';

export type EntryKey = `session:${string}` | `run:${string}` | `gate:${string}`;

/**
 * One row's worth of facts, and nothing else. No `Session`, no `RunRecord`: a
 * row component looks up its own record by key, so the sidebar's logic never
 * grows an arm per source type and a new source is one provider.
 */
export interface Entry {
  key: EntryKey;
  /** An open set. Never switch on it outside the row registry. */
  kind: string;
  /** Already derived by main; never computed in the renderer. */
  attention: Attention;
  /** When it first appeared. */
  createdAt: number;
  /** When it last came back from Settled, if it ever has. */
  unsettledAt?: number;
  /** When it was last genuinely active: a turn starting or finishing. */
  activityAt: number;
  /** When it last finished, if it has. */
  finishedAt?: number;
  /** The conductor this entry belongs to. */
  parent?: EntryKey;
  labels: string[];
  /** scope, harness, model, automation, repo, readonly */
  facets: Record<string, string>;
  /**
   * The facets this entry's kind answers for, whether or not it has a value
   * for each. A facet outside the domain never hides the row, and one inside
   * it with no value still does.
   *
   * Declared rather than read off `facets`, because absence there means two
   * different things: a session with no automation is a session an automation
   * filter should hide, while a run has no scope and can never have one — and
   * hiding every pending approval the moment a scope is picked would take the
   * most valuable rows out of the queue. Bucketing and filtering still never
   * switch on `kind`; the entry brings the answer with it.
   */
  facetDomain: readonly string[];
}

/**
 * The facets a session answers for. One it has no value for — a session with
 * no automation — is still hidden by that facet.
 */
export const SESSION_FACET_DOMAIN: readonly string[] = [
  'scope',
  ...FACET_KEYS.filter((key) => key !== 'label'),
];

/** The facets a run answers for. A run belongs to an automation, not a scope. */
export const RUN_FACET_DOMAIN: readonly string[] = ['automation'];
