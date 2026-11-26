/**
 * The files a person has open on a factory's definition, as tabs, and the one in front. Opening
 * one already open brings it to the front; closing the one in front brings its right-hand
 * neighbour forward, else its left. Closing a tab keeps the file's edits: a tab is a view of a
 * file, never its changes.
 */
export type FactoryTabs = { readonly open: readonly string[]; readonly active: string | null };

export const NO_TABS: FactoryTabs = { open: [], active: null };

/** `path` open and in front: a new tab goes right of the one in front. */
export function openTab(tabs: FactoryTabs, path: string): FactoryTabs {
  if (tabs.open.includes(path)) return tabs.active === path ? tabs : { ...tabs, active: path };
  const at = tabs.active === null ? tabs.open.length : tabs.open.indexOf(tabs.active) + 1;
  return { open: [...tabs.open.slice(0, at), path, ...tabs.open.slice(at)], active: path };
}

/** `path`'s tab closed. */
export function closeTab(tabs: FactoryTabs, path: string): FactoryTabs {
  const at = tabs.open.indexOf(path);
  if (at === -1) return tabs;
  const open = tabs.open.filter((open) => open !== path);
  if (tabs.active !== path) return { open, active: tabs.active };
  return { open, active: open[at] ?? open[at - 1] ?? null };
}

/** The tabs with each renamed file's tab at its new path, in its place: `moves` old to new. */
export function renamedTabs(tabs: FactoryTabs, moves: ReadonlyMap<string, string>): FactoryTabs {
  if (!tabs.open.some((path) => moves.has(path))) return tabs;
  const open = [...new Set(tabs.open.map((path) => moves.get(path) ?? path))];
  const active = tabs.active === null ? null : (moves.get(tabs.active) ?? tabs.active);
  return { open, active };
}

/** The tabs with every file `paths` does not hold closed, as after a newer version is read. */
export function keptTabs(tabs: FactoryTabs, paths: readonly string[]): FactoryTabs {
  let kept = tabs;
  for (const path of tabs.open) if (!paths.includes(path)) kept = closeTab(kept, path);
  return kept;
}
