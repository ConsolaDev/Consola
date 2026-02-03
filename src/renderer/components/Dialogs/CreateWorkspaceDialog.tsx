import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, FolderPlus, Folder, GitBranch } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import type { FolderInfo } from '../../types/electron';
import './styles.css';

interface CreateWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateWorkspaceDialog({ open, onOpenChange }: CreateWorkspaceDialogProps) {
  const navigate = useNavigate();
  const createWorkspace = useWorkspaceStore((state) => state.createWorkspace);
  const addProjectToWorkspace = useWorkspaceStore((state) => state.addProjectToWorkspace);

  const [name, setName] = useState('New Workspace');
  const [folders, setFolders] = useState<FolderInfo[]>([]);

  const handleAddFolders = async () => {
    const selectedFolders = await window.dialogAPI.selectFolders();
    if (selectedFolders.length > 0) {
      // Filter out duplicates based on path
      const existingPaths = new Set(folders.map((f) => f.path));
      const newFolders = selectedFolders.filter((f) => !existingPaths.has(f.path));
      setFolders([...folders, ...newFolders]);
    }
  };

  const handleRemoveFolder = (path: string) => {
    setFolders(folders.filter((f) => f.path !== path));
  };

  const handleCreate = () => {
    const workspace = createWorkspace(name.trim() || 'New Workspace');

    // Add all selected folders as projects
    for (const folder of folders) {
      addProjectToWorkspace(workspace.id, {
        name: folder.name,
        path: folder.path,
        isGitRepo: folder.isGitRepo,
      });
    }

    // Reset form state
    setName('New Workspace');
    setFolders([]);

    // Close dialog and navigate to new workspace
    onOpenChange(false);
    navigate(`/workspace/${workspace.id}`);
  };

  const handleCancel = () => {
    // Reset form state
    setName('New Workspace');
    setFolders([]);
    onOpenChange(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <Dialog.Title className="dialog-title">Create Workspace</Dialog.Title>

          <div className="dialog-form">
            <div className="dialog-field">
              <label htmlFor="workspace-name" className="dialog-label">
                Name
              </label>
              <input
                id="workspace-name"
                type="text"
                className="dialog-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Workspace name"
                autoFocus
              />
            </div>

            <div className="dialog-field">
              <label className="dialog-label">Projects</label>
              <button
                type="button"
                className="dialog-button-secondary"
                onClick={handleAddFolders}
              >
                <FolderPlus size={16} />
                <span>Add folders</span>
              </button>

              {folders.length > 0 && (
                <ul className="dialog-folder-list">
                  {folders.map((folder) => (
                    <li key={folder.path} className="dialog-folder-item">
                      <span className="dialog-folder-icon">
                        {folder.isGitRepo ? <GitBranch size={14} /> : <Folder size={14} />}
                      </span>
                      <span className="dialog-folder-name" title={folder.path}>
                        {folder.name}
                      </span>
                      <button
                        type="button"
                        className="dialog-folder-remove"
                        onClick={() => handleRemoveFolder(folder.path)}
                        aria-label={`Remove ${folder.name}`}
                      >
                        <X size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="dialog-actions">
            <button
              type="button"
              className="dialog-button-secondary"
              onClick={handleCancel}
            >
              Cancel
            </button>
            <button
              type="button"
              className="dialog-button-primary"
              onClick={handleCreate}
            >
              Create
            </button>
          </div>

          <Dialog.Close asChild>
            <button className="dialog-close" aria-label="Close">
              <X size={16} />
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
