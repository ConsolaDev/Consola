import { useTabStore } from '../../stores/tabStore';
import { HomeView, ContentView } from '../Views';

export function TabContent() {
  const tabs = useTabStore((state) => state.tabs);
  const activeTabId = useTabStore((state) => state.activeTabId);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  if (!activeTab) {
    return <HomeView />;
  }

  switch (activeTab.type) {
    case 'home':
      return <HomeView />;
    case 'workspace':
      return <ContentView workspaceId={activeTab.targetId} />;
    case 'project':
      return (
        <ContentView
          workspaceId={activeTab.workspaceId!}
          projectId={activeTab.targetId}
        />
      );
    default:
      return <HomeView />;
  }
}
