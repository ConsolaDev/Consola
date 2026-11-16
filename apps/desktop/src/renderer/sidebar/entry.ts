import type { Attention } from '../../shared/attention';

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
  /** When it entered this attention value. */
  since: number;
  /** When it was last genuinely active. The sort key within a shelf. */
  activityAt: number;
  /** When it last finished, if it has. Orders the Done bucket. */
  finishedAt?: number;
  /** The conductor this entry belongs to. */
  parent?: EntryKey;
  labels: string[];
  /** scope, harness, model, automation, repo, readonly */
  facets: Record<string, string>;
}
