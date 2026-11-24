import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import * as Layout from '../sidePanel/layout';
import type { Edge, GroupId, SidePanelLayout, TabId } from '../sidePanel/layout';
import { repairLayout } from '../sidePanel/repairLayout';
import { isTabKindId, TAB_KIND_IDS } from '../sidePanel/tabKinds';
import type { TabKindId } from '../sidePanel/tabKinds';
import { rankShortcutKinds, recordUse, sanitizeUsage } from '../sidePanel/usage';
import type { UsageLog } from '../sidePanel/usage';

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
 * - **The "+" list asks for focus by the same rule, and counts nothing.**
 *   The placeholder is not a kind, so no use is recorded for it, but when
 *   the person's own action brings it on screen in front where it was not
 *   before, a request is set for `NEW_TAB`: `addPlaceholder` (the "+"
 *   button), `bringToFront` (its tab clicked), and `setVisible(true)` or
 *   `toggleVisible` (the header's toggle, its chord, the palette), whether
 *   showing adds the placeholder or finds it already in front. Showing does
 *   this for the placeholder alone: a kind that comes back on screen with
 *   the panel was already in front of its group, and counts and asks
 *   nothing, as before. Closing, moving, splitting and maximizing ask for
 *   neither. A list that mounts at launch, on a session switch or on the
 *   way back from an overlay meets no action, so it leaves the keyboard
 *   where it was, and the letters typed for the conversation never choose
 *   a kind.
 * - **The header's shortcut set is fixed for the run.** `shortcutKinds` is
 *   ranked once, when the stored uses are read, and no action touches it, so
 *   nothing moves under the pointer however the counts change.
 *
 * Whether the person wants the info panel sits here too, beside the layout
 * rather than in it (`layout.ts` is the side panel's arrangement only), and
 * follows the same remember setting. Whether it is on screen also depends on
 * the room (`infoPanelRoomStore`), which is never written here. Showing or
 * hiding it counts nothing and asks for no focus: the panel never takes the
 * keyboard.
 *
 * A row of the info panel with a place in a tab behind it (the checks line,
 * the pull request's merge card) asks with `reveal`: it opens the kind
 * exactly as `openKind` does, counting and asking for focus by the same
 * rule, and leaves a `revealRequest` the kind's view acts on once.
 *
 * Persisted to localStorage, which every window shares: each window holds its
 * own copy and the last write wins, as for the other renderer preferences.
 */

export const SIDE_PANEL_STORAGE_KEY = 'consola-side-panel';
/** How long a focus request waits for its view to mount and take it. */
export const FOCUS_REQUEST_TTL_MS = 5_000;

/** What a focus request names: a kind, or the placeholder, whose "+" list takes the keyboard. */
export type FocusTarget = TabKindId | typeof Layout.NEW_TAB;

/**
 * A place inside a kind's view that the person asked to see (the info
 * panel's checks line asks for the pull request's merge card), for one
 * session. Every ask is a new `seq`, which the view acts on once.
 */
export interface RevealRequest {
  kind: TabKindId;
  sessionId: string;
  /** What the kind's view knows the place as. */
  target: string;
  seq: number;
}

export interface PersistedSidePanel {
  layout?: SidePanelLayout;
  /** Written exactly when `layout` is. */
  infoVisible?: boolean;
  uses: UsageLog;
  rememberLayout: boolean;
}

export interface SidePanelState {
  layout: SidePanelLayout;
  /** Whether the info panel shows beside the conversation. */
  infoVisible: boolean;
  uses: UsageLog;
  /** The header's kinds, worked out once when this window's store is created and never again while it runs. */
  shortcutKinds: readonly TabKindId[];
  rememberLayout: boolean;
  /** Not persisted: the kind, or the "+" list, the person just asked for, which its view may focus once. */
  focusRequest: { kind: FocusTarget; at: number } | null;
  /** Not persisted: the last place asked for inside a kind's view. */
  revealRequest: RevealRequest | null;
  openKind(kind: TabKindId): void;
  /** openKind(kind), then, with a target, a new request the kind's view acts on once. */
  reveal(kind: TabKindId, sessionId: string, target?: string): void;
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
  /** The person's own show or hide. The toggles go through `toggleInfoPanel`, which knows what is on screen. */
  setInfoVisible(visible: boolean): void;
  setRememberLayout(remember: boolean): void;
  /** True once, and clears it, when `kind` was requested within the TTL. */
  takeFocusRequest(kind: FocusTarget): boolean;
}

/**
 * What is written: the arrangement, and whether the info panel shows, only
 * while they are remembered; the uses and the setting always.
 */
export function partializeSidePanel(state: SidePanelState): PersistedSidePanel {
  const { layout, infoVisible, uses, rememberLayout } = state;
  return rememberLayout ? { layout, infoVisible, uses, rememberLayout } : { uses, rememberLayout };
}

/**
 * Folds what storage holds into fresh state. The profile can come from
 * another build or be junk, so nothing in it is spread over `current`: each
 * field is read, repaired or defaulted on its own, and nothing found there
 * throws. A layout is read only while remembering; otherwise the panel starts
 * as the default, a single hidden group. The info panel shows unless a
 * remembered profile says it was hidden, so a new install and a profile from
 * before it existed both show it.
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
    infoVisible:
      rememberLayout && typeof saved.infoVisible === 'boolean' ? saved.infoVisible : true,
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
       * The person asked for `target`, a kind or the "+" list. Only when that
       * brings it on screen in front is its view asked to take focus, and a
       * kind's use counted (the placeholder is not a kind, so it counts
       * nothing); otherwise this is any other change to the arrangement.
       */
      const open = (next: SidePanelLayout, target: FocusTarget) => {
        if (Layout.isInFront(get().layout, target) || !Layout.isInFront(next, target)) {
          arrange(next);
          return;
        }
        const now = Date.now();
        set((state) => ({
          layout: next,
          uses: target === Layout.NEW_TAB ? state.uses : recordUse(state.uses, target, now),
          focusRequest: { kind: target, at: now },
        }));
      };
      /**
       * Showing the panel asks on behalf of the "+" list alone: a kind that
       * comes back on screen this way was already its group's front tab, and
       * showing counts and asks nothing for it.
       */
      const show = (visible: boolean) =>
        open(Layout.setVisible(get().layout, visible), Layout.NEW_TAB);

      return {
        layout: Layout.defaultLayout(),
        infoVisible: true,
        uses: {},
        shortcutKinds: rankShortcutKinds({}, TAB_KIND_IDS, Date.now()),
        rememberLayout: true,
        focusRequest: null,
        revealRequest: null,

        openKind: (kind) => open(Layout.openKind(get().layout, kind), kind),
        reveal: (kind, sessionId, target) => {
          get().openKind(kind);
          if (target === undefined) return;
          set((state) => ({
            revealRequest: {
              kind,
              sessionId,
              target,
              seq: (state.revealRequest?.seq ?? 0) + 1,
            },
          }));
        },
        pressShortcut: (kind) => open(Layout.pressShortcut(get().layout, kind), kind),
        bringToFront: (groupId, tab) => {
          const next = Layout.bringToFront(get().layout, groupId, tab);
          if (tab === Layout.NEW_TAB || isTabKindId(tab)) open(next, tab);
          else arrange(next);
        },
        closeTab: (groupId, tab) => arrange(Layout.closeTab(get().layout, groupId, tab)),
        closeGroup: (groupId) => arrange(Layout.closeGroup(get().layout, groupId)),
        moveTab: (tab, toGroupId, index) =>
          arrange(Layout.moveTab(get().layout, tab, toGroupId, index)),
        splitWithTab: (groupId, tab, edge) =>
          arrange(Layout.splitWithTab(get().layout, groupId, tab, edge)),
        toggleMaximize: (groupId) => arrange(Layout.toggleMaximize(get().layout, groupId)),
        addPlaceholder: (groupId) =>
          open(Layout.addPlaceholder(get().layout, groupId), Layout.NEW_TAB),
        choosePlaceholder: (groupId, kind) =>
          open(Layout.choosePlaceholder(get().layout, groupId, kind), kind),
        setVisible: show,
        toggleVisible: () => show(!get().layout.visible),
        setInfoVisible: (infoVisible) => set({ infoVisible }),
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
