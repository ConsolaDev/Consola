import { useEffect } from 'react';
import { Sidebar } from '../Sidebar';
import { AppHeader } from './AppHeader';
import { MainContent } from './MainContent';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import { useTheme } from '../../hooks/useTheme';
import { useWindowDropGuard } from '../../hooks/useWindowDropGuard';
import { useSettings } from '../../contexts/SettingsContext';
import { useCommandPalette } from '../../contexts/CommandPaletteContext';
import {
  useNavigationStore,
  subscribeToWindowWorkspace,
  subscribeToActivateSession,
} from '../../stores/navigationStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { useInboxStore } from '../../stores/inboxStore';
import './styles.css';

export function Layout() {
  const { openSettings } = useSettings();
  const { togglePalette, openPalette } = useCommandPalette();
  const activeWorkspaceId = useNavigationStore((state) => state.activeWorkspaceId);
  const setActiveSession = useNavigationStore((state) => state.setActiveSession);

  const handleNewSession = () => {
    // Only enter new session view if a workspace is selected
    if (activeWorkspaceId) {
      setActiveSession(null);
    }
  };

  useKeyboardShortcuts({
    onNewSession: handleNewSession,
    onOpenSettings: openSettings,
    onTogglePalette: togglePalette,
    onOpenScopedPalette: openPalette,
  });
  useTheme();
  useWindowDropGuard();

  // Terminals report activity for every session, including ones whose pane is
  // not mounted, so the subscription lives here rather than in the pane.
  useEffect(() => useTerminalStore.getState().subscribeToEvents(), []);

  // Inbox snapshots arrive on main's push channel for every github-bound
  // workspace, including ones whose pane is not mounted.
  useEffect(() => useInboxStore.getState().subscribeToEvents(), []);

  // Main can drop this window's workspace out from under it, e.g. when it was
  // deleted from another window.
  useEffect(() => subscribeToWindowWorkspace(), []);

  // A notification click can land on a window that is already open.
  useEffect(() => subscribeToActivateSession(), []);

  return (
    <div className="layout">
      <AppHeader />
      <div className="layout-body">
        <Sidebar />
        <main className="content-area">
          <MainContent />
        </main>
      </div>
    </div>
  );
}
