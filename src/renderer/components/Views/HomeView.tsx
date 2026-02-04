import { Plus, Sparkles } from 'lucide-react';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useTabStore } from '../../stores/tabStore';
import './styles.css';

export function HomeView() {
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const createWorkspace = useWorkspaceStore((state) => state.createWorkspace);
  const openTab = useTabStore((state) => state.openTab);

  const handleCreateWorkspace = () => {
    const workspace = createWorkspace('New Workspace');
    openTab('workspace', workspace.id);
  };

  return (
    <div className="home-view">
      <div className="home-view-content">
        <div className="home-view-icon">
          <Sparkles size={48} strokeWidth={1.5} />
        </div>
        <h1 className="home-view-title">Welcome to Consola</h1>
        <p className="home-view-description">
          {workspaces.length === 0
            ? 'Create your first workspace to get started'
            : 'Select a workspace from the sidebar or create a new one'}
        </p>
        <button className="home-view-button" onClick={handleCreateWorkspace}>
          <Plus size={18} />
          <span>New Workspace</span>
        </button>
        <div className="home-view-shortcut">
          Press <kbd>⌘</kbd> + <kbd>N</kbd> to create a workspace
        </div>
      </div>
    </div>
  );
}
