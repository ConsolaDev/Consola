import * as Tooltip from '@radix-ui/react-tooltip';
import { FolderTree } from 'lucide-react';

interface PathDisplayProps {
  path: string;
  className?: string;
  showExplorerToggle?: boolean;
  isExplorerVisible?: boolean;
  onToggleExplorer?: () => void;
}

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
  return (
    <div className="path-display-container">
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
                {isExplorerVisible ? 'Hide file explorer' : 'Show file explorer'}
                <Tooltip.Arrow className="tooltip-arrow" />
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
        </Tooltip.Provider>
      )}
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
    </div>
  );
}

// Keep old export for backwards compatibility during migration
export { PathDisplay as TruncatedPath };
