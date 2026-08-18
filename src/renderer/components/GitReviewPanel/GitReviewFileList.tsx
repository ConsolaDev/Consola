import { useState, useMemo, useCallback, memo } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronRight } from 'lucide-react';
import { useGitStatusStore } from '../../stores/gitStatusStore';
import { useGitReviewStore } from '../../stores/gitReviewStore';
import { gitBridge } from '../../services/gitBridge';
import { FileIcon } from '../FileExplorer/FileIcon';
import { GitFileStatus } from '../../types/electron';

interface GitReviewFileListProps {
  rootPath: string;
}

const STATUS_LABELS: Record<GitFileStatus, string> = {
  staged: 'A',
  modified: 'M',
  untracked: 'U',
  deleted: 'D',
};

function getStatusClass(status: GitFileStatus): string {
  switch (status) {
    case 'staged':
      return 'status-added';
    case 'modified':
      return 'status-modified';
    case 'deleted':
      return 'status-deleted';
    case 'untracked':
      return 'status-untracked';
    default:
      return '';
  }
}

export const GitReviewFileList = memo(function GitReviewFileList({ rootPath }: GitReviewFileListProps) {
  const [stagedOpen, setStagedOpen] = useState(true);
  const [changesOpen, setChangesOpen] = useState(true);

  const fileStatuses = useGitStatusStore((state) => state.fileStatuses);
  const refresh = useGitStatusStore((state) => state.refresh);
  const setScrollToFile = useGitReviewStore((state) => state.setScrollToFile);
  const setFileExpanded = useGitReviewStore((state) => state.setFileExpanded);

  // Memoize grouped files to prevent recalculation on every render
  const { staged, changes } = useMemo(() => {
    const stagedFiles: Array<{ path: string; status: GitFileStatus }> = [];
    const changesFiles: Array<{ path: string; status: GitFileStatus }> = [];

    fileStatuses.forEach((status, path) => {
      if (status === 'staged') {
        stagedFiles.push({ path, status });
      } else {
        changesFiles.push({ path, status });
      }
    });

    return { staged: stagedFiles, changes: changesFiles };
  }, [fileStatuses]);

  const handleFileClick = (filePath: string) => {
    // Expand the file section and scroll to it
    setFileExpanded(filePath, true);
    setScrollToFile(filePath);
  };

  const handleStageFile = async (e: React.MouseEvent, filePath: string) => {
    e.stopPropagation();
    try {
      await gitBridge.stageFile(rootPath, filePath);
      await refresh(rootPath);
    } catch (error) {
      console.error('Failed to stage file:', error);
    }
  };

  const handleUnstageFile = async (e: React.MouseEvent, filePath: string) => {
    e.stopPropagation();
    try {
      await gitBridge.unstageFile(rootPath, filePath);
      await refresh(rootPath);
    } catch (error) {
      console.error('Failed to unstage file:', error);
    }
  };

  const getFilename = (path: string) => {
    const parts = path.split('/');
    return parts[parts.length - 1];
  };

  if (staged.length === 0 && changes.length === 0) {
    return (
      <div className="git-review-sidebar-content">
        <div className="git-review-empty" style={{ height: 'auto', padding: 'var(--space-4)' }}>
          <p style={{ fontSize: '11px' }}>No changes</p>
        </div>
      </div>
    );
  }

  return (
    <div className="git-review-sidebar-content">
      {staged.length > 0 && (
        <Collapsible.Root open={stagedOpen} onOpenChange={setStagedOpen}>
          <Collapsible.Trigger className="git-review-section-header">
            <ChevronRight
              size={12}
              className={`git-review-section-chevron ${stagedOpen ? 'open' : ''}`}
            />
            <span className="git-review-section-title">Approved</span>
            <span className="git-review-section-count">{staged.length}</span>
          </Collapsible.Trigger>
          <Collapsible.Content>
            <div className="git-review-section-content">
              {staged.map(({ path, status }) => (
                <button
                  key={path}
                  className="git-review-file-item"
                  onClick={() => handleFileClick(path)}
                  title={path}
                >
                  <span className="git-review-file-item-icon">
                    <FileIcon filename={getFilename(path)} />
                  </span>
                  <span className={`git-review-file-item-name ${getStatusClass(status)}`}>
                    {getFilename(path)}
                  </span>
                  <span
                    className={`git-review-file-item-status ${getStatusClass(status)}`}
                    onClick={(e) => handleUnstageFile(e, path)}
                    title="Remove approval"
                  >
                    {STATUS_LABELS[status]}
                  </span>
                </button>
              ))}
            </div>
          </Collapsible.Content>
        </Collapsible.Root>
      )}

      {changes.length > 0 && (
        <Collapsible.Root open={changesOpen} onOpenChange={setChangesOpen}>
          <Collapsible.Trigger className="git-review-section-header">
            <ChevronRight
              size={12}
              className={`git-review-section-chevron ${changesOpen ? 'open' : ''}`}
            />
            <span className="git-review-section-title">To Review</span>
            <span className="git-review-section-count">{changes.length}</span>
          </Collapsible.Trigger>
          <Collapsible.Content>
            <div className="git-review-section-content">
              {changes.map(({ path, status }) => (
                <button
                  key={path}
                  className="git-review-file-item"
                  onClick={() => handleFileClick(path)}
                  title={path}
                >
                  <span className="git-review-file-item-icon">
                    <FileIcon filename={getFilename(path)} />
                  </span>
                  <span className={`git-review-file-item-name ${getStatusClass(status)}`}>
                    {getFilename(path)}
                  </span>
                  <span
                    className={`git-review-file-item-status ${getStatusClass(status)}`}
                    onClick={(e) => handleStageFile(e, path)}
                    title="Approve"
                  >
                    {STATUS_LABELS[status]}
                  </span>
                </button>
              ))}
            </div>
          </Collapsible.Content>
        </Collapsible.Root>
      )}
    </div>
  );
});
