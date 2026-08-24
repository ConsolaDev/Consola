import { useWorkspaceStore, type Workspace } from '../../stores/workspaceStore';
import { ConfirmDialog } from './ConfirmDialog';

interface DeleteWorkspaceDialogProps {
  workspace: Workspace;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The one confirmation for deleting a workspace, shared by the switcher and
 * the settings danger zone so the two doors cannot drift apart on what the
 * action means.
 *
 * Main drops any window holding the workspace when the record disappears, so
 * neither caller has anything to clear afterwards.
 */
export function DeleteWorkspaceDialog({ workspace, open, onOpenChange }: DeleteWorkspaceDialogProps) {
  const deleteWorkspace = useWorkspaceStore((state) => state.deleteWorkspace);
  const sessionCount = workspace.sessions.length;

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete “${workspace.name}”?`}
      description={
        `Removes this workspace and its ${sessionCount} session ` +
        `record${sessionCount === 1 ? '' : 's'} from Consola. Folders on disk and ` +
        'conversation transcripts stay where they are.'
      }
      confirmLabel="Delete workspace"
      destructive
      onConfirm={() => deleteWorkspace(workspace.id)}
    />
  );
}
