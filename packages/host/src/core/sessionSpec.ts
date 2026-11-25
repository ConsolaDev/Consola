import type { ModelSelection } from '@t3tools/contracts';

/** What one host runs: a Consola session on one harness, in one folder. */
export type SessionSpec = {
  sessionId: string;
  harness: 'claude' | 'codex' | 'opencode' | 'pi' | 'acp';
  cwd: string;
  modelSelection?: ModelSelection;
  /**
   * The thread's title from the start. t3 keeps a title a thread had before its first message
   * (`hasTitleSetBeforeFirstMessage`), so a thread opened with one is never titled by its CLI: no
   * `claude -p` runs in the folder for a title. A step's host opens with one ("Step sandboxes").
   */
  title?: string;
};
