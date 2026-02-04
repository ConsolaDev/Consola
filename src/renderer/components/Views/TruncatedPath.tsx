import * as Tooltip from '@radix-ui/react-tooltip';

interface TruncatedPathProps {
  path: string;
  className?: string;
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

export function TruncatedPath({ path, className }: TruncatedPathProps) {
  return (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <span className={className}>{truncatePath(path)}</span>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className="tooltip-content" sideOffset={5}>
            {path}
            <Tooltip.Arrow className="tooltip-arrow" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
