import { useEffect } from 'react';
import { useNavigationStore } from '../stores/navigationStore';
import { useSettingsStore } from '../stores/settingsStore';
import { isCommandPaletteShortcut, matchScopeShortcut } from '../utils/platform';
import { windowBridge } from '../services/windowBridge';
import type { PaletteScope } from '../components/CommandPalette/types';

interface UseKeyboardShortcutsOptions {
  onNewSession?: () => void;
  onOpenSettings?: () => void;
  onTogglePalette?: () => void;
  onOpenScopedPalette?: (scope: PaletteScope) => void;
}

/**
 * The app's global shortcuts.
 *
 * One listener owns them all, mounted once from the layout. It sits on
 * `window` in the bubble phase, which reaches it even while the terminal has
 * focus: xterm handles keys on its own textarea and, with `cancelEvents` off,
 * never stops them propagating.
 */
export function useKeyboardShortcuts(options: UseKeyboardShortcutsOptions = {}) {
  const toggleSidebar = useNavigationStore((state) => state.toggleSidebar);
  const toggleExplorer = useNavigationStore((state) => state.toggleExplorer);
  const cycleTheme = useSettingsStore((state) => state.cycleTheme);
  const { onNewSession, onOpenSettings, onTogglePalette, onOpenScopedPalette } = options;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Checked first, and via its own predicate: the palette chord differs
      // per platform because a bare Ctrl+letter would reach the PTY instead.
      if (isCommandPaletteShortcut(event)) {
        event.preventDefault();
        onTogglePalette?.();
        return;
      }

      // The scoped chords open rather than toggle: pressing one while the
      // palette is up should re-aim it, not dismiss it.
      const scope = matchScopeShortcut(event);
      if (scope) {
        event.preventDefault();
        onOpenScopedPalette?.(scope);
        return;
      }

      const isMod = event.metaKey || event.ctrlKey;

      // Cmd/Ctrl + \ : Toggle sidebar
      if (isMod && event.key === '\\') {
        event.preventDefault();
        toggleSidebar();
        return;
      }

      // Cmd/Ctrl + Shift + N : Open another window
      // Checked before the ⌘N branch below: ⌘⇧N also satisfies `event.key === 'n'`,
      // so this would never fire if it came second.
      if (isMod && event.shiftKey && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        void windowBridge.openWindow(null);
        return;
      }

      // Cmd/Ctrl + N : New session (enters new session view for current workspace)
      if (isMod && event.key === 'n') {
        event.preventDefault();
        onNewSession?.();
        return;
      }

      // Cmd/Ctrl + , : Open settings
      if (isMod && event.key === ',') {
        event.preventDefault();
        onOpenSettings?.();
        return;
      }

      // Cmd/Ctrl + Shift + T : Toggle theme
      if (isMod && event.shiftKey && event.key === 't') {
        event.preventDefault();
        cycleTheme();
        return;
      }

      // Cmd/Ctrl + Shift + E : Toggle file explorer
      if (isMod && event.shiftKey && event.key === 'e') {
        event.preventDefault();
        toggleExplorer();
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    toggleSidebar,
    toggleExplorer,
    cycleTheme,
    onNewSession,
    onOpenSettings,
    onTogglePalette,
    onOpenScopedPalette,
  ]);
}
