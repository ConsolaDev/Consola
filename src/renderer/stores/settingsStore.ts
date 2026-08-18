import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

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
  setTheme: (theme: ThemeMode) => void;
  /** Step to the next theme: light -> dark -> system -> light. */
  cycleTheme: () => void;
  setTerminalFontSize: (size: number) => void;
  _setResolvedTheme: (theme: 'light' | 'dark') => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: 'system',
      resolvedTheme: 'dark',
      terminalFontSize: TERMINAL_FONT_SIZE_DEFAULT,
      setTheme: (theme) => set({ theme }),
      // Lives in the store so the keyboard shortcut and the command palette
      // can never disagree about what "next theme" means.
      cycleTheme: () =>
        set((state) => ({
          theme: THEME_CYCLE[(THEME_CYCLE.indexOf(state.theme) + 1) % THEME_CYCLE.length],
        })),
      setTerminalFontSize: (size) => set({ terminalFontSize: clampTerminalFontSize(size) }),
      _setResolvedTheme: (resolvedTheme) => set({ resolvedTheme }),
    }),
    {
      name: 'consola-settings',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        theme: state.theme,
        terminalFontSize: state.terminalFontSize,
      }),
      // A persisted size from an older build (or a hand-edited value) still has
      // to land inside the bounds the terminal can actually lay out.
      merge: (persisted, current) => {
        const saved = persisted as Partial<SettingsState> | undefined;
        return {
          ...current,
          ...saved,
          terminalFontSize: clampTerminalFontSize(
            saved?.terminalFontSize ?? TERMINAL_FONT_SIZE_DEFAULT
          ),
        };
      },
    }
  )
);
