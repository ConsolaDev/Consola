import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { dialogBridge } from '../../services/dialogBridge';
import { useInboxStore } from '../../stores/inboxStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import '../Dialogs/styles.css';

/**
 * "Clone into scope..." — the one dialog in the inbox flow, and it is about
 * the local disk, not the provider: where should this repo live? Container
 * scopes are offered first; an arbitrary folder becomes a new scope holding
 * the clone (main adds the scope record). Nothing launches afterwards: once
 * the repo resolves, the pane offers every action and the user picks one.
 */
export function CloneDialog() {
  const clonePrompt = useInboxStore((state) => state.clonePrompt);
  const dismiss = useInboxStore((state) => state.dismissClonePrompt);
  const cloneRepo = useInboxStore((state) => state.cloneRepo);
  const workspace = useWorkspaceStore((state) =>
    state.workspaces.find((candidate) => candidate.id === clonePrompt?.workspaceId)
  );

  if (!clonePrompt || !workspace) return null;
  const { item, workspaceId } = clonePrompt;
  const containers = workspace.scopes.filter((scope) => !scope.isGitRepo);

  const chooseFolder = async () => {
    const folder = await dialogBridge.selectFolder();
    if (!folder) return;
    void cloneRepo(workspaceId, item, folder.path);
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog-content"
          // The Inbox closes its detail pane on Esc; a dialog's Esc must not
          // reach that listener, or one keypress would close both.
          onEscapeKeyDown={(event) => event.stopPropagation()}
        >
          <Dialog.Title className="dialog-title">Clone {item.workItem.repo}</Dialog.Title>
          <Dialog.Description className="dialog-description">
            This repo is not cloned in any scope of {workspace.name}. Pick where the clone should
            live; the item's actions become available once it lands.
          </Dialog.Description>
          <div className="clone-dialog-options">
            {containers.map((scope) => (
              <button
                key={scope.id}
                className="clone-dialog-option"
                onClick={() => void cloneRepo(workspaceId, item, scope.path)}
              >
                <span className="clone-dialog-option-name">{scope.name}</span>
                <span className="clone-dialog-option-path">{scope.path}</span>
              </button>
            ))}
            <button className="clone-dialog-option" onClick={() => void chooseFolder()}>
              <span className="clone-dialog-option-name">Choose a folder...</span>
              <span className="clone-dialog-option-path">Becomes a new scope holding the clone</span>
            </button>
          </div>
          <div className="dialog-actions">
            <button className="dialog-button-secondary" onClick={dismiss}>
              Cancel
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
