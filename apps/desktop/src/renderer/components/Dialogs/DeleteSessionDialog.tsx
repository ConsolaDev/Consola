import { useEffect, useState } from 'react';
import { create } from 'zustand';
import type { Session } from '../../../shared/workspace';
import { effectiveWorktreeCleanup } from '../../../shared/worktreeCleanup';
import { usePreferencesStore } from '../../stores/preferencesStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { workspaceBridge } from '../../services/workspaceBridge';
import { worktreeCleanupBridge } from '../../services/worktreeCleanupBridge';
import { showToast } from '../../stores/toastStore';
import { deleteSessionCompletely } from '../../utils/sessionActions';
import { ConfirmDialog } from './ConfirmDialog';

interface DeleteRequest {
  workspaceId: string;
  session: Session;
  /** What the person calls it where they asked: the row's label, or its name. */
  label: string;
  /** Main's sentence about the worktree; undefined while it is being asked. */
  worktree?: string | null;
}

interface DeleteSessionDialogState {
  request: DeleteRequest | null;
  close: () => void;
}

/**
 * A store rather than props because the openers — a sidebar row, the
 * command palette — unmount before the question is answered: the palette
 * closes when a command is chosen.
 */
const useDeleteSessionDialogStore = create<DeleteSessionDialogState>((set) => ({
  request: null,
  close: () => set({ request: null }),
}));

/**
 * Ask before deleting a session, saying what happens to its worktree and
 * branch first. The sentence is main's: it judged the worktree with the same
 * rules the delete itself will use.
 */
export function requestSessionDelete(workspaceId: string, session: Session, label = session.name) {
  const workspace = useWorkspaceStore
    .getState()
    .workspaces.find((candidate) => candidate.id === workspaceId);
  const rules =
    workspace &&
    effectiveWorktreeCleanup(
      usePreferencesStore.getState().worktreeCleanup,
      workspace.worktreeCleanup,
    );
  // Nothing to ask main when the rule is off here or there is no worktree:
  // the delete is the one it always was.
  if (!rules?.sessionDeleted || !(session.cwd || session.removedWorktree)) {
    useDeleteSessionDialogStore.setState({
      request: { workspaceId, session, label, worktree: null },
    });
    return;
  }
  useDeleteSessionDialogStore.setState({ request: { workspaceId, session, label } });
  void workspaceBridge
    .previewSessionDelete(workspaceId, session.id)
    .catch(() => ({ worktree: null }))
    .then(({ worktree }) => {
      const current = useDeleteSessionDialogStore.getState().request;
      if (current?.session.id !== session.id) return;
      useDeleteSessionDialogStore.setState({ request: { ...current, worktree } });
    });
}

/** Mounted once, beside the other app-wide dialogs. */
export function DeleteSessionDialog() {
  const request = useDeleteSessionDialogStore((state) => state.request);
  const close = useDeleteSessionDialogStore((state) => state.close);
  // Kept while the dialog animates closed, so its text does not blank out.
  const [shown, setShown] = useState<DeleteRequest | null>(request);
  useEffect(() => {
    if (request) setShown(request);
  }, [request]);

  // A worktree removal finishes after the delete returns: say how it went.
  useEffect(
    () =>
      worktreeCleanupBridge.onDeleted((outcome) => {
        if (outcome.message) showToast(outcome.message);
      }),
    [],
  );

  const worktree = shown?.worktree;
  const description = [
    `Delete session "${shown?.label ?? ''}"? This will remove the session and its chat history.`,
    worktree === undefined ? 'Checking its worktree…' : worktree,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <ConfirmDialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title="Delete session"
      description={description}
      confirmLabel="Delete"
      destructive
      onConfirm={async () => {
        if (!request) return;
        const outcome = await deleteSessionCompletely(request.workspaceId, request.session);
        if (outcome?.message) showToast(outcome.message);
      }}
    />
  );
}
