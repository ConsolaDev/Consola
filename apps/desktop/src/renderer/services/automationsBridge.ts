import type {
  AuthoringRequest,
  AutomationsChange,
  AutomationsSnapshot,
  ItemTarget,
  ItemTargets,
  ListRunsQuery,
  LogTail,
  RunDefinition,
  RunListPage,
  RunRecord,
  StepDetail,
} from '../../shared/automations';
import type { RunConversation } from '../../shared/conversation';
import type { Session } from '../../shared/workspace';

function getAPI() {
  if (typeof window !== 'undefined' && window.automationsAPI) {
    return window.automationsAPI;
  }
  return null;
}

function unavailable(): never {
  throw new Error('Automations are not available in this window.');
}

/**
 * Bridge to the automation runner in the main process.
 *
 * Each workspace has its own factory.yml. Main parses, schedules and runs;
 * this bridge reads a workspace's snapshot and sends intents. "Open file"
 * hands the file to the person's editor, which is where the spec lives; the
 * only edit Consola makes is appending automatic reviews when asked.
 */
export const automationsBridge = {
  getSnapshot: async (workspaceId: string): Promise<AutomationsSnapshot | null> =>
    getAPI()?.getSnapshot(workspaceId) ?? null,

  /** Run now — or, for an event automation, check now (null: only what is new fires). */
  runNow: async (
    workspaceId: string,
    name: string,
    target?: ItemTarget,
  ): Promise<RunRecord | null> => (getAPI() ?? unavailable()).runNow(workspaceId, name, target),

  /** The person lets a poll entry's check command run, at the version they saw. */
  allow: async (workspaceId: string, name: string, version: string): Promise<void> =>
    (getAPI() ?? unavailable()).allow(workspaceId, name, version),

  /** The items Run on… offers; read from memory and history, starts nothing. */
  listRunTargets: async (workspaceId: string, name: string): Promise<ItemTargets> =>
    (getAPI() ?? unavailable()).listRunTargets(workspaceId, name),

  approve: async (runId: string): Promise<RunRecord> => (getAPI() ?? unavailable()).approve(runId),

  dismiss: async (runId: string): Promise<RunRecord> => (getAPI() ?? unavailable()).dismiss(runId),

  /** Open factory.yml, or one of the folder's own files by its path (`agents/reviewer.md`). */
  openFile: async (workspaceId: string, file?: string): Promise<void> =>
    (getAPI() ?? unavailable()).openFile(workspaceId, file),

  /** Check again: re-read the factory folder and re-check what applies. */
  recheck: async (workspaceId: string): Promise<void> =>
    (getAPI() ?? unavailable()).recheck(workspaceId),

  /** Add review-assigned-prs to the workspace's factory.yml — the one edit Consola makes to it, on request. */
  addAssignedReviews: async (workspaceId: string): Promise<void> =>
    (getAPI() ?? unavailable()).addAssignedReviews(workspaceId),

  /** One run's full record; null once history has dropped it. */
  getRun: async (runId: string): Promise<RunRecord | null> =>
    (getAPI() ?? unavailable()).getRun(runId),

  /** A run's conversation from its transcript on disk: never starts or resumes a session. */
  readConversation: async (runId: string): Promise<RunConversation> =>
    (getAPI() ?? unavailable()).readConversation(runId),

  /** One step's conversation from its transcript on disk, with the step's own pointer and window. */
  readStepConversation: async (runId: string, stepId: string): Promise<RunConversation> =>
    (getAPI() ?? unavailable()).readStepConversation(runId, stepId),

  /** One page of history, newest first; the filter narrows before the page is cut. */
  listRuns: async (workspaceId: string, query: ListRunsQuery): Promise<RunListPage> =>
    (getAPI() ?? unavailable()).listRuns(workspaceId, query),

  /** A steps run's whole definition snapshot; null for a run without one. */
  getRunDefinition: async (runId: string): Promise<RunDefinition | null> =>
    getAPI()?.getRunDefinition(runId) ?? null,

  /** A step's latest attempt, with its command and the end of each log; null when there is no such step. */
  getStepDetail: async (runId: string, stepId: string): Promise<StepDetail | null> =>
    getAPI()?.getStepDetail(runId, stepId) ?? null,

  /** A whole step log (up to 1 MB); null when there is none. */
  readStepLog: async (
    runId: string,
    stepId: string,
    stream: 'stdout' | 'stderr',
  ): Promise<LogTail | null> => getAPI()?.readStepLog(runId, stepId, stream) ?? null,

  /** A declared artifact of the step's latest attempt; null when it is not there. */
  readArtifact: async (
    runId: string,
    ref: { step: string; name: string },
  ): Promise<{ content: string; bytes: number } | null> =>
    getAPI()?.readArtifact(runId, ref) ?? null,

  /** Retry a failed steps run from its failed step. */
  retry: async (runId: string, stepId?: string): Promise<RunRecord> =>
    (getAPI() ?? unavailable()).retry(runId, stepId),

  stop: async (runId: string): Promise<void> => (getAPI() ?? unavailable()).stop(runId),

  addTemplate: async (workspaceId: string, templateId: string): Promise<void> =>
    (getAPI() ?? unavailable()).addTemplate(workspaceId, templateId),

  /** Start the full-tools session that drafts an automation with the person. */
  startAuthoring: async (request: AuthoringRequest): Promise<Session> =>
    (getAPI() ?? unavailable()).startAuthoring(request),

  acknowledge: async (workspaceId: string, name: string): Promise<void> =>
    (getAPI() ?? unavailable()).acknowledge(workspaceId, name),

  /** One entry exactly as factory.yml has it; null when the file or the entry is gone. */
  getEntry: async (workspaceId: string, name: string): Promise<string | null> =>
    (getAPI() ?? unavailable()).getEntry(workspaceId, name),

  onChanged: (callback: (change: AutomationsChange) => void): (() => void) =>
    getAPI()?.onChanged(callback) ?? (() => {}),
};
