import { useState } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronRight } from 'lucide-react';
import { useGitStatusStore } from '../../stores/gitStatusStore';
import { usePreviewTabStore } from '../../stores/previewTabStore';
import { GitChangesItem } from './GitChangesItem';
import { GitFileStatus } from '../../types/electron';

interface GitChangesPanelProps {
  rootPath: string;
  selectedPath: string | null;
}

export function GitChangesPanel({ rootPath, selectedPath }: GitChangesPanelProps) {
  const [stagedOpen, setStagedOpen] = useState(true);
  const [changesOpen, setChangesOpen] = useState(true);

  const fileStatuses = useGitStatusStore((state) => state.fileStatuses);
  const isGitRepo = useGitStatusStore((state) => state.isGitRepo);
  const isLoading = useGitStatusStore((state) => state.isLoading);
  const openDiff = usePreviewTabStore((state) => state.openDiff);

  if (!isGitRepo) {
    return (
      <div className="git-changes-empty">
        <p>Not a git repository</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="git-changes-loading">
        <p>Loading changes...</p>
      </div>
    );
  }

  // Group files by staged vs changes
  const staged: Array<{ path: string; status: GitFileStatus }> = [];
  const changes: Array<{ path: string; status: GitFileStatus }> = [];

  fileStatuses.forEach((status, path) => {
    if (status === 'staged') {
      staged.push({ path, status });
    } else {
      // modified, untracked, deleted go to Changes
      changes.push({ path, status });
    }
  });

  const handleSelectFile = (filePath: string, isStaged: boolean) => {
    openDiff(rootPath, filePath, isStaged);
  };

  // Get the relative selected path for comparison
  const selectedRelativePath = selectedPath?.startsWith(rootPath)
    ? selectedPath.slice(rootPath.length + 1)
    : selectedPath;

  if (staged.length === 0 && changes.length === 0) {
    return (
      <div className="git-changes-empty">
        <p>No changes</p>
      </div>
    );
  }

  return (
    <div className="git-changes-panel">
      {staged.length > 0 && (
        <Collapsible.Root open={stagedOpen} onOpenChange={setStagedOpen}>
          <Collapsible.Trigger className="git-changes-section-header">
            <ChevronRight
              size={14}
              className={`git-changes-chevron ${stagedOpen ? 'open' : ''}`}
            />
            <span className="git-changes-section-title">Staged Changes</span>
            <span className="git-changes-section-count">{staged.length}</span>
          </Collapsible.Trigger>
          <Collapsible.Content>
            <div className="git-changes-section-content">
              {staged.map(({ path, status }) => (
                <GitChangesItem
                  key={path}
                  filePath={path}
                  status={status}
                  isSelected={selectedRelativePath === path}
                  onSelect={() => handleSelectFile(path, true)}
                />
              ))}
            </div>
          </Collapsible.Content>
        </Collapsible.Root>
      )}

      {changes.length > 0 && (
        <Collapsible.Root open={changesOpen} onOpenChange={setChangesOpen}>
          <Collapsible.Trigger className="git-changes-section-header">
            <ChevronRight
              size={14}
              className={`git-changes-chevron ${changesOpen ? 'open' : ''}`}
            />
            <span className="git-changes-section-title">Changes</span>
            <span className="git-changes-section-count">{changes.length}</span>
          </Collapsible.Trigger>
          <Collapsible.Content>
            <div className="git-changes-section-content">
              {changes.map(({ path, status }) => (
                <GitChangesItem
                  key={path}
                  filePath={path}
                  status={status}
                  isSelected={selectedRelativePath === path}
                  onSelect={() => handleSelectFile(path, false)}
                />
              ))}
            </div>
          </Collapsible.Content>
        </Collapsible.Root>
      )}
    </div>
  );
}
