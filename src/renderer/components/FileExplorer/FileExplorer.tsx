import { useState, useEffect } from 'react';
import { FileTreeItem } from './FileTreeItem';
import { fileBridge } from '../../services/fileBridge';
import './styles.css';

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
  const [rootChildren, setRootChildren] = useState<TreeNode[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!rootPath) {
      setRootChildren([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    fileBridge.listDirectory(rootPath)
      .then(setRootChildren)
      .catch(err => setError(err.message))
      .finally(() => setIsLoading(false));
  }, [rootPath]);

  if (!rootPath) {
    return (
      <div className="file-explorer-empty">
        <p>No project selected</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="file-explorer-loading">
        <p>Loading files...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="file-explorer-error">
        <p>Error loading files</p>
        <p className="file-explorer-error-detail">{error}</p>
      </div>
    );
  }

  return (
    <div className="file-explorer">
      <div className="file-tree">
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
    </div>
  );
}
