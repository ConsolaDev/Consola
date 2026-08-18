import { useEffect } from 'react';
import { Sidebar } from '../Sidebar';
import { AppHeader } from './AppHeader';
import { MainContent } from './MainContent';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import { useTheme } from '../../hooks/useTheme';
import { useWindowDropGuard } from '../../hooks/useWindowDropGuard';
import { useSettings } from '../../contexts/SettingsContext';
import { useCommandPalette } from '../../contexts/CommandPaletteContext';
import { useNavigationStore } from '../../stores/navigationStore';
import { useTerminalStore } from '../../stores/terminalStore';
import './styles.css';

export function Layout() {
  const { openSettings } = useSettings();
  const { togglePalette } = useCommandPalette();
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
  });
  useTheme();
  useWindowDropGuard();

  // Terminals report activity for every session, including ones whose pane is
  // not mounted, so the subscription lives here rather than in the pane.
  useEffect(() => useTerminalStore.getState().subscribeToEvents(), []);

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
