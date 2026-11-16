import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import {
  DEFAULT_INBOX_FILTER,
  isInboxUpdatedFilter,
  type InboxFilterState,
  type InboxUpdatedFilter,
} from '../components/Inbox/inboxFilters';

export type ThemeMode = 'light' | 'dark' | 'system';

/**
 * Bounds for the terminal font size.
 *
 * Below 11px JetBrains Mono's hinting stops rescuing the stems on a 1x display;
 * above 20px a pane holds too few columns for Claude's TUI to lay itself out.
 */
export const TERMINAL_FONT_SIZE_MIN = 11;
export const TERMINAL_FONT_SIZE_MAX = 20;
export const TERMINAL_FONT_SIZE_DEFAULT = 14;

/**
 * What a shelf does before the person has touched it. Working is the shelf
 * that is out of the way until asked for; everything else is open.
 */
export const SHELF_DEFAULTS: Record<string, boolean> = { working: false, settled: false };

/** Whether a shelf is open, with its default for a shelf never touched. */
export function isShelfOpen(shelves: Record<string, boolean>, id: string): boolean {
  return shelves[id] ?? SHELF_DEFAULTS[id] ?? true;
}

export function clampTerminalFontSize(size: number): number {
  if (!Number.isFinite(size)) return TERMINAL_FONT_SIZE_DEFAULT;
  return Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(size)));
}

/** Order the theme setting steps through when cycled. */
const THEME_CYCLE: ThemeMode[] = ['light', 'dark', 'system'];

interface SettingsState {
  theme: ThemeMode;
  resolvedTheme: 'light' | 'dark';
  terminalFontSize: number;
  showSidebarModel: boolean;
  setShowSidebarModel: (show: boolean) => void;
  showSidebarHarness: boolean;
  setShowSidebarHarness: (show: boolean) => void;
  /** Name the worktree a session runs in, under its row. */
  showSidebarWorktree: boolean;
  setShowSidebarWorktree: (show: boolean) => void;
  /** The Inbox's repository and Updated filters, per workspace id. */
  inboxFilters: Record<string, InboxFilterState>;
  /**
   * Whether each attention shelf (and each conductor tree) is open, by id.
   *
   * Absence means the section's own default (`SHELF_DEFAULTS`). A tree is
   * keyed by its conductor's entry key and stored only when the person
   * toggled it, so an explicit choice always wins over the derived view.
   */
  sidebarShelfOpen: Record<string, boolean>;
  /** Open a closed shelf or close an open one, from its current effective state. */
  toggleSidebarShelf: (id: string, open?: boolean) => void;
  setTheme: (theme: ThemeMode) => void;
  /** Step to the next theme: light -> dark -> system -> light. */
  cycleTheme: () => void;
  setTerminalFontSize: (size: number) => void;
  setInboxRepoFilter: (workspaceId: string, repos: string[]) => void;
  setInboxUpdatedFilter: (workspaceId: string, updated: InboxUpdatedFilter) => void;
  /** The saved filters, or the shared frozen default when nothing is saved. */
  inboxFilterFor: (workspaceId: string) => InboxFilterState;
  _setResolvedTheme: (theme: 'light' | 'dark') => void;
}

/**
 * Fold a persisted `inboxFilters` blob into a shape the Inbox can trust.
 *
 * Mirrors navigationStore's mergeNavigationState: zustand's default merge
 * would spread whatever an older build or a hand-edited profile wrote
 * straight into state, and the Inbox filters every list through this.
 * Exported so the one place a stale profile can break the view is
 * testable on its own.
 */
export function sanitizeInboxFilters(raw: unknown): Record<string, InboxFilterState> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result: Record<string, InboxFilterState> = {};
  for (const [workspaceId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const candidate = value as Partial<InboxFilterState>;
    result[workspaceId] = {
      repos: Array.isArray(candidate.repos)
        ? candidate.repos.filter((repo): repo is string => typeof repo === 'string')
        : [],
      updated: isInboxUpdatedFilter(candidate.updated)
        ? candidate.updated
        : DEFAULT_INBOX_FILTER.updated,
    };
  }
  return result;
}

/** Guard for the persisted shelf map: only booleans survive. */
export function sanitizeShelfOpen(raw: unknown): Record<string, boolean> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean')
  );
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      theme: 'system',
      resolvedTheme: 'dark',
      terminalFontSize: TERMINAL_FONT_SIZE_DEFAULT,
      showSidebarModel: true,
      setShowSidebarModel: (showSidebarModel) => set({ showSidebarModel }),
      showSidebarHarness: true,
      setShowSidebarHarness: (showSidebarHarness) => set({ showSidebarHarness }),
      showSidebarWorktree: true,
      setShowSidebarWorktree: (showSidebarWorktree) => set({ showSidebarWorktree }),
      inboxFilters: {},
      sidebarShelfOpen: {},
      toggleSidebarShelf: (id, open) =>
        set((state) => ({
          sidebarShelfOpen: { ...state.sidebarShelfOpen, [id]: open ?? !isShelfOpen(state.sidebarShelfOpen, id) },
        })),
      setTheme: (theme) => set({ theme }),
      // Lives in the store so the keyboard shortcut and the command palette
      // can never disagree about what "next theme" means.
      cycleTheme: () =>
        set((state) => ({
          theme: THEME_CYCLE[(THEME_CYCLE.indexOf(state.theme) + 1) % THEME_CYCLE.length],
        })),
      setTerminalFontSize: (size) => set({ terminalFontSize: clampTerminalFontSize(size) }),
      setInboxRepoFilter: (workspaceId, repos) =>
        set((state) => ({
          inboxFilters: {
            ...state.inboxFilters,
            [workspaceId]: { ...state.inboxFilterFor(workspaceId), repos },
          },
        })),
      setInboxUpdatedFilter: (workspaceId, updated) =>
        set((state) => ({
          inboxFilters: {
            ...state.inboxFilters,
            [workspaceId]: { ...state.inboxFilterFor(workspaceId), updated },
          },
        })),
      // The default is one frozen object, returned by reference: selectors
      // comparing by identity stay stable, and nothing can mutate it.
      inboxFilterFor: (workspaceId) => get().inboxFilters[workspaceId] ?? DEFAULT_INBOX_FILTER,
      _setResolvedTheme: (resolvedTheme) => set({ resolvedTheme }),
    }),
    {
      name: 'consola-settings',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        theme: state.theme,
        showSidebarModel: state.showSidebarModel,
        showSidebarHarness: state.showSidebarHarness,
        showSidebarWorktree: state.showSidebarWorktree,
        terminalFontSize: state.terminalFontSize,
        inboxFilters: state.inboxFilters,
        sidebarShelfOpen: state.sidebarShelfOpen,
      }),
      // A persisted size from an older build (or a hand-edited value) still has
      // to land inside the bounds the terminal can actually lay out, and a
      // persisted filter blob has to be a shape the Inbox can filter with.
      merge: (persisted, current) => {
        const saved = persisted as Partial<SettingsState> | undefined;
        return {
          ...current,
          ...saved,
          showSidebarModel: typeof saved?.showSidebarModel === 'boolean' ? saved.showSidebarModel : true,
          showSidebarHarness: typeof saved?.showSidebarHarness === 'boolean' ? saved.showSidebarHarness : true,
          showSidebarWorktree: typeof saved?.showSidebarWorktree === 'boolean' ? saved.showSidebarWorktree : true,
          terminalFontSize: clampTerminalFontSize(
            saved?.terminalFontSize ?? TERMINAL_FONT_SIZE_DEFAULT
          ),
          inboxFilters: sanitizeInboxFilters(saved?.inboxFilters),
          sidebarShelfOpen: sanitizeShelfOpen(saved?.sidebarShelfOpen),
        };
      },
    }
  )
);
