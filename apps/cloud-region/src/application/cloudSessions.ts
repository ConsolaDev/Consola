import {
  PASS_MAX_LIFETIME_SECONDS,
  passClaims,
  type SessionUpdate,
} from '@consola/runner-protocol';
import type { Caller } from '../domain/caller.js';
import {
  belongsToRunner,
  CELL_FAILURE_CODES,
  type CloudSession,
  isEnded,
  readStartRequest,
  runnerFailure,
  type StartRequest,
  transition,
} from '../domain/cloudSession.js';
import type {
  CloudSessionChanges,
  CloudSessionPorts,
  RunnerIdentity,
  RunnerUpdatePorts,
} from './ports.js';

export { readStartRequest };

/** What the connected runner offers the caller's workspace. */
export type OptionsAnswer =
  | { kind: 'ok'; repositories: string[]; harnesses: string[] }
  | { kind: 'no_runner' };

export function sessionOptions(ports: CloudSessionPorts, caller: Caller): OptionsAnswer {
  const offer = ports.runners.connected(caller.workspaceId);
  if (!offer) return { kind: 'no_runner' };
  return { kind: 'ok', repositories: offer.repositories, harnesses: offer.harnesses };
}

export type StartAnswer =
  | { kind: 'ok'; session: CloudSession }
  | { kind: 'no_runner' | 'repository_not_offered' | 'harness_not_offered' };

/**
 * Starts a session for the caller. Nothing is recorded or sent unless a runner is connected and
 * offers both the repository and the harness. The row is recorded `starting` before the runner is
 * told, so its first update finds it. When the runner cannot be told, the row ends `failed` with
 * the cell's own code, and what the transport said is never kept.
 */
export async function startSession(
  ports: CloudSessionPorts,
  caller: Caller,
  request: StartRequest,
): Promise<StartAnswer> {
  const offer = ports.runners.connected(caller.workspaceId);
  if (!offer) return { kind: 'no_runner' };
  if (!offer.repositories.includes(request.repository)) return { kind: 'repository_not_offered' };
  if (!offer.harnesses.includes(request.harness)) return { kind: 'harness_not_offered' };

  const session: CloudSession = {
    id: ports.ids.newId(),
    workspaceId: caller.workspaceId,
    personId: caller.personId,
    repository: request.repository,
    harness: request.harness,
    status: 'starting',
    title: null,
    hostUrl: null,
    error: null,
    errorCode: null,
    runnerId: offer.runnerId,
    createdAt: ports.clock.nowSeconds(),
    endedAt: null,
  };
  await ports.sessions.insert(session);

  try {
    await ports.runners.startSession(offer.runnerId, {
      sessionId: session.id,
      workspaceId: session.workspaceId,
      repository: session.repository,
      harness: session.harness,
    });
  } catch {
    const failed = transition(session, 'failed', ports.clock.nowSeconds());
    const changes = {
      status: failed.status,
      endedAt: failed.endedAt,
      errorCode: CELL_FAILURE_CODES.runnerUnreachable,
    };
    await ports.sessions.update(session.id, 'starting', changes);
    const held = await ports.sessions.find(session.id);
    return { kind: 'ok', session: held ?? { ...failed, ...changes } };
  }
  return { kind: 'ok', session };
}

export function listSessions(ports: CloudSessionPorts, caller: Caller): Promise<CloudSession[]> {
  return ports.sessions.listOwn(caller.workspaceId, caller.personId);
}

export type SessionAnswer = { kind: 'ok'; session: CloudSession } | { kind: 'not_found' };

/** One of the caller's own sessions; anyone else's is `not_found`, as if it did not exist. */
export async function getSession(
  ports: CloudSessionPorts,
  caller: Caller,
  sessionId: string,
): Promise<SessionAnswer> {
  const session = await ports.sessions.findOwn(caller.workspaceId, caller.personId, sessionId);
  return session ? { kind: 'ok', session } : { kind: 'not_found' };
}

/**
 * Ends the caller's session at once, whether or not its runner is connected: the row becomes
 * `stopped`, and the runner is told only if it is the session's own runner and connected. A
 * runner that is away, or that cannot be told, still holds the sandbox, but the row is ended, so
 * when its `hello` lists the session the cell answers with a stop (Review Focus 7). A stop of an
 * ended session changes and sends nothing.
 */
export async function stopSession(
  ports: CloudSessionPorts,
  caller: Caller,
  sessionId: string,
): Promise<SessionAnswer> {
  const session = await ports.sessions.findOwn(caller.workspaceId, caller.personId, sessionId);
  if (!session) return { kind: 'not_found' };
  if (isEnded(session.status)) return { kind: 'ok', session };

  const now = ports.clock.nowSeconds();
  const won = await ports.sessions.update(session.id, session.status, {
    status: 'stopped',
    endedAt: now,
  });
  const current = (await ports.sessions.find(session.id)) ?? session;
  // Another change ended it first (a runner's failure): that end stands, and nobody is told.
  if (!won) return { kind: 'ok', session: current };

  if (ports.runners.connected(caller.workspaceId)?.runnerId === session.runnerId) {
    try {
      await ports.runners.stopSession(session.runnerId, session.id);
    } catch {
      // The row is ended; `hello` will have the runner stop what it still holds.
    }
  }
  return { kind: 'ok', session: current };
}

/**
 * A row's status moves at most twice (`starting` to `running`, then to an end), and an ended row
 * is left alone. So an update that loses its compare-and-set to another change finds, by its
 * third look, either a row it can change or one that has ended.
 */
const UPDATE_ATTEMPTS = 3;

/** What an update changes on a live row: its status, as `nextStatus` allows, and what it says. */
function changesOf(session: CloudSession, update: SessionUpdate, now: number): CloudSessionChanges {
  const moved = update.status ? transition(session, update.status, now) : session;
  const changes: CloudSessionChanges = {};
  if (moved.status !== session.status) {
    changes.status = moved.status;
    changes.endedAt = moved.endedAt;
    if (moved.status === 'failed') Object.assign(changes, runnerFailure(update.error));
  }
  if (update.title !== undefined) changes.title = update.title;
  if (update.hostUrl !== undefined) changes.hostUrl = update.hostUrl;
  return changes;
}

/**
 * Applies what a runner said of a session. It counts only from the runner the row names, in the
 * workspace that runner serves, and never changes an ended row. A runner's failure keeps its own
 * message in `error`, or gets the cell's `runner_failed` when it gave none; a title and a host
 * address are stored as given. The write is a compare-and-set on the status it read, so a late
 * update never overwrites an end. One that loses to another change (a person's stop, the start
 * failing) reads the row again and tries once more, so a title or an address is not lost to a
 * status that moved meanwhile, and is dropped only once the row has ended.
 */
export async function applyRunnerUpdate(
  ports: RunnerUpdatePorts,
  runner: RunnerIdentity,
  update: SessionUpdate,
): Promise<void> {
  for (let attempt = 0; attempt < UPDATE_ATTEMPTS; attempt += 1) {
    const session = await ports.sessions.find(update.sessionId);
    if (!session || !belongsToRunner(session, runner) || isEnded(session.status)) return;
    const changes = changesOf(session, update, ports.clock.nowSeconds());
    if (Object.keys(changes).length === 0) return;
    if (await ports.sessions.update(session.id, session.status, changes)) return;
  }
}

/** A pass lives as long as a pass may, five minutes; the page asks for another when it needs one. */
export const PASS_LIFETIME_SECONDS = PASS_MAX_LIFETIME_SECONDS;

export type PassAnswer =
  | { kind: 'ok'; pass: string; hostUrl: string; expiresAt: number }
  | { kind: 'not_found' | 'no_runner' };

/**
 * A pass for the caller's own running session, which its host checks before it serves them: the
 * protocol's claims for the caller and the session (`passClaims`), for `PASS_LIFETIME_SECONDS`.
 * `expiresAt` is the pass's `exp`, in whole seconds. Anything else is `not_found`, as if it did
 * not exist: a session still starting or ended, a running one whose host has no address yet,
 * another person's or another workspace's, or an id the cell does not hold. A cell with no pass
 * key issues none (`no_runner`: such a cell has no runner either).
 */
export async function issuePass(
  ports: CloudSessionPorts,
  caller: Caller,
  sessionId: string,
): Promise<PassAnswer> {
  const session = await ports.sessions.findOwn(caller.workspaceId, caller.personId, sessionId);
  if (session?.status !== 'running' || session.hostUrl === null) {
    return { kind: 'not_found' };
  }
  if (!ports.passes) return { kind: 'no_runner' };
  const claims = passClaims({
    personId: caller.personId,
    workspaceId: caller.workspaceId,
    sessionId: session.id,
    issuedAt: ports.clock.nowSeconds(),
    lifetimeSeconds: PASS_LIFETIME_SECONDS,
  });
  const pass = await ports.passes.sign(claims);
  return { kind: 'ok', pass, hostUrl: session.hostUrl, expiresAt: claims.exp };
}
