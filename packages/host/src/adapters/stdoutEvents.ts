import type { OrchestrationV2ThreadProjection } from '@t3tools/contracts';
import * as Effect from 'effect/Effect';
import * as Stream from 'effect/Stream';
import { isActiveRun } from 't3/orchestration-v2/CommandPolicy.ts';
import type { AgentRunReport } from '@consola/runner-protocol';
import { sameReport } from '../core/agentRun.ts';
import type { HostLine, SessionStatus } from '../core/hostLine.ts';
import type { AgentRunSession, ThreadHandle } from '../runtime/threadRuntime.ts';

// The lines' types live in `core/`, where the runner's decisions read them; they are said here.
export { HOST_LINE_TYPES, type HostLine, type SessionStatus } from '../core/hostLine.ts';

/** A `HostLine` as printed: one JSON object on one line. */
export const encodeHostLine = (line: HostLine): string => `${JSON.stringify(line)}\n`;

/**
 * Prints one line on stdout and waits until Node has handed it on (a pipe to the runner is
 * asynchronous on macOS), so a process that exits right after loses no line.
 */
export const writeHostLine = (line: HostLine): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    process.stdout.write(encodeHostLine(line), () => resume(Effect.void));
  });

/**
 * The session's status from t3's projection of its thread: a pending runtime request (t3's
 * `runtimeRequests[].status`) is `waiting`, an active run (t3's own `isActiveRun`: preparing,
 * starting, running or waiting) is `working`, and anything else is `idle`.
 */
export function sessionStatusOf(
  projection: Pick<OrchestrationV2ThreadProjection, 'runs' | 'runtimeRequests'>,
): SessionStatus {
  if (projection.runtimeRequests.some((request) => request.status === 'pending')) return 'waiting';
  if (projection.runs.some(isActiveRun)) return 'working';
  return 'idle';
}

/**
 * The session's status now: its thread's (`sessionStatusOf`), or for an agent run every thread's
 * (`AgentRunHandle.view`): a child that runs, or a report not yet delivered, keeps it `working`.
 */
export function currentStatus(handle: Pick<ThreadHandle, 'snapshot' | 'agentRun'>): SessionStatus {
  const agentRun = handle.agentRun ?? null;
  return agentRun === null ? sessionStatusOf(handle.snapshot()) : agentRun.view().status;
}

/** What the runner was last told of the session: `ready` says idle and the thread's title. */
export type SaidOfSession = { readonly status: SessionStatus; readonly title: string };

/**
 * Follows the thread's projection (`handle.snapshots()`, which starts with the current one) and
 * writes a `status` line when the session's status changes and a `title` line when t3 retitles
 * the thread, each only on a change from what was last said, starting from `said`: what `ready`
 * said, read before it was written, so a change in between is said too. For an agent run the
 * status is every thread's, followed from the run's views (`AgentRunHandle.views`).
 */
export const reportSession = (
  handle: ThreadHandle,
  write: (line: HostLine) => Effect.Effect<void>,
  said: SaidOfSession,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    let status: SessionStatus = said.status;
    let title = said.title;
    const agentRun = handle.agentRun ?? null;
    const sayStatus = (nextStatus: SessionStatus) =>
      Effect.suspend(() => {
        if (nextStatus === status) return Effect.void;
        status = nextStatus;
        return write({ type: 'status', status });
      });
    const titles = handle.snapshots().pipe(
      Stream.runForEach((projection) =>
        Effect.gen(function* () {
          if (agentRun === null) yield* sayStatus(sessionStatusOf(projection));
          if (projection.thread.title !== title) {
            title = projection.thread.title;
            yield* write({ type: 'title', title });
          }
        }),
      ),
    );
    if (agentRun === null) return yield* titles;
    yield* Effect.all(
      [titles, agentRun.views().pipe(Stream.runForEach((view) => sayStatus(view.status)))],
      { concurrency: 'unbounded', discard: true },
    );
  });

/**
 * Follows an agent run's report (`AgentRunHandle.views`, which starts with the current one) and
 * writes an `agent-run` line, its report's fields beside `type`, whenever it changes from what was
 * last said (the first one always).
 */
export const reportAgentRun = (
  agentRun: Pick<AgentRunSession, 'views'>,
  write: (line: HostLine) => Effect.Effect<void>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    let said: AgentRunReport | null = null;
    yield* agentRun.views().pipe(
      Stream.runForEach((view) =>
        Effect.suspend(() => {
          if (said !== null && sameReport(said, view.report)) return Effect.void;
          said = view.report;
          return write({ type: 'agent-run', ...view.report });
        }),
      ),
    );
  });
