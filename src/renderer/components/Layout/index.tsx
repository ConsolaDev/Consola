import { Sidebar } from '../Sidebar';
import { AppHeader } from './AppHeader';
import { MainContent } from './MainContent';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import { useTheme } from '../../hooks/useTheme';
import { useSettings } from '../../contexts/SettingsContext';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { dialogBridge } from '../../services/dialogBridge';
import './styles.css';

export function Layout() {
  const { openSettings } = useSettings();
  const createWorkspace = useWorkspaceStore((state) => state.createWorkspace);
  const setActiveWorkspace = useNavigationStore((state) => state.setActiveWorkspace);

  const handleNewWorkspace = async () => {
    const result = await dialogBridge.selectFolder();
    if (result) {
      const workspace = createWorkspace(result.name, result.path, result.isGitRepo);
      setActiveWorkspace(workspace.id);
    }
  };

  useKeyboardShortcuts({
    onNewWorkspace: handleNewWorkspace,
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
