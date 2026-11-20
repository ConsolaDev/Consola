import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import * as Layout from '../sidePanel/layout';
import type { Edge, GroupId, SidePanelLayout, TabId } from '../sidePanel/layout';
import { repairLayout } from '../sidePanel/repairLayout';
import { isTabKindId, TAB_KIND_IDS, type TabKindId } from '../sidePanel/tabKinds';
import { rankShortcutKinds, recordUse, sanitizeUsage, type UsageLog } from '../sidePanel/usage';

/**
 * The side panel's arrangement, how often the person opens each kind of tab,
 * and whether the arrangement is remembered between launches. Components read
 * this store and call its actions; every change to the arrangement is made by
 * a function of `sidePanel/layout.ts`, most of them wrapped in an action of
 * the same name, and an action that does not apply writes nothing.
 *
 * Two things are decided here so that nothing happens without the person:
 *
 * - **Only the person bringing a kind on screen counts, and only it asks for
 *   focus.** `openKind`, `pressShortcut`, `bringToFront` and
 *   `choosePlaceholder` share one rule: a use is recorded and `focusRequest`
 *   set only when the kind was not in front on screen before the action and
 *   is after it (`isInFront`). A kind already in front mounts nothing new, so
 *   a request then would sit unconsumed until some later mount took it, such
 *   as another session's shell after a switch. Restoring a layout at launch
 *   and switching sessions call no action, so a view they mount counts
 *   nothing and finds no request: a shell that mounts that way never takes
 *   the keyboard from the conversation.
 * - **The header's shortcut set is fixed for the run.** `shortcutKinds` is
 *   ranked once, when the stored uses are read, and no action touches it, so
 *   nothing moves under the pointer however the counts change.
 *
 * Persisted to localStorage, which every window shares: each window holds its
 * own copy and the last write wins, as for the other renderer preferences.
 */

export const SIDE_PANEL_STORAGE_KEY = 'consola-side-panel';
/** How long a focus request waits for its view to mount and take it. */
export const FOCUS_REQUEST_TTL_MS = 5_000;

export interface PersistedSidePanel {
  layout?: SidePanelLayout;
  uses: UsageLog;
  rememberLayout: boolean;
}

export interface SidePanelState {
  layout: SidePanelLayout;
  uses: UsageLog;
  /** The header's kinds, worked out once when this window's store is created and never again while it runs. */
  shortcutKinds: readonly TabKindId[];
  rememberLayout: boolean;
  /** Not persisted: the kind the person just asked for, which its view may focus once. */
  focusRequest: { kind: TabKindId; at: number } | null;
  openKind(kind: TabKindId): void;
  pressShortcut(kind: TabKindId): void;
  bringToFront(groupId: GroupId, tab: TabId): void;
  closeTab(groupId: GroupId, tab: TabId): void;
  closeGroup(groupId: GroupId): void;
  moveTab(tab: TabId, toGroupId: GroupId, index: number): void;
  splitWithTab(groupId: GroupId, tab: TabId, edge: Edge): void;
  toggleMaximize(groupId: GroupId): void;
  addPlaceholder(groupId: GroupId): void;
  choosePlaceholder(groupId: GroupId, kind: TabKindId): void;
  setVisible(visible: boolean): void;
  toggleVisible(): void;
  setRememberLayout(remember: boolean): void;
  /** True once, and clears it, when `kind` was requested within the TTL. */
  takeFocusRequest(kind: TabKindId): boolean;
}

/** What is written: the arrangement only while it is remembered, the uses and the setting always. */
export function partializeSidePanel(state: SidePanelState): PersistedSidePanel {
  const { layout, uses, rememberLayout } = state;
  return rememberLayout ? { layout, uses, rememberLayout } : { uses, rememberLayout };
}

/**
 * Folds what storage holds into fresh state. The profile can come from
 * another build or be junk, so nothing in it is spread over `current`: each
 * field is read, repaired or defaulted on its own, and nothing found there
 * throws. A layout is read only while remembering; otherwise the panel starts
 * as the default, a single hidden group.
 */
export function mergeSidePanelState(
  persisted: unknown,
  current: SidePanelState,
  now: number,
): SidePanelState {
  const saved: Record<string, unknown> =
    typeof persisted === 'object' && persisted !== null && !Array.isArray(persisted)
      ? (persisted as Record<string, unknown>)
      : {};
  const rememberLayout = typeof saved.rememberLayout === 'boolean' ? saved.rememberLayout : true;
  const uses = sanitizeUsage(saved.uses, TAB_KIND_IDS, now);
  return {
    ...current,
    layout: rememberLayout ? repairLayout(saved.layout, TAB_KIND_IDS) : Layout.defaultLayout(),
    uses,
    shortcutKinds: rankShortcutKinds(uses, TAB_KIND_IDS, now),
    rememberLayout,
  };
}

export const useSidePanelStore = create<SidePanelState>()(
  persist(
    (set, get) => {
      /** Applies a change to the arrangement, and writes nothing when it did not apply. */
      const arrange = (next: SidePanelLayout) => {
        if (next !== get().layout) set({ layout: next });
      };
      /**
       * The person asked for `kind`. Only when that brings it on screen in
       * front is a use counted and its view asked to take focus; otherwise
       * this is any other change to the arrangement.
       */
      const open = (next: SidePanelLayout, kind: TabKindId) => {
        if (Layout.isInFront(get().layout, kind) || !Layout.isInFront(next, kind)) {
          arrange(next);
          return;
        }
        const now = Date.now();
        set((state) => ({
          layout: next,
          uses: recordUse(state.uses, kind, now),
          focusRequest: { kind, at: now },
        }));
      };

      return {
        layout: Layout.defaultLayout(),
        uses: {},
        shortcutKinds: rankShortcutKinds({}, TAB_KIND_IDS, Date.now()),
        rememberLayout: true,
        focusRequest: null,

        openKind: (kind) => open(Layout.openKind(get().layout, kind), kind),
        pressShortcut: (kind) => open(Layout.pressShortcut(get().layout, kind), kind),
        bringToFront: (groupId, tab) => {
          const next = Layout.bringToFront(get().layout, groupId, tab);
          if (isTabKindId(tab)) open(next, tab);
          else arrange(next);
        },
        closeTab: (groupId, tab) => arrange(Layout.closeTab(get().layout, groupId, tab)),
        closeGroup: (groupId) => arrange(Layout.closeGroup(get().layout, groupId)),
        moveTab: (tab, toGroupId, index) =>
          arrange(Layout.moveTab(get().layout, tab, toGroupId, index)),
        splitWithTab: (groupId, tab, edge) =>
          arrange(Layout.splitWithTab(get().layout, groupId, tab, edge)),
        toggleMaximize: (groupId) => arrange(Layout.toggleMaximize(get().layout, groupId)),
        addPlaceholder: (groupId) => arrange(Layout.addPlaceholder(get().layout, groupId)),
        choosePlaceholder: (groupId, kind) =>
          open(Layout.choosePlaceholder(get().layout, groupId, kind), kind),
        setVisible: (visible) => arrange(Layout.setVisible(get().layout, visible)),
        toggleVisible: () => {
          const { layout } = get();
          arrange(Layout.setVisible(layout, !layout.visible));
        },
        // Off keeps the arrangement on screen; it only stops being written.
        setRememberLayout: (rememberLayout) => set({ rememberLayout }),
        takeFocusRequest: (kind) => {
          const request = get().focusRequest;
          if (request?.kind !== kind) return false;
          set({ focusRequest: null });
          return Date.now() - request.at < FOCUS_REQUEST_TTL_MS;
        },
      };
    },
    {
      name: SIDE_PANEL_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: partializeSidePanel,
      merge: (persisted, current) => mergeSidePanelState(persisted, current, Date.now()),
    },
  ),
);
