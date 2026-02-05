import { useState, useEffect } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronRight } from 'lucide-react';
import { FileIcon } from './FileIcon';
import { FolderIcon } from './FolderIcon';
import { fileBridge } from '../../services/fileBridge';

interface TreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
}

interface FileTreeItemProps {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
}

export function FileTreeItem({ node, depth, selectedPath, onSelectFile }: FileTreeItemProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [children, setChildren] = useState<TreeNode[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const isSelected = selectedPath === node.path;
  const indent = depth * 12;

  // Load children when folder is opened
  useEffect(() => {
    if (isOpen && node.isDirectory && children.length === 0) {
      setIsLoading(true);
      fileBridge.listDirectory(node.path)
        .then(setChildren)
        .catch(console.error)
        .finally(() => setIsLoading(false));
    }
  }, [isOpen, node.isDirectory, node.path, children.length]);

  if (node.isDirectory) {
    return (
      <Collapsible.Root open={isOpen} onOpenChange={setIsOpen}>
        <Collapsible.Trigger
          className="file-tree-item file-tree-folder"
          style={{ paddingLeft: indent }}
        >
          <ChevronRight
            size={14}
            className={`file-tree-chevron ${isOpen ? 'open' : ''}`}
          />
          <FolderIcon isOpen={isOpen} className="file-tree-icon" />
          <span className="file-tree-name">{node.name}</span>
        </Collapsible.Trigger>
        <Collapsible.Content>
          {isLoading ? (
            <div className="file-tree-loading" style={{ paddingLeft: indent + 24 }}>
              Loading...
            </div>
          ) : (
            children.map(child => (
              <FileTreeItem
                key={child.path}
                node={child}
                depth={depth + 1}
                selectedPath={selectedPath}
                onSelectFile={onSelectFile}
              />
            ))
          )}
        </Collapsible.Content>
      </Collapsible.Root>
    );
  }

  return (
    <button
      className={`file-tree-item file-tree-file ${isSelected ? 'selected' : ''}`}
      style={{ paddingLeft: indent + 18 }}
      onClick={() => onSelectFile(node.path)}
    >
      <FileIcon filename={node.name} className="file-tree-icon" />
      <span className="file-tree-name">{node.name}</span>
    </button>
  );
}
