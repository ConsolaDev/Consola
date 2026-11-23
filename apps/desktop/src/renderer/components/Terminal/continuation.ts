import type { RunListEntry } from '../../../shared/automations';
import type { Session } from '../../../shared/workspace';

/**
 * Main's words for a step's continuation while its run is open (the
 * engine's `CONTINUE_AFTER_RUN`, kept equal by `continuation.parity.test.ts`:
 * the renderer loads nothing of the engine's).
 */
export const CONTINUE_AFTER_RUN = 'Continue with full tools after the run ends';

const ENDED: ReadonlySet<RunListEntry['status']> = new Set(['completed', 'failed', 'rejected']);

/**
 * Why **Continue with full tools** is off for a session (slice 3-B Task
 * 20): a step's session while its run is open, as its provenance and the
 * run's status say. Every live run is in a workspace's snapshot, so a run
 * that is not there has ended. Null when it may continue; main asks again.
 */
export function continuationBlock(
  session: Pick<Session, 'automation'>,
  runs: ReadonlyArray<Pick<RunListEntry, 'id' | 'status'>> | undefined,
): string | null {
  const provenance = session.automation;
  if (!provenance?.step || !runs) return null;
  const run = runs.find((candidate) => candidate.id === provenance.runId);
  return run && !ENDED.has(run.status) ? CONTINUE_AFTER_RUN : null;
}
