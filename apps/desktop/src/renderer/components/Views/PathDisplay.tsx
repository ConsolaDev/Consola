import * as Tooltip from '@radix-ui/react-tooltip';
import { RotateCw } from 'lucide-react';
import { statsFor, useGitStatusStore } from '../../stores/gitStatusStore';
import { useCheckoutStore } from '../../stores/checkoutStore';
import { tildePath } from '../../utils/displayPath';

interface PathDisplayProps {
  path: string;
  className?: string;
  /** Print the folder itself. Off where the info panel's Folder row already names it. */
  showPath?: boolean;
}

/**
 * Truncate a file path to show a sensible shortened version.
 * Shows ~ for home directory and last 2-3 path segments.
 */
function truncatePath(fullPath: string): string {
  const path = tildePath(fullPath);
  const segments = path.split('/').filter(Boolean);

  if (segments.length <= 3) {
    return path.startsWith('/') ? '/' + segments.join('/') : segments.join('/');
  }

  const firstPart = path.startsWith('~') ? '~' : '';
  const lastSegments = segments.slice(-2).join('/');

  return `${firstPart}/.../${lastSegments}`;
}

export function PathDisplay({ path, className, showPath = true }: PathDisplayProps) {
  // This checkout's counts only: during a session switch the store still
  // holds the last checkout's until its own read lands, and until then the
  // header shows none.
  const stats = useGitStatusStore((state) => statsFor(state, path));
  const isLoading = useGitStatusStore((state) => state.isLoading);
  const isGitRepo = useGitStatusStore((state) => state.isGitRepo);
  const refresh = useGitStatusStore((state) => state.refresh);

  // The info panel names the checkout and its branch from the same store, so
  // a manual refresh re-reads that too: one button, one answer.
  const handleRefresh = () => {
    if (path && !isLoading) {
      void refresh(path);
      void useCheckoutStore.getState().load(path);
    }
  };

  // Marked when it prints the folder, which then gives way to the controls
  // after it (see the stylesheet).
  return (
    <div className="path-display-container" data-path={showPath || undefined}>
      {showPath && (
        <Tooltip.Provider delayDuration={300}>
          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <span className={`path-display-text ${className || ''}`}>{truncatePath(path)}</span>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content className="tooltip-content" sideOffset={5}>
                {path}
                <Tooltip.Arrow className="tooltip-arrow" />
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
        </Tooltip.Provider>
      )}

      {/* Right side: the checkout's git status */}
      <div className="path-display-actions">
        {/* Uncommitted changes in this checkout. Its branch, and what kind
            of checkout it is, are named in the info panel. */}
        {isGitRepo && (
          <div className="git-stats-badge">
            {stats && stats.modifiedCount > 0 && (
              <>
                <span className="git-stats-count">
                  {stats.modifiedCount} file{stats.modifiedCount !== 1 ? 's' : ''}
                </span>
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
      </div>
    </div>
  );
}

// Keep old export for backwards compatibility during migration
export { PathDisplay as TruncatedPath };
