import { SHELL_SHORTCUT_LABEL } from '../../utils/shellShortcut';
import * as Tooltip from '@radix-ui/react-tooltip';
import { FolderTree, RotateCw, GitPullRequestDraft, TerminalSquare } from 'lucide-react';
import { useGitStatusStore } from '../../stores/gitStatusStore';
import { useGitReviewStore } from '../../stores/gitReviewStore';
import { useCheckoutStore } from '../../stores/checkoutStore';
import { tildePath } from '../../utils/displayPath';
import { isMac } from '../../utils/platform';

interface PathDisplayProps {
  path: string;
  className?: string;
  showExplorerToggle?: boolean;
  isExplorerVisible?: boolean;
  onToggleExplorer?: () => void;
  isTerminalVisible?: boolean;
  onToggleTerminal?: () => void;
}

const explorerShortcut = isMac ? '⇧⌘E' : 'Ctrl+Shift+E';

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

export function PathDisplay({
  path,
  className,
  showExplorerToggle = false,
  isExplorerVisible = false,
  onToggleExplorer,
  isTerminalVisible = false,
  onToggleTerminal,
}: PathDisplayProps) {
  // Use granular selectors to prevent unnecessary re-renders
  const stats = useGitStatusStore((state) => state.stats);
  const isLoading = useGitStatusStore((state) => state.isLoading);
  const isGitRepo = useGitStatusStore((state) => state.isGitRepo);
  const refresh = useGitStatusStore((state) => state.refresh);
  const isReviewOpen = useGitReviewStore((state) => state.isOpen);
  const toggleReview = useGitReviewStore((state) => state.toggle);

  // The branch lives in the checkout chip beside the title, so a manual
  // refresh re-reads that too: one button, one answer.
  const handleRefresh = () => {
    if (path && !isLoading) {
      void refresh(path);
      void useCheckoutStore.getState().load(path);
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
        {/* Uncommitted changes in this checkout. Its branch is named by the
            checkout chip beside the title, with what kind of checkout it is. */}
        {isGitRepo && (
          <div className="git-stats-badge">
            {stats.modifiedCount > 0 && (
              <>
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

        {/* Git Review Panel toggle */}
        {isGitRepo && (
          <Tooltip.Provider delayDuration={300}>
            <Tooltip.Root>
              <Tooltip.Trigger asChild>
                <button
                  className={`path-display-toggle ${isReviewOpen ? 'active' : ''}`}
                  onClick={toggleReview}
                  aria-label={isReviewOpen ? 'Close review panel' : 'Open review panel'}
                  aria-pressed={isReviewOpen}
                >
                  <GitPullRequestDraft size={14} />
                </button>
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content className="tooltip-content" sideOffset={5}>
                  {isReviewOpen ? 'Close review panel' : 'Review changes'}
                  <Tooltip.Arrow className="tooltip-arrow" />
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
          </Tooltip.Provider>
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
        {onToggleTerminal && (
          <Tooltip.Provider delayDuration={300}>
            <Tooltip.Root>
              <Tooltip.Trigger asChild>
                <button
                  type="button"
                  className={`path-display-toggle ${isTerminalVisible ? 'active' : ''}`}
                  onClick={onToggleTerminal}
                  aria-label={isTerminalVisible ? 'Hide terminal' : 'Show terminal'}
                  aria-pressed={isTerminalVisible}
                  aria-keyshortcuts="Control+`"
                >
                  <TerminalSquare size={14} />
                </button>
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content className="tooltip-content" sideOffset={5}>
                  {isTerminalVisible ? 'Hide terminal' : 'Show terminal'} ({SHELL_SHORTCUT_LABEL})
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
