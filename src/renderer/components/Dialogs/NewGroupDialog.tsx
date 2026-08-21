import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { workspaceBridge } from '../../services/workspaceBridge';
import './styles.css';

interface NewGroupDialogProps {
  workspaceId: string;
  onClose: () => void;
}

/** Name it, and that is all: a group is a folder for humans. */
export function NewGroupDialog({ workspaceId, onClose }: NewGroupDialogProps) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setError(null);
    try {
      await workspaceBridge.createGroup(workspaceId, { name: trimmed });
      onClose();
    } catch (err) {
      // Keep the dialog open so the name is not lost, and say what happened
      // instead of a native alert.
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <Dialog.Title className="dialog-title">New group</Dialog.Title>
          <Dialog.Description className="dialog-description">
            A folder for sessions; no conductor.
          </Dialog.Description>
          <div className="dialog-form">
            <div className="dialog-field">
              <label className="dialog-label" htmlFor="new-group-name">
                Name
              </label>
              <input
                id="new-group-name"
                className="dialog-input"
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void create();
                }}
                placeholder="e.g. bump lodash v5"
              />
              {error && <span className="dialog-error">{error}</span>}
            </div>
          </div>
          <div className="dialog-actions">
            <button className="dialog-button-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              className="dialog-button-primary"
              onClick={() => void create()}
              disabled={!name.trim()}
            >
              Create
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
