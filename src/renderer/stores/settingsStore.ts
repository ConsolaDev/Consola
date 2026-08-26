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
  /** The Inbox's repository and Updated filters, per workspace id. */
  inboxFilters: Record<string, InboxFilterState>;
  /**
   * Scope and group ids whose sidebar section is folded shut.
   *
   * One list holds both kinds. They are drawn from the same `generateId()`,
   * so an id names a section on its own and nothing here has to know which
   * kind it got. Absent means expanded, which is what keeps a fresh profile
   * looking exactly like the sidebar always did.
   *
   * Ids outlive what they pointed at: removing a scope leaves its id behind
   * here. Harmless, since ids are never reused — an inert string, not a
   * fold that could reattach to something else later.
   */
  collapsedSidebarSections: string[];
  setTheme: (theme: ThemeMode) => void;
  /** Step to the next theme: light -> dark -> system -> light. */
  cycleTheme: () => void;
  setTerminalFontSize: (size: number) => void;
  setInboxRepoFilter: (workspaceId: string, repos: string[]) => void;
  setInboxUpdatedFilter: (workspaceId: string, updated: InboxUpdatedFilter) => void;
  /** The saved filters, or the shared frozen default when nothing is saved. */
  inboxFilterFor: (workspaceId: string) => InboxFilterState;
  /** Fold an expanded sidebar section, or unfold a folded one. */
  toggleSidebarSection: (id: string) => void;
  /** Unfold a section, doing nothing at all when it is already open. */
  expandSidebarSection: (id: string) => void;
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

/**
 * Fold a persisted `collapsedSidebarSections` blob into a list of ids.
 *
 * Same guard as sanitizeInboxFilters and for the same reason: zustand's
 * default merge would hand the sidebar whatever an older build or a
 * hand-edited profile left behind, and every scope row asks this list
 * whether it is open. Deduped so `toggle` cannot need two clicks to unfold
 * a section a bad profile listed twice.
 */
export function sanitizeCollapsedSections(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((id): id is string => typeof id === 'string'))];
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      theme: 'system',
      resolvedTheme: 'dark',
      terminalFontSize: TERMINAL_FONT_SIZE_DEFAULT,
      inboxFilters: {},
      collapsedSidebarSections: [],
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
      toggleSidebarSection: (id) =>
        set((state) => ({
          collapsedSidebarSections: state.collapsedSidebarSections.includes(id)
            ? state.collapsedSidebarSections.filter((candidate) => candidate !== id)
            : [...state.collapsedSidebarSections, id],
        })),
      // Guarded rather than unconditional: activating a session fires this on
      // every navigation, and an unguarded set would re-serialise the whole
      // store to localStorage each time for a list that did not change.
      expandSidebarSection: (id) => {
        if (!get().collapsedSidebarSections.includes(id)) return;
        set((state) => ({
          collapsedSidebarSections: state.collapsedSidebarSections.filter(
            (candidate) => candidate !== id
          ),
        }));
      },
      _setResolvedTheme: (resolvedTheme) => set({ resolvedTheme }),
    }),
    {
      name: 'consola-settings',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        theme: state.theme,
        terminalFontSize: state.terminalFontSize,
        inboxFilters: state.inboxFilters,
        collapsedSidebarSections: state.collapsedSidebarSections,
      }),
      // A persisted size from an older build (or a hand-edited value) still has
      // to land inside the bounds the terminal can actually lay out, and a
      // persisted filter blob has to be a shape the Inbox can filter with.
      merge: (persisted, current) => {
        const saved = persisted as Partial<SettingsState> | undefined;
        return {
          ...current,
          ...saved,
          terminalFontSize: clampTerminalFontSize(
            saved?.terminalFontSize ?? TERMINAL_FONT_SIZE_DEFAULT
          ),
          inboxFilters: sanitizeInboxFilters(saved?.inboxFilters),
          collapsedSidebarSections: sanitizeCollapsedSections(saved?.collapsedSidebarSections),
        };
      },
    }
  )
);
