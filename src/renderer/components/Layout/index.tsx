import { Sidebar } from '../Sidebar';
import { AppHeader } from './AppHeader';
import { MainContent } from './MainContent';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import { useTheme } from '../../hooks/useTheme';
import { useSettings } from '../../contexts/SettingsContext';
import { useNavigationStore } from '../../stores/navigationStore';
import './styles.css';

export function Layout() {
  const { openSettings } = useSettings();
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
  });
  useTheme();

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
