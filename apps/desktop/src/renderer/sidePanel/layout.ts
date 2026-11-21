/**
 * The side panel's arrangement: its groups, how they are split, the tabs each
 * holds and which one is in front. This module is the only code that changes
 * it. The store wraps each function below that changes the layout in an
 * action of the same name, and components change it only through those. The
 * queries (`groupsOf`, `isInFront`, `canSplit` and the like) are called
 * directly.
 *
 * The layout is a tree, a group or a split of nodes, so the format already
 * allows deeper splits: allowing them is a change of rule, not of format. The
 * rule today is at most `MAX_GROUPS` groups, and `canSplit` is the one place
 * that cap lives. Nothing else here counts groups before adding one.
 *
 * Every function is pure, and returns its input by reference when the action
 * does not apply, so a caller can tell that nothing happened with `===`.
 */

/** The "+" list's tab, which becomes a kind once one is chosen. At most one per group. */
export const NEW_TAB = 'new-tab';
export const MAX_GROUPS = 2;

export type TabId = string; // a kind id, or NEW_TAB
export type GroupId = string;
export type Edge = 'top' | 'bottom' | 'left' | 'right';
export type SplitOrientation = 'stacked' | 'side-by-side';
export interface TabGroupNode {
  type: 'group';
  id: GroupId;
  tabs: TabId[];
  active: TabId | null;
}
export interface SplitNode {
  type: 'split';
  orientation: SplitOrientation;
  children: LayoutNode[];
}
export type LayoutNode = TabGroupNode | SplitNode;
export interface SidePanelLayout {
  version: 1;
  visible: boolean;
  root: LayoutNode;
  /** The group filling the panel while the other is hidden. */
  maximized: GroupId | null;
  /** The group each kind was in when it was last closed. */
  lastGroupOf: Record<string, GroupId>;
}
export type GroupPosition = 'only' | 'top' | 'bottom' | 'left' | 'right';

export function defaultLayout(): SidePanelLayout {
  return {
    version: 1,
    visible: false,
    root: emptyGroup('g1'),
    maximized: null,
    lastGroupOf: {},
  };
}

/** Every group, in document order: top before bottom, left before right. */
export function groupsOf(layout: SidePanelLayout): TabGroupNode[] {
  const groups: TabGroupNode[] = [];
  const walk = (node: LayoutNode) => {
    if (node.type === 'group') groups.push(node);
    else node.children.forEach(walk);
  };
  walk(layout.root);
  return groups;
}

/** The groups on screen: none while the panel is hidden, only the maximized one while maximized. */
export function visibleGroups(layout: SidePanelLayout): TabGroupNode[] {
  if (!layout.visible) return [];
  const groups = groupsOf(layout);
  const maximized = groups.find((group) => group.id === layout.maximized);
  return maximized ? [maximized] : groups;
}

export function groupOfTab(layout: SidePanelLayout, tab: TabId): TabGroupNode | undefined {
  return groupsOf(layout).find((group) => group.tabs.includes(tab));
}

/** Whether `kind` is the front tab of a group on screen, the only place its view is mounted. */
export function isInFront(layout: SidePanelLayout, kind: string): boolean {
  return visibleGroups(layout).some((group) => group.active === kind);
}

/** Where a group sits in its split, which names its tab list. */
export function groupPosition(layout: SidePanelLayout, groupId: GroupId): GroupPosition {
  const place = parentOf(layout.root, groupId);
  if (!place) return 'only';
  const first = place.index === 0;
  if (place.split.orientation === 'stacked') return first ? 'top' : 'bottom';
  return first ? 'left' : 'right';
}

/** The two-group cap lives here and nowhere else. A group's only tab cannot split from itself. */
export function canSplit(layout: SidePanelLayout, groupId: GroupId, tab: TabId): boolean {
  if (tab === NEW_TAB) return false;
  const groups = groupsOf(layout);
  if (groups.length >= MAX_GROUPS) return false;
  const group = groups.find((candidate) => candidate.id === groupId);
  return group !== undefined && group.tabs.length > 1 && group.tabs.includes(tab);
}

/**
 * Shows `kind`: fronts it where it is when it is open, and otherwise adds it
 * to the group it was last closed in, else the first group, taking the place
 * of a placeholder in front there. Shows the panel.
 */
export function openKind(layout: SidePanelLayout, kind: string): SidePanelLayout {
  const open = groupOfTab(layout, kind);
  if (open) return show(bringToFront(layout, open.id, kind));
  const groups = groupsOf(layout);
  const target = groups.find((group) => group.id === layout.lastGroupOf[kind]) ?? groups[0];
  const tabs =
    target.active === NEW_TAB
      ? target.tabs.map((tab) => (tab === NEW_TAB ? kind : tab))
      : [...target.tabs, kind];
  return show(reveal(withGroup(layout, { ...target, tabs, active: kind }), target.id));
}

export function bringToFront(
  layout: SidePanelLayout,
  groupId: GroupId,
  tab: TabId,
): SidePanelLayout {
  const group = findGroup(layout, groupId);
  if (!group?.tabs.includes(tab)) return layout;
  if (group.active === tab && !hiddenByMaximize(layout, groupId)) return layout;
  return reveal(withGroup(layout, { ...group, active: tab }), groupId);
}

/**
 * Closes a tab, handing the front to the tab before it, else the one after.
 * A group left empty goes, and the other fills the panel; the last group left
 * empty stays, and the panel hides.
 */
export function closeTab(layout: SidePanelLayout, groupId: GroupId, tab: TabId): SidePanelLayout {
  const group = findGroup(layout, groupId);
  if (!group?.tabs.includes(tab)) return layout;
  const left = withoutTab(group, tab);
  if (left.tabs.length === 0) return withoutGroup(layout, groupId, [tab]);
  const lastGroupOf =
    tab === NEW_TAB ? layout.lastGroupOf : { ...layout.lastGroupOf, [tab]: groupId };
  return { ...withGroup(layout, left), lastGroupOf };
}

/** Closes every tab in the group. */
export function closeGroup(layout: SidePanelLayout, groupId: GroupId): SidePanelLayout {
  const group = findGroup(layout, groupId);
  if (!group || group.tabs.length === 0) return layout;
  return withoutGroup(layout, groupId, group.tabs);
}

/**
 * Moves an open kind to `index` in a group, counted after the tab has left
 * its place, and fronts it there. A group it leaves empty goes. The
 * placeholder does not move: it is only ever where the person opened it.
 */
export function moveTab(
  layout: SidePanelLayout,
  tab: TabId,
  toGroupId: GroupId,
  index: number,
): SidePanelLayout {
  if (tab === NEW_TAB) return layout;
  const from = groupOfTab(layout, tab);
  const to = findGroup(layout, toGroupId);
  if (!from || !to) return layout;
  if (from.id === to.id) {
    const tabs = insertAt(withoutTab(from, tab).tabs, index, tab);
    const unchanged = from.active === tab && tabs.every((t, i) => t === from.tabs[i]);
    if (unchanged && !hiddenByMaximize(layout, to.id)) return layout;
    return reveal(withGroup(layout, { ...from, tabs, active: tab }), to.id);
  }
  const arrived = withGroup(layout, { ...to, tabs: insertAt(to.tabs, index, tab), active: tab });
  const left = withoutTab(from, tab);
  const departed =
    left.tabs.length === 0 ? withoutGroup(arrived, from.id, []) : withGroup(arrived, left);
  return reveal(departed, to.id);
}

/** Takes `tab` out of its group into a new group on the side of `edge`. */
export function splitWithTab(
  layout: SidePanelLayout,
  groupId: GroupId,
  tab: TabId,
  edge: Edge,
): SidePanelLayout {
  const group = findGroup(layout, groupId);
  if (!group || !canSplit(layout, groupId, tab)) return layout;
  const kept = withoutTab(group, tab);
  const taken = new Set(groupsOf(layout).map((each) => each.id));
  const added: TabGroupNode = { type: 'group', id: firstFreeId(taken), tabs: [tab], active: tab };
  const split: SplitNode = {
    type: 'split',
    orientation: edge === 'top' || edge === 'bottom' ? 'stacked' : 'side-by-side',
    children: edge === 'top' || edge === 'left' ? [added, kept] : [kept, added],
  };
  return { ...layout, root: replaceGroup(layout.root, groupId, split) };
}

/** Lets a group fill the panel, hiding the other without closing it; again, restores the split. */
export function toggleMaximize(layout: SidePanelLayout, groupId: GroupId): SidePanelLayout {
  const groups = groupsOf(layout);
  if (groups.length < 2 || !groups.some((group) => group.id === groupId)) return layout;
  return { ...layout, maximized: layout.maximized === groupId ? null : groupId };
}

/** Fronts the group's placeholder, adding it at the end if the group has none, and shows the panel. */
export function addPlaceholder(layout: SidePanelLayout, groupId: GroupId): SidePanelLayout {
  const group = findGroup(layout, groupId);
  if (!group) return layout;
  if (group.active === NEW_TAB && layout.visible && !hiddenByMaximize(layout, groupId)) {
    return layout;
  }
  const tabs = group.tabs.includes(NEW_TAB) ? group.tabs : [...group.tabs, NEW_TAB];
  return show(reveal(withGroup(layout, { ...group, tabs, active: NEW_TAB }), groupId));
}

/**
 * Turns the group's placeholder into `kind`, in place. A kind that is open
 * already is fronted where it is instead, and the placeholder closes.
 */
export function choosePlaceholder(
  layout: SidePanelLayout,
  groupId: GroupId,
  kind: string,
): SidePanelLayout {
  const group = findGroup(layout, groupId);
  if (!group?.tabs.includes(NEW_TAB)) return layout;
  if (groupOfTab(layout, kind)) return closeTab(openKind(layout, kind), groupId, NEW_TAB);
  const tabs = group.tabs.map((tab) => (tab === NEW_TAB ? kind : tab));
  return show(reveal(withGroup(layout, { ...group, tabs, active: kind }), groupId));
}

/** Shows or hides the panel, keeping its tabs. Showing a panel with no tabs opens the placeholder. */
export function setVisible(layout: SidePanelLayout, visible: boolean): SidePanelLayout {
  const groups = groupsOf(layout);
  if (visible && groups.every((group) => group.tabs.length === 0)) {
    return addPlaceholder(layout, groups[0].id);
  }
  return layout.visible === visible ? layout : { ...layout, visible };
}

/** A kind's shortcut hides the panel while that kind is in front on screen, and opens it otherwise. */
export function pressShortcut(layout: SidePanelLayout, kind: string): SidePanelLayout {
  return isInFront(layout, kind) ? setVisible(layout, false) : openKind(layout, kind);
}

/** The lowest group id not taken: what a new group is called, here and in a repaired layout. */
export function firstFreeId(taken: ReadonlySet<GroupId>): GroupId {
  let n = 1;
  while (taken.has(`g${n}`)) n += 1;
  return `g${n}`;
}

function emptyGroup(id: GroupId): TabGroupNode {
  return { type: 'group', id, tabs: [], active: null };
}

function findGroup(layout: SidePanelLayout, groupId: GroupId): TabGroupNode | undefined {
  return groupsOf(layout).find((group) => group.id === groupId);
}

function show(layout: SidePanelLayout): SidePanelLayout {
  return layout.visible ? layout : { ...layout, visible: true };
}

function hiddenByMaximize(layout: SidePanelLayout, groupId: GroupId): boolean {
  return layout.maximized !== null && layout.maximized !== groupId;
}

/** Restores the split when `groupId` is the group Maximize hides. */
function reveal(layout: SidePanelLayout, groupId: GroupId): SidePanelLayout {
  return hiddenByMaximize(layout, groupId) ? { ...layout, maximized: null } : layout;
}

/** The group without `tab`, its front handed to the tab before it, else the one after. */
function withoutTab(group: TabGroupNode, tab: TabId): TabGroupNode {
  const index = group.tabs.indexOf(tab);
  const tabs = group.tabs.filter((candidate) => candidate !== tab);
  if (group.active !== tab) return { ...group, tabs };
  return { ...group, tabs, active: tabs[index - 1] ?? tabs[index] ?? null };
}

function insertAt(tabs: TabId[], index: number, tab: TabId): TabId[] {
  const at = Math.max(0, Math.min(index, tabs.length));
  return [...tabs.slice(0, at), tab, ...tabs.slice(at)];
}

function withGroup(layout: SidePanelLayout, group: TabGroupNode): SidePanelLayout {
  return { ...layout, root: replaceGroup(layout.root, group.id, group) };
}

function replaceGroup(node: LayoutNode, groupId: GroupId, replacement: LayoutNode): LayoutNode {
  if (node.type === 'group') return node.id === groupId ? replacement : node;
  return {
    ...node,
    children: node.children.map((child) => replaceGroup(child, groupId, replacement)),
  };
}

/**
 * Removes a group, and everything `lastGroupOf` remembers of it, so a later
 * group reusing the id inherits nothing. The kinds `closed` with it forget
 * where they were closed before, too: the group they were last closed in is
 * gone, so they open in the first group, not in one they left long ago. A
 * split left with one child becomes that child. The last group stays,
 * emptied, under its own id, and the panel hides.
 */
function withoutGroup(
  layout: SidePanelLayout,
  groupId: GroupId,
  closed: readonly TabId[],
): SidePanelLayout {
  const lastGroupOf = Object.fromEntries(
    Object.entries(layout.lastGroupOf).filter(
      ([kind, id]) => id !== groupId && !closed.includes(kind),
    ),
  );
  const root = removeGroup(layout.root, groupId);
  if (root === null) {
    return { ...layout, visible: false, root: emptyGroup(groupId), maximized: null, lastGroupOf };
  }
  const next = { ...layout, root, lastGroupOf };
  const groups = groupsOf(next);
  const keepsMaximized = groups.length > 1 && groups.some((group) => group.id === layout.maximized);
  return keepsMaximized ? next : { ...next, maximized: null };
}

function removeGroup(node: LayoutNode, groupId: GroupId): LayoutNode | null {
  if (node.type === 'group') return node.id === groupId ? null : node;
  const children = node.children
    .map((child) => removeGroup(child, groupId))
    .filter((child): child is LayoutNode => child !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return { ...node, children };
}

function parentOf(
  node: LayoutNode,
  groupId: GroupId,
): { split: SplitNode; index: number } | undefined {
  if (node.type === 'group') return undefined;
  const index = node.children.findIndex((child) => child.type === 'group' && child.id === groupId);
  if (index !== -1) return { split: node, index };
  for (const child of node.children) {
    const found = parentOf(child, groupId);
    if (found) return found;
  }
  return undefined;
}
