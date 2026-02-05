import * as Tooltip from '@radix-ui/react-tooltip';
import { FolderTree, RotateCw, GitBranch } from 'lucide-react';
import { useGitStatusStore } from '../../stores/gitStatusStore';

interface PathDisplayProps {
  path: string;
  className?: string;
  showExplorerToggle?: boolean;
  isExplorerVisible?: boolean;
  onToggleExplorer?: () => void;
}

const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
const explorerShortcut = isMac ? '⇧⌘E' : 'Ctrl+Shift+E';

/**
 * Truncate a file path to show a sensible shortened version.
 * Shows ~ for home directory and last 2-3 path segments.
 */
function truncatePath(fullPath: string): string {
  const homeDir = '/Users/';
  let path = fullPath;

  if (path.startsWith(homeDir)) {
    const afterHome = path.slice(homeDir.length);
    const firstSlash = afterHome.indexOf('/');
    if (firstSlash !== -1) {
      path = '~' + afterHome.slice(firstSlash);
    }
  }

  const segments = path.split('/').filter(Boolean);

  if (segments.length <= 3) {
    return path.startsWith('/') ? '/' + segments.join('/') : segments.join('/');
  }

  const firstPart = path.startsWith('~') ? '~' : '';
  const lastSegments = segments.slice(-2).join('/');

  return `${firstPart}/.../${lastSegments}`;
}

export function PathDisplay({
  path,
  className,
  showExplorerToggle = false,
  isExplorerVisible = false,
  onToggleExplorer
}: PathDisplayProps) {
  const { stats, isLoading, isGitRepo, branch, refresh } = useGitStatusStore();

  const handleRefresh = () => {
    if (path && !isLoading) {
      refresh(path);
    }
  };

  return (
    <div className="path-display-container">
      <Tooltip.Provider delayDuration={300}>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <span className={`path-display-text ${className || ''}`}>
              {truncatePath(path)}
            </span>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content className="tooltip-content" sideOffset={5}>
              {path}
              <Tooltip.Arrow className="tooltip-arrow" />
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      </Tooltip.Provider>

      {/* Right side actions - git status and explorer toggle */}
      <div className="path-display-actions">
        {/* Git branch and stats badge - show if it's a git repo */}
        {isGitRepo && (
          <div className="git-stats-badge">
            {branch && (
              <>
                <GitBranch size={14} className="git-branch-icon" />
                <span className="git-branch-name">{branch}</span>
              </>
            )}
            {stats.modifiedCount > 0 && (
              <>
                <span className="git-stats-separator">·</span>
                <span className="git-stats-count">{stats.modifiedCount} file{stats.modifiedCount !== 1 ? 's' : ''}</span>
                <span className="git-stats-separator">·</span>
                <span className="git-stats-added">+{stats.addedLines}</span>
                <span className="git-stats-removed">-{stats.removedLines}</span>
              </>
            )}
            <Tooltip.Provider delayDuration={300}>
              <Tooltip.Root>
                <Tooltip.Trigger asChild>
                  <button
                    className={`git-stats-refresh ${isLoading ? 'loading' : ''}`}
                    onClick={handleRefresh}
                    disabled={isLoading}
                    aria-label="Refresh git status"
                  >
                    <RotateCw size={12} />
                  </button>
                </Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Content className="tooltip-content" sideOffset={5}>
                    Refresh git status
                    <Tooltip.Arrow className="tooltip-arrow" />
                  </Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>
            </Tooltip.Provider>
          </div>
        )}

        {showExplorerToggle && onToggleExplorer && (
          <Tooltip.Provider delayDuration={300}>
            <Tooltip.Root>
              <Tooltip.Trigger asChild>
                <button
                  className={`path-display-toggle ${isExplorerVisible ? 'active' : ''}`}
                  onClick={onToggleExplorer}
                  aria-label={isExplorerVisible ? 'Hide file explorer' : 'Show file explorer'}
                  aria-pressed={isExplorerVisible}
                >
                  <FolderTree size={14} />
                </button>
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content className="tooltip-content" sideOffset={5}>
                  {isExplorerVisible ? 'Hide file explorer' : 'Show file explorer'} ({explorerShortcut})
                  <Tooltip.Arrow className="tooltip-arrow" />
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
          </Tooltip.Provider>
        )}
      </div>
    </div>
  );
}

// Keep old export for backwards compatibility during migration
export { PathDisplay as TruncatedPath };
