import type {
  CleanupHistoryEntry,
  CleanupPreview,
  CleanupPreviewRequest,
  CleanupReport,
  SessionDeleteOutcome,
} from '../../shared/worktreeCleanup';

/**
 * Worktree Cleanup Bridge - Isolates all window.worktreeCleanupAPI access to this single file.
 *
 * Every sentence in a preview, report or history entry is main's: show it,
 * never interpret a reason here.
 */

function getAPI() {
  if (typeof window !== 'undefined' && window.worktreeCleanupAPI) {
    return window.worktreeCleanupAPI;
  }
  return null;
}

const EMPTY_PREVIEW: CleanupPreview = { entries: [], removable: 0, summary: '' };

export const worktreeCleanupBridge = {
  preview: async (request: CleanupPreviewRequest = {}): Promise<CleanupPreview> =>
    (await getAPI()?.preview(request)) ?? EMPTY_PREVIEW,

  run: async (workspaceId?: string): Promise<CleanupReport> =>
    (await getAPI()?.run(workspaceId)) ?? { removed: [], kept: [], failed: [], summary: '' },

  history: async (workspaceId?: string): Promise<CleanupHistoryEntry[]> =>
    (await getAPI()?.history(workspaceId)) ?? [],

  /** Whether a folder is one of Consola's own worktrees, which cleanup may remove. */
  isManaged: async (dir: string): Promise<boolean> => (await getAPI()?.isManaged(dir)) ?? false,

  /** Hear how a deleted session's worktree removal ended. Returns the unsubscribe. */
  onDeleted: (callback: (outcome: SessionDeleteOutcome) => void): (() => void) =>
    getAPI()?.onDeleted(callback) ?? (() => {}),

  /** Hear that the history changed, in any window. Returns the unsubscribe. */
  onChanged: (callback: () => void): (() => void) => getAPI()?.onChanged(callback) ?? (() => {}),
};
