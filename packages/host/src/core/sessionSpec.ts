import type { ModelSelection } from '@t3tools/contracts';

/** What one host runs: a Consola session on one harness, in one folder. */
export type SessionSpec = {
  sessionId: string;
  harness: 'claude' | 'codex' | 'opencode' | 'pi' | 'acp';
  cwd: string;
  modelSelection?: ModelSelection;
};
