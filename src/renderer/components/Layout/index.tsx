import { Sidebar } from '../Sidebar';
import { AppHeader } from './AppHeader';
import { TabContent } from './TabContent';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import { useTheme } from '../../hooks/useTheme';
import { useCreateWorkspace } from '../../contexts/CreateWorkspaceContext';
import { useSettings } from '../../contexts/SettingsContext';
import { useTabStore } from '../../stores/tabStore';
import './styles.css';

export function Layout() {
  const { openDialog } = useCreateWorkspace();
  const { openSettings } = useSettings();
  const activeTabId = useTabStore((state) => state.activeTabId);
  const closeTab = useTabStore((state) => state.closeTab);
  useKeyboardShortcuts({
    onNewWorkspace: openDialog,
    onCloseActiveTab: () => closeTab(activeTabId),
    onOpenSettings: openSettings,
  });
  useTheme();

  return (
    <div className="layout">
      <AppHeader />
      <div className="layout-body">
        <Sidebar />
        <main className="content-area">
          <TabContent />
        </main>
      </div>
    </div>
  );
}
