import { useCallback, useState } from 'react';
import type {
  CleanupPreview,
  CleanupPreviewRequest,
  CleanupReport,
} from '../../../shared/worktreeCleanup';
import { worktreeCleanupBridge } from '../../services/worktreeCleanupBridge';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { ConfirmDialog } from '../Dialogs/ConfirmDialog';
import { CleanupEntries } from './CleanupEntries';

type Shown =
  | { kind: 'none' }
  | { kind: 'busy'; label: string }
  | { kind: 'preview'; preview: CleanupPreview }
  | { kind: 'report'; report: CleanupReport }
  | { kind: 'error'; message: string };

interface PendingEnable {
  apply: () => Promise<void>;
  preview: CleanupPreview;
}

/**
 * Preview, "Clean up now", and the question asked before a rule that would
 * remove worktrees right away is turned on. One workspace's worth when
 * `workspaceId` is given, everything otherwise.
 */
export function useCleanupActions(workspaceId?: string) {
  const [shown, setShown] = useState<Shown>({ kind: 'none' });
  const [pending, setPending] = useState<PendingEnable | null>(null);

  const preview = useCallback(async () => {
    setShown({ kind: 'busy', label: 'Checking worktrees…' });
    try {
      setShown({ kind: 'preview', preview: await worktreeCleanupBridge.preview({ workspaceId }) });
    } catch (error) {
      setShown({ kind: 'error', message: ipcErrorMessage(error) });
    }
  }, [workspaceId]);

  const runNow = useCallback(async () => {
    setShown({ kind: 'busy', label: 'Cleaning up…' });
    try {
      setShown({ kind: 'report', report: await worktreeCleanupBridge.run(workspaceId) });
    } catch (error) {
      setShown({ kind: 'error', message: ipcErrorMessage(error) });
    }
  }, [workspaceId]);

  /**
   * Apply a rule change, first asking when it would remove worktrees now.
   * `proposed` describes the rules the change would leave in force.
   */
  const changeRules = useCallback(
    async (apply: () => Promise<void>, proposed: CleanupPreviewRequest | null) => {
      if (!proposed) {
        await apply();
        return;
      }
      try {
        const asked = await worktreeCleanupBridge.preview({ ...proposed, workspaceId });
        if (asked.removable === 0) {
          await apply();
          return;
        }
        setPending({ apply, preview: asked });
      } catch (error) {
        setShown({ kind: 'error', message: ipcErrorMessage(error) });
      }
    },
    [workspaceId],
  );

  const going = pending?.preview.entries.filter((entry) => entry.decision === 'remove') ?? [];
  const confirm = (
    <ConfirmDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) setPending(null);
      }}
      title={`Remove ${going.length === 1 ? '1 worktree' : `${going.length} worktrees`} now?`}
      description={`Turning this on removes ${
        going.length === 1 ? 'the worktree of' : 'the worktrees of'
      } ${going
        .map((entry) => entry.sessions.map((session) => `“${session.name}”`).join(' and '))
        .join(
          ', ',
        )} right away. Their sessions stay, and a worktree is rebuilt when its session is opened. Dependencies and build output are not restored.`}
      confirmLabel="Turn on"
      destructive
      onConfirm={async () => {
        await pending?.apply();
        setPending(null);
      }}
    />
  );

  const results =
    shown.kind === 'none' ? null : (
      <div className="worktree-cleanup-results" aria-live="polite">
        {shown.kind === 'busy' && <p className="worktree-cleanup-empty">{shown.label}</p>}
        {shown.kind === 'error' && <p className="worktree-cleanup-error">{shown.message}</p>}
        {shown.kind === 'preview' && (
          <>
            <p className="worktree-cleanup-summary">{shown.preview.summary}</p>
            <CleanupEntries
              entries={shown.preview.entries}
              goingLabel="Goes"
              empty="No session runs in a worktree Consola created."
            />
          </>
        )}
        {shown.kind === 'report' && (
          <>
            <p className="worktree-cleanup-summary">{shown.report.summary}</p>
            <CleanupEntries
              entries={[
                ...shown.report.removed,
                ...shown.report.failed.map((entry) => ({
                  ...entry,
                  decision: 'keep' as const,
                  reason: `Could not be removed: ${entry.error}`,
                })),
                ...shown.report.kept,
              ]}
              goingLabel="Removed"
              empty="No worktree is due for removal."
            />
          </>
        )}
      </div>
    );

  return { preview, runNow, changeRules, busy: shown.kind === 'busy', confirm, results };
}
