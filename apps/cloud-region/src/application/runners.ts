import type { RunnerHello } from '@consola/runner-protocol';
import {
  belongsToRunner,
  CELL_FAILURE_CODES,
  endReported,
  isEnded,
  runnerFailure,
} from '../domain/cloudSession.js';
import type { CloudSessionChanges, RunnerIdentity, RunnerUpdatePorts } from './ports.js';

/** What the cell answers a runner's `hello` with: the sessions it is to stop. */
export type HelloAnswer = { stop: string[] };

/**
 * What a runner's `hello` means for the sessions the cell holds, in Task 1's order (Review Focus
 * 5 and 7). The runner serves `workspaceId`, whatever it calls itself, and only its own rows, in
 * that workspace, are changed.
 *
 * 1. Each session in `endedSessions` keeps the end the runner reports (`endReported`), with its
 *    message or the cell's `runner_failed`, so a session that ended while the socket was down is
 *    never taken for one lost in a restart.
 * 2. Every other live session of the runner that `runningSessionIds` does not list is `failed`
 *    with `runner_restarted`: its sandbox went with the runner.
 * 3. Every listed session the cell holds as ended, or does not hold as this runner's, is to be
 *    stopped, so the runner never keeps a sandbox for a session the cell considers ended.
 *
 * An id in both lists is ended (ended wins), so it ends and is stopped. An id listed twice counts
 * once, the first report of an end standing. Every write is a compare-and-set from the status
 * read, so one lost to another end (a person's stop) leaves that end in place.
 */
export async function runnerConnected(
  ports: RunnerUpdatePorts,
  workspaceId: string,
  hello: RunnerHello,
): Promise<HelloAnswer> {
  const runner: RunnerIdentity = { workspaceId, runnerId: hello.runnerId };
  const now = ports.clock.nowSeconds();

  const ended = new Set<string>();
  for (const report of hello.endedSessions) {
    if (ended.has(report.sessionId)) continue;
    ended.add(report.sessionId);
    const session = await ports.sessions.find(report.sessionId);
    if (!session || !belongsToRunner(session, runner)) continue;
    const status = endReported(session.status, report.status);
    if (status === session.status) continue;
    const changes: CloudSessionChanges = { status, endedAt: now };
    if (status === 'failed') Object.assign(changes, runnerFailure(report.error));
    await ports.sessions.update(session.id, session.status, changes);
  }

  const running = new Set(hello.runningSessionIds.filter((id) => !ended.has(id)));
  for (const session of await ports.sessions.listLive(runner)) {
    if (running.has(session.id)) continue;
    await ports.sessions.update(session.id, session.status, {
      status: 'failed',
      endedAt: now,
      errorCode: CELL_FAILURE_CODES.runnerRestarted,
    });
  }

  const stop: string[] = [];
  for (const sessionId of new Set(hello.runningSessionIds)) {
    const session = await ports.sessions.find(sessionId);
    if (!session || !belongsToRunner(session, runner) || isEnded(session.status)) {
      stop.push(sessionId);
    }
  }
  return { stop };
}
