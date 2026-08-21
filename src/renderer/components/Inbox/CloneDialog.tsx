import * as Dialog from '@radix-ui/react-dialog';
import { dialogBridge } from '../../services/dialogBridge';
import { useInboxStore } from '../../stores/inboxStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';

/**
 * "Clone into scope..." — the one dialog in the inbox flow, and it is about
 * the local disk, not GitHub: where should this repo live? Container scopes
 * are offered first; an arbitrary folder becomes a new scope holding the
 * clone (main adds the scope record). The launch continues automatically.
 */
export function CloneDialog() {
  const clonePrompt = useInboxStore((state) => state.clonePrompt);
  const dismiss = useInboxStore((state) => state.dismissClonePrompt);
  const cloneAndLaunch = useInboxStore((state) => state.cloneAndLaunch);
  const workspace = useWorkspaceStore((state) =>
    state.workspaces.find((candidate) => candidate.id === clonePrompt?.workspaceId)
  );

  if (!clonePrompt || !workspace) return null;
  const { item, workspaceId } = clonePrompt;
  const containers = workspace.scopes.filter((scope) => !scope.isGitRepo);

  const chooseFolder = async () => {
    const folder = await dialogBridge.selectFolder();
    if (!folder) return;
    void cloneAndLaunch(workspaceId, item, folder.path);
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="clone-dialog-overlay" />
        <Dialog.Content className="clone-dialog">
          <Dialog.Title className="clone-dialog-title">Clone {item.workItem.repo}</Dialog.Title>
          <Dialog.Description className="clone-dialog-description">
            This repo is not cloned in any scope of {workspace.name}. Pick where the clone should
            live; the launch continues once it lands.
          </Dialog.Description>
          <div className="clone-dialog-options">
            {containers.map((scope) => (
              <button
                key={scope.id}
                className="clone-dialog-option"
                onClick={() => void cloneAndLaunch(workspaceId, item, scope.path)}
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
          <div className="clone-dialog-footer">
            <button className="clone-dialog-cancel" onClick={dismiss}>
              Cancel
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
