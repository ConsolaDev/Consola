import { isShellShortcut } from '../utils/shellShortcut';
import { useShellStore } from '../stores/shellStore';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { useEffect } from 'react';
import { useNavigationStore } from '../stores/navigationStore';
import { useSettingsStore } from '../stores/settingsStore';
import { usePreviewTabStore } from '../stores/previewTabStore';
import { useSidePanelStore } from '../stores/sidePanelStore';
import { useBrowserSlotStore } from '../stores/browserSlotStore';
import { useBrowserStore } from '../stores/browserStore';
import { requestBrowserPanelFocus } from '../stores/browserPanelFocusStore';
import { closeTarget, isCloseShortcut, type KeyboardPlace } from '../utils/closeShortcut';
import { pressShortcutOnScreen } from '../utils/sidePanelActions';
import { isInFront } from '../sidePanel/layout';
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
import { visibleTabId } from '../components/Browser/browserView';
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

      // ⌘W closes the nearest thing on screen; held, it closes one.
      if (isCloseShortcut(event)) {
        event.preventDefault();
        if (!event.repeat) closeNearest(keyboardPlaceOf(document.activeElement));
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

      // Cmd/Ctrl + Shift + E : the Files tab, as its header button does.
      // With Shift held, `key` is the capital.
      if (isMod && event.shiftKey && event.key.toLowerCase() === 'e') {
        event.preventDefault();
        if (!event.repeat) pressShortcutOnScreen('files');
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
        // Main sends a held ⌘W once, so this is one press.
        case 'close':
          closeNearest({ in: 'page', tabId });
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
    toggleBrowser,
    cycleTheme,
    onNewSession,
    onNewSessionWithOptions,
    onOpenSettings,
    onTogglePalette,
    onOpenScopedPalette,
  ]);
}

/**
 * The browser's own controls: the panel (toolbar, tab strip, find bar), what
 * is drawn over a page (a sign-in, an error), and the toolbar's menu, which is
 * portalled out of the panel and marked instead. A page's own keys never
 * reach this document: main forwards them, and says so.
 */
const BROWSER_CONTROLS = '.browser-panel, .browser-host, [data-browser-control]';

/** Where the keyboard is, for a ⌘W this document heard itself. */
function keyboardPlaceOf(focused: Element | null): KeyboardPlace {
  return focused?.closest(BROWSER_CONTROLS) ? { in: 'browser-panel' } : { in: 'elsewhere' };
}

/** Close whatever `closeTarget` names, if anything. */
function closeNearest(keyboard: KeyboardPlace): void {
  const navigation = useNavigationStore.getState();
  const preview = usePreviewTabStore.getState();
  const shownBrowserTabId = visibleTabId(
    useBrowserSlotStore.getState().sessionId,
    useBrowserStore.getState().snapshots,
  );
  const target = closeTarget({
    overlay: navigation.overlay,
    activeSessionId: navigation.activeSessionId,
    activePreviewTabId: preview.activeTabId,
    filesTabOnScreen: isInFront(useSidePanelStore.getState().layout, 'files'),
    shownBrowserTabId,
    keyboard,
  });
  // Leaving the overlay returns to the session it lay over, exactly as
  // clicking that session's row does.
  if (target === 'overlay') navigation.setActiveSession(navigation.activeSessionId);
  else if (target === 'browser-tab' && shownBrowserTabId) {
    // What the tab's close button does. The keyboard was in the browser and
    // stays there, so a second ⌘W closes the next tab.
    requestBrowserPanelFocus();
    browserBridge
      .close(shownBrowserTabId)
      .catch((error: unknown) => console.warn('In-app browser action failed:', error));
  } else if (target === 'preview-tab' && preview.activeTabId) preview.closeTab(preview.activeTabId);
}
