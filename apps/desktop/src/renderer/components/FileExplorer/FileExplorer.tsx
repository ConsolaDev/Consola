import { useState, useEffect } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { FolderTree, GitBranch } from 'lucide-react';
import { FileTreeItem } from './FileTreeItem';
import { GitChangesPanel } from './GitChangesPanel';
import { fileBridge } from '../../services/fileBridge';
import { useGitStatusStore } from '../../stores/gitStatusStore';
import { useSelectAll } from '../../hooks/useSelectAll';
import './styles.css';

type ViewMode = 'files' | 'git';

interface TreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
}

interface FileExplorerProps {
  rootPath: string;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
}

export function FileExplorer({ rootPath, selectedPath, onSelectFile }: FileExplorerProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('files');
  const [rootChildren, setRootChildren] = useState<TreeNode[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshGitStatus = useGitStatusStore((state) => state.refresh);
  const clearGitStatus = useGitStatusStore((state) => state.clear);
  const isGitRepo = useGitStatusStore((state) => state.isGitRepo);
  const treeRef = useSelectAll<HTMLDivElement>();

  useEffect(() => {
    if (!rootPath) {
      setRootChildren([]);
      setIsLoading(false);
      clearGitStatus();
      return;
    }

    setIsLoading(true);
    setError(null);

    fileBridge.listDirectory(rootPath)
      .then(setRootChildren)
      .catch(err => setError(err.message))
      .finally(() => setIsLoading(false));

    // Refresh git status when root path changes
    refreshGitStatus(rootPath);
  }, [rootPath, refreshGitStatus, clearGitStatus]);

  if (!rootPath) {
    return (
      <div className="file-explorer-empty">
        <p>No project selected</p>
      </div>
    );
  }

  const renderHeader = () => (
    <div className="file-explorer-header">
      <Tooltip.Provider delayDuration={300}>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <button
              className={`file-explorer-view-btn ${viewMode === 'files' ? 'active' : ''}`}
              onClick={() => setViewMode('files')}
              aria-label="Files view"
            >
              <FolderTree size={16} />
            </button>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content className="tooltip-content" sideOffset={5}>
              Files
              <Tooltip.Arrow className="tooltip-arrow" />
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>

        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <button
              className={`file-explorer-view-btn ${viewMode === 'git' ? 'active' : ''} ${!isGitRepo ? 'disabled' : ''}`}
              onClick={() => isGitRepo && setViewMode('git')}
              disabled={!isGitRepo}
              aria-label="Git changes view"
            >
              <GitBranch size={16} />
            </button>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content className="tooltip-content" sideOffset={5}>
              {isGitRepo ? 'Source Control' : 'Not a git repository'}
              <Tooltip.Arrow className="tooltip-arrow" />
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      </Tooltip.Provider>
    </div>
  );

  if (isLoading && viewMode === 'files') {
    return (
      <div className="file-explorer">
        {renderHeader()}
        <div className="file-explorer-loading">
          <p>Loading files...</p>
        </div>
      </div>
    );
  }

  if (error && viewMode === 'files') {
    return (
      <div className="file-explorer">
        {renderHeader()}
        <div className="file-explorer-error">
          <p>Error loading files</p>
          <p className="file-explorer-error-detail">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="file-explorer">
      {renderHeader()}
      {viewMode === 'files' ? (
        <div ref={treeRef} tabIndex={0} className="file-tree">
          {rootChildren.map(node => (
            <FileTreeItem
              key={node.path}
              node={node}
              depth={0}
              selectedPath={selectedPath}
              onSelectFile={onSelectFile}
            />
          ))}
        </div>
      ) : (
        <GitChangesPanel
          rootPath={rootPath}
          selectedPath={selectedPath}
        />
      )}
    </div>
  );
}
