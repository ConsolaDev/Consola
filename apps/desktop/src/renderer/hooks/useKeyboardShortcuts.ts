import { isShellShortcut } from '../utils/shellShortcut';
import { useShellStore } from '../stores/shellStore';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { useEffect } from 'react';
import { useNavigationStore } from '../stores/navigationStore';
import { useSettingsStore } from '../stores/settingsStore';
import {
  isBrowserShortcut,
  isCommandPaletteShortcut,
  isSidebarShortcut,
  isWorkingShelfShortcut,
  matchScopeShortcut,
  matchWorkspaceShortcut,
} from '../utils/platform';
import { windowBridge } from '../services/windowBridge';
import { browserBridge } from '../services/browserBridge';
import { handleBrowserAction } from '../components/Browser/handleBrowserAction';
import type { PaletteScope } from '../components/CommandPalette/types';

interface UseKeyboardShortcutsOptions {
  onNewSession?: () => void;
  onNewSessionWithOptions?: () => void;
  onOpenSettings?: () => void;
  onTogglePalette?: () => void;
  onOpenScopedPalette?: (scope: PaletteScope) => void;
}

/** Jumps to the workspace at `index` on the rail. False when there is none. */
function switchToWorkspaceAt(index: number, repeat: boolean): boolean {
  const workspace = useWorkspaceStore.getState().workspaces[index];
  if (!workspace) return false;
  if (!repeat) void useNavigationStore.getState().setActiveWorkspace(workspace.id);
  return true;
}

/** Shows or hides the open session's terminal. False when no session is open. */
function toggleOpenSessionShell(repeat: boolean): boolean {
  const { activeWorkspaceId, activeSessionId, overlay } = useNavigationStore.getState();
  if (!activeWorkspaceId || !activeSessionId || overlay !== null) return false;
  const session = useWorkspaceStore.getState().getSession(activeWorkspaceId, activeSessionId);
  if (!session) return false;
  if (!repeat) useShellStore.getState().toggle(session.instanceId);
  return true;
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
  const toggleBrowser = useNavigationStore((state) => state.toggleBrowser);
  const cycleTheme = useSettingsStore((state) => state.cycleTheme);
  const {
    onNewSession,
    onNewSessionWithOptions,
    onOpenSettings,
    onTogglePalette,
    onOpenScopedPalette,
  } = options;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const workspaceIndex = matchWorkspaceShortcut(event);
      if (workspaceIndex !== null) {
        if (switchToWorkspaceAt(workspaceIndex, event.repeat)) event.preventDefault();
        return;
      }

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

      // Shows or hides the Working shelf: the one chord for the shelf that
      // starts collapsed.
      if (isWorkingShelfShortcut(event)) {
        event.preventDefault();
        if (!event.repeat) useSettingsStore.getState().toggleSidebarShelf('working');
        return;
      }

      // Shows or hides the browser panel beside the session.
      if (isBrowserShortcut(event)) {
        event.preventDefault();
        if (!event.repeat) toggleBrowser();
        return;
      }

      if (isShellShortcut(event)) {
        if (toggleOpenSessionShell(event.repeat)) event.preventDefault();
        return;
      }

      const isMod = event.metaKey || event.ctrlKey;

      // Cmd/Ctrl + \ : Toggle sidebar
      if (isSidebarShortcut(event)) {
        event.preventDefault();
        toggleSidebar();
        return;
      }

      // Keep window creation available on Cmd/Ctrl + Alt + N.
      if (isMod && event.altKey && !event.shiftKey && event.code === 'KeyN') {
        event.preventDefault();
        if (!event.repeat) void windowBridge.openWindow(null);
        return;
      }

      // Cmd/Ctrl + N starts immediately; adding Shift opens session options.
      if (isMod && !event.altKey && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        if (!event.repeat) {
          if (event.shiftKey) onNewSessionWithOptions?.();
          else onNewSession?.();
        }
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

    // A chord pressed inside a page never reaches the listener above: a
    // focused `<webview>` keeps its keys. Main takes the app's chords from the
    // page and sends them here, to run the same actions. Whatever is not an
    // app chord is one of the browser's own, which `handleBrowserAction` owns.
    const stopForwarded = browserBridge.onShortcut(({ tabId, action }) => {
      switch (action.kind) {
        case 'workspace':
          switchToWorkspaceAt(action.index, false);
          return;
        case 'command-palette':
          onTogglePalette?.();
          return;
        case 'scoped-palette':
          onOpenScopedPalette?.(action.scope);
          return;
        case 'sidebar':
          toggleSidebar();
          return;
        case 'terminal':
          toggleOpenSessionShell(false);
          return;
        case 'browser':
          toggleBrowser();
          return;
        default:
          handleBrowserAction(tabId, action);
      }
    });

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      stopForwarded();
    };
  }, [
    toggleSidebar,
    toggleExplorer,
    toggleBrowser,
    cycleTheme,
    onNewSession,
    onNewSessionWithOptions,
    onOpenSettings,
    onTogglePalette,
    onOpenScopedPalette,
  ]);
}
