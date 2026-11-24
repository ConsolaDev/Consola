import { useSyncExternalStore } from 'react';
import { type FactoryDraft, isChanged } from '../domain/factoryDraft';
import type { FactoryVersion } from '../domain/factories';
import type { FactoryTabs } from '../domain/factoryTabs';

/*
 * What a person left on a factory's definition while they moved around the dashboard: their
 * unsaved edits and the files they had open. It lives in the page's memory, per workspace and
 * factory, so going to Runs and back finds the edits where they were; nothing is written to
 * storage, so a reload starts from the saved version. While any factory has unsaved edits,
 * closing or reloading the tab asks first (`beforeunload`).
 */

/** What a factory's definition keeps while the person is away from it. */
export type KeptDefinition = {
  /** The version the draft was made from, as the page heads it. */
  version: FactoryVersion;
  draft: FactoryDraft;
  tabs: FactoryTabs;
};

const kept = new Map<string, KeptDefinition>();
const listeners = new Set<() => void>();
let asking = false;

const keyOf = (workspaceId: string, factoryId: string) => `${workspaceId}/${factoryId}`;

/** Asks before the tab closes or reloads: the browser words the question. */
function askBeforeLeaving(event: BeforeUnloadEvent): void {
  event.preventDefault();
}

/** Listens for the tab closing exactly while some factory has unsaved edits. */
function followUnsaved(): void {
  const unsaved = [...kept.values()].some((entry) => isChanged(entry.draft));
  if (unsaved === asking) return;
  asking = unsaved;
  if (unsaved) window.addEventListener('beforeunload', askBeforeLeaving);
  else window.removeEventListener('beforeunload', askBeforeLeaving);
}

/** What the definition of `factoryId` kept, if the person left it this session. */
export function keptDefinition(workspaceId: string, factoryId: string): KeptDefinition | undefined {
  return kept.get(keyOf(workspaceId, factoryId));
}

/** Keeps a factory's definition as the person leaves it, or forgets it with `null`. */
export function keepDefinition(
  workspaceId: string,
  factoryId: string,
  value: KeptDefinition | null,
): void {
  const key = keyOf(workspaceId, factoryId);
  const before = kept.get(key);
  if (value === null) kept.delete(key);
  else kept.set(key, value);
  followUnsaved();
  const changedBefore = before ? isChanged(before.draft) : false;
  const changedNow = value ? isChanged(value.draft) : false;
  if (changedBefore !== changedNow) for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether `factoryId` has unsaved edits in this tab, for the sidebar's mark. */
export function useHasUnsavedEdits(workspaceId: string, factoryId: string): boolean {
  return useSyncExternalStore(subscribe, () => {
    const entry = kept.get(keyOf(workspaceId, factoryId));
    return entry ? isChanged(entry.draft) : false;
  });
}
