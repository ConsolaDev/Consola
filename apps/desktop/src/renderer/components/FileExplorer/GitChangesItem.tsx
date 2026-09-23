import { GitFileStatus } from '../../types/electron';
import { FileIcon } from './FileIcon';

interface GitChangesItemProps {
  filePath: string;
  status: GitFileStatus;
  isSelected: boolean;
  onSelect: () => void;
}

/** Single-letter badge per git status, shared with the command palette. */
export const STATUS_LABELS: Record<GitFileStatus, string> = {
  staged: 'A',
  modified: 'M',
  untracked: 'U',
  deleted: 'D',
};

/**
 * Extract filename and parent directory from a relative path.
 * e.g., ".claude/skills/research-c..." from ".claude/skills/research-codebase/SKILL.md"
 */
function getFileDisplayInfo(filePath: string): { filename: string; parentPath: string } {
  const parts = filePath.split('/');
  const filename = parts[parts.length - 1];

  if (parts.length <= 1) {
    return { filename, parentPath: '' };
  }

  // Get parent directory path, truncate if too long
  const parentParts = parts.slice(0, -1);
  let parentPath = parentParts.join('/');

  if (parentPath.length > 25) {
    parentPath = parentPath.slice(0, 22) + '...';
  }

  return { filename, parentPath };
}

export function GitChangesItem({ filePath, status, isSelected, onSelect }: GitChangesItemProps) {
  const { filename, parentPath } = getFileDisplayInfo(filePath);
  const statusClass = `git-${status}`;

  return (
    <button
      className={`git-changes-item ${isSelected ? 'selected' : ''}`}
      onClick={onSelect}
    >
      <FileIcon filename={filename} className="git-changes-item-icon" />
      <div className="git-changes-item-info">
        <span className={`git-changes-item-name ${statusClass}`}>{filename}</span>
        {parentPath && (
          <span className="git-changes-item-path">{parentPath}</span>
        )}
      </div>
      <span className={`git-changes-item-status ${statusClass}`}>
        {STATUS_LABELS[status]}
      </span>
    </button>
  );
}
