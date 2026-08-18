import { useEffect, useMemo, memo } from 'react';
import { X, PanelLeftClose, PanelLeft, GitBranch } from 'lucide-react';
import { useGitStatusStore } from '../../stores/gitStatusStore';
import { useGitReviewStore } from '../../stores/gitReviewStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { GitReviewFileList } from './GitReviewFileList';
import { GitReviewDiffList } from './GitReviewDiffList';
import { GitReviewCommitBar } from './GitReviewCommitBar';
import { CodeSelectionProvider } from '../../contexts/CodeSelectionContext';
import './styles.css';

interface GitReviewPanelProps {
  /** Instance ID for code selection feature */
  instanceId?: string;
}

export const GitReviewPanel = memo(function GitReviewPanel({ instanceId }: GitReviewPanelProps) {
  const close = useGitReviewStore((state) => state.close);
  const isSidebarCollapsed = useGitReviewStore((state) => state.isSidebarCollapsed);
  const toggleSidebar = useGitReviewStore((state) => state.toggleSidebar);

  const branch = useGitStatusStore((state) => state.branch);
  const fileStatuses = useGitStatusStore((state) => state.fileStatuses);
  const isGitRepo = useGitStatusStore((state) => state.isGitRepo);
  const refresh = useGitStatusStore((state) => state.refresh);

  const activeWorkspaceId = useNavigationStore((state) => state.activeWorkspaceId);
  const getWorkspace = useWorkspaceStore((state) => state.getWorkspace);

  const workspace = activeWorkspaceId ? getWorkspace(activeWorkspaceId) : null;
  const rootPath = workspace?.path ?? null;

  // Refresh git status when panel opens
  useEffect(() => {
    if (rootPath) {
      refresh(rootPath);
    }
  }, [rootPath, refresh]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [close]);

  // Memoize file counts to prevent recalculation on every render
  const { totalCount, stagedCount } = useMemo(() => {
    let total = 0;
    let staged = 0;
    fileStatuses.forEach((status) => {
      total++;
      if (status === 'staged') staged++;
    });
    return { totalCount: total, stagedCount: staged };
  }, [fileStatuses]);

  if (!rootPath) {
    return (
      <div className="git-review-panel">
        <div className="git-review-empty">
          <GitBranch size={48} strokeWidth={1.5} className="git-review-empty-icon" />
          <h3 className="git-review-empty-title">No workspace selected</h3>
          <p className="git-review-empty-description">
            Select a workspace to review changes
          </p>
        </div>
      </div>
    );
  }

  if (!isGitRepo) {
    return (
      <div className="git-review-panel">
        <div className="git-review-main">
          <div className="git-review-main-header">
            <div className="git-review-main-header-left">
              <span className="git-review-main-header-title">Git Changes</span>
            </div>
            <button className="git-review-close-btn" onClick={close} title="Close (Esc)">
              <X size={16} />
            </button>
          </div>
          <div className="git-review-empty">
            <GitBranch size={48} strokeWidth={1.5} className="git-review-empty-icon" />
            <h3 className="git-review-empty-title">Not a git repository</h3>
            <p className="git-review-empty-description">
              Initialize a git repository in this workspace to track changes
            </p>
          </div>
        </div>
      </div>
    );
  }

  const panelContent = (
    <div className="git-review-panel">
      {/* Sidebar */}
      <div className={`git-review-sidebar ${isSidebarCollapsed ? 'collapsed' : ''}`}>
        <div className="git-review-sidebar-header">
          <span className="git-review-sidebar-title">Files</span>
          <button
            className="git-review-sidebar-toggle"
            onClick={toggleSidebar}
            title={isSidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
          >
            {isSidebarCollapsed ? <PanelLeft size={14} /> : <PanelLeftClose size={14} />}
          </button>
        </div>
        {!isSidebarCollapsed && <GitReviewFileList rootPath={rootPath} />}
      </div>

      {/* Main content */}
      <div className="git-review-main">
        {/* Header */}
        <div className="git-review-main-header">
          <div className="git-review-main-header-left">
            {isSidebarCollapsed && (
              <button
                className="git-review-sidebar-toggle"
                onClick={toggleSidebar}
                title="Show sidebar"
                style={{ marginRight: 'var(--space-2)' }}
              >
                <PanelLeft size={14} />
              </button>
            )}
            <span className="git-review-main-header-title">Git Changes</span>
            <span className="git-review-main-header-subtitle">
              {branch && `on ${branch}`} · {totalCount} file{totalCount !== 1 ? 's' : ''} changed
              {stagedCount > 0 && ` · ${stagedCount} approved`}
            </span>
          </div>
          <button className="git-review-close-btn" onClick={close} title="Close (Esc)">
            <X size={16} />
          </button>
        </div>

        {/* Diff list */}
        <GitReviewDiffList rootPath={rootPath} />

        {/* Commit bar */}
        <GitReviewCommitBar rootPath={rootPath} />
      </div>
    </div>
  );

  // Wrap with CodeSelectionProvider if instanceId is available
  if (instanceId && rootPath) {
    return (
      <CodeSelectionProvider instanceId={instanceId} basePath={rootPath}>
        {panelContent}
      </CodeSelectionProvider>
    );
  }

  return panelContent;
});
