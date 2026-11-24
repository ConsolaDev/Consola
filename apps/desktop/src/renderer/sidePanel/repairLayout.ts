/**
 * Turns whatever storage holds into a layout the functions in `layout.ts` can
 * act on. A profile can come from another build, one that knows a kind this
 * one does not or allowed more groups, or be junk: nothing in it is trusted.
 * What cannot be kept is dropped, what cannot be read at all is the default,
 * and nothing found there throws.
 */
import { defaultLayout, firstFreeId, MAX_GROUPS, NEW_TAB } from './layout';
import type {
  GroupId,
  LayoutNode,
  SidePanelLayout,
  SplitOrientation,
  TabGroupNode,
  TabId,
} from './layout';

type Stored = Record<string, unknown>;

/** `raw` is what JSON parsing gave back, so it holds no cycles. */
export function repairLayout(raw: unknown, knownKinds: readonly string[]): SidePanelLayout {
  if (!isRecord(raw) || raw.version !== 1) return defaultLayout();
  const known = new Set(knownKinds);

  // Kinds are deduplicated before empty groups go, and empty groups go before
  // the cap, so a group emptied by the repair does not cost a later one its place.
  const opened = new Set<string>();
  const kept: { stored: Stored; tabs: TabId[] }[] = [];
  for (const stored of storedGroups(raw.root)) {
    const tabs = keptTabs(stored.tabs, known, opened);
    if (tabs.length > 0) kept.push({ stored, tabs });
    if (kept.length === MAX_GROUPS) break;
  }
  // The root always holds a group, since the layout module acts on the first
  // one. With none left, the panel is the default: hidden, one empty group.
  if (kept.length === 0) return defaultLayout();

  // The ids the kept groups were stored with, first occurrence winning. Only
  // these are what `maximized` and `lastGroupOf` were written about.
  const storedIds = new Set<GroupId>();
  const ownIds = kept.map(({ stored: { id } }) => {
    if (typeof id !== 'string' || id === '' || storedIds.has(id)) return undefined;
    storedIds.add(id);
    return id;
  });
  const taken = new Set(storedIds);
  const groups = kept.map(({ stored, tabs }, index): TabGroupNode => {
    const id = ownIds[index] ?? firstFreeId(taken);
    taken.add(id);
    const active =
      typeof stored.active === 'string' && tabs.includes(stored.active) ? stored.active : tabs[0];
    return { type: 'group', id, tabs, active };
  });

  const root: LayoutNode =
    groups.length === 1
      ? groups[0]
      : { type: 'split', orientation: orientationOf(raw.root), children: groups };
  const maximized =
    groups.length > 1 && typeof raw.maximized === 'string' && storedIds.has(raw.maximized)
      ? raw.maximized
      : null;
  return {
    version: 1,
    visible: raw.visible === true,
    root,
    maximized,
    lastGroupOf: rememberedGroups(raw.lastGroupOf, known, storedIds),
  };
}

/**
 * Every node marked as a group, in document order. It keeps its own stack
 * rather than recursing, because parsing accepts nesting far deeper than a
 * recursive walk can follow.
 */
function* storedGroups(root: unknown): Generator<Stored> {
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!isRecord(node)) continue;
    if (node.type === 'group') yield node;
    else if (node.type === 'split' && Array.isArray(node.children)) {
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        pending.push(node.children[index]);
      }
    }
  }
}

/** The tabs this build can show: known kinds no earlier group opened, and one placeholder. */
function keptTabs(stored: unknown, known: ReadonlySet<string>, opened: Set<string>): TabId[] {
  if (!Array.isArray(stored)) return [];
  const tabs: TabId[] = [];
  for (const tab of stored) {
    if (tab === NEW_TAB) {
      if (!tabs.includes(NEW_TAB)) tabs.push(NEW_TAB);
    } else if (typeof tab === 'string' && known.has(tab) && !opened.has(tab)) {
      opened.add(tab);
      tabs.push(tab);
    }
  }
  return tabs;
}

function orientationOf(root: unknown): SplitOrientation {
  if (isRecord(root) && root.orientation === 'stacked') return 'stacked';
  return 'side-by-side';
}

function rememberedGroups(
  stored: unknown,
  known: ReadonlySet<string>,
  storedIds: ReadonlySet<GroupId>,
): Record<string, GroupId> {
  if (!isRecord(stored)) return {};
  return Object.fromEntries(
    Object.entries(stored).filter(
      (entry): entry is [string, GroupId] =>
        known.has(entry[0]) && typeof entry[1] === 'string' && storedIds.has(entry[1]),
    ),
  );
}

function isRecord(value: unknown): value is Stored {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
