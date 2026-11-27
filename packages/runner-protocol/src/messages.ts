import { readAgentRun, readAgentRunReport } from './agentRun.js';
import type { AgentRun, AgentRunReport } from './agentRun.js';
import { fieldProblem, isId, isRecord, read, refused } from './read.js';
import type { ReadResult } from './read.js';

/**
 * The largest frame either side of the runner's socket sends or reads, in bytes: room for a
 * `session.start` carrying an agent run's prompt and files. Past it the socket closes with 1009.
 */
export const RUNNER_SOCKET_FRAME_LIMIT_BYTES = 4 * 1024 * 1024;

/** The agent CLIs a runner can start a session with. */
export const HARNESSES = ['claude', 'codex'] as const;
export type Harness = (typeof HARNESSES)[number];

export function isHarness(value: unknown): value is Harness {
  return typeof value === 'string' && (HARNESSES as readonly string[]).includes(value);
}

/** A repository as `owner/name`, the way a runner offers it and a session asks for it. */
export type Repository = string;

const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/**
 * `owner/name`. The name may not be `.` or `..` or start with `.`, so a repository can never name
 * a path above the folder it is cloned into, nor `.git`.
 */
export function isRepository(value: unknown): value is Repository {
  if (typeof value !== 'string' || !REPOSITORY.test(value)) return false;
  return !(value.split('/')[1] ?? '.').startsWith('.');
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The origin a session's host listens on, as `exposePort` gives it: an `https:` origin, or an
 * `http:` origin for the machine's own loopback address (local sandboxes). It carries no user
 * info, path, query or fragment, and `ws:` and `wss:` are refused: the chat's client adds its own
 * scheme.
 */
export function isHostUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  // `origin` leaves out user info, path, query and fragment, so only the bare origin equals it.
  if (url.origin !== value) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname);
}

/** How a session's sandbox ended, as far as the runner reports it. */
export const ENDED_STATUSES = ['stopped', 'failed'] as const;
export type EndedStatus = (typeof ENDED_STATUSES)[number];

/** Every status a session update can name. */
export const SESSION_STATUSES = ['running', ...ENDED_STATUSES] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/**
 * A session that ended while the runner's socket was down. `hello` carries them, so the cell
 * records the real end and never takes the session for one lost in a restart.
 */
export type EndedSession = { sessionId: string; status: EndedStatus; error?: string };

/** The first message on a runner's socket: what it offers and what it still holds. */
export type RunnerHello = {
  type: 'hello';
  runnerId: string;
  repositories: Repository[];
  harnesses: Harness[];
  /** The sessions whose sandboxes the runner still has. */
  runningSessionIds: string[];
  /** The sessions that ended since the runner last spoke to the cell. */
  endedSessions: EndedSession[];
};

/** A session's change, as the runner learned of it. */
export type SessionUpdate = {
  type: 'session.update';
  sessionId: string;
  status?: SessionStatus;
  hostUrl?: string;
  title?: string;
  error?: string;
  /** What the runner says of the session's agent run, for a session started as one. */
  agentRun?: AgentRunReport;
};

export type RunnerMessage = RunnerHello | SessionUpdate;

export type SessionStart = {
  type: 'session.start';
  sessionId: string;
  workspaceId: string;
  /**
   * The repository the session works in, cloned into `SESSION_REPOSITORY_DIR`. Absent for a
   * session with none (an agent run of a factory that names no repository): that folder is left
   * empty, and the sandbox gets no git credentials.
   */
  repository?: Repository;
  harness: Harness;
  /** The key the session's host checks passes with. A public key: never a secret. */
  passPublicKeyPem: string;
  /** Starts the session as an agent run: its first message and its agents come with it. */
  agentRun?: AgentRun;
};

export type SessionStop = { type: 'session.stop'; sessionId: string };

export type CellMessage = SessionStart | SessionStop;

const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (list as readonly string[]).includes(value);

/** Reads each item of an array field, naming the field (never the item) on a refusal. */
function readList<T>(
  value: unknown,
  field: string,
  isItem: (item: unknown) => item is T,
): ReadResult<T[]> {
  if (!Array.isArray(value)) return refused(`\`${field}\` is not a list`);
  if (!value.every(isItem)) return refused(`\`${field}\` holds an item that is not valid`);
  return read([...value]);
}

const ENDED_FIELDS = ['sessionId', 'status', 'error'] as const;

function isEndedSession(value: unknown): value is EndedSession {
  if (!isRecord(value)) return false;
  const { sessionId, status, error } = value;
  const known = Object.keys(value).every((key) =>
    (ENDED_FIELDS as readonly string[]).includes(key),
  );
  return (
    known &&
    isId(sessionId) &&
    isOneOf(ENDED_STATUSES, status) &&
    (error === undefined || isId(error))
  );
}

const HELLO = [
  'type',
  'runnerId',
  'repositories',
  'harnesses',
  'runningSessionIds',
  'endedSessions',
] as const;

function readHello(message: Record<string, unknown>): ReadResult<RunnerHello> {
  const fields = fieldProblem(message, HELLO, 'the hello');
  if (fields !== null) return refused(fields);
  const { runnerId } = message;
  if (!isId(runnerId)) return refused("`runnerId` is not a runner's id");
  const repositories = readList(message.repositories, 'repositories', isRepository);
  if (!repositories.ok) return repositories;
  const harnesses = readList(message.harnesses, 'harnesses', isHarness);
  if (!harnesses.ok) return harnesses;
  const running = readList(message.runningSessionIds, 'runningSessionIds', isId);
  if (!running.ok) return running;
  const ended = readList(message.endedSessions, 'endedSessions', isEndedSession);
  if (!ended.ok) return ended;
  return read({
    type: 'hello',
    runnerId,
    repositories: repositories.value,
    harnesses: harnesses.value,
    runningSessionIds: running.value,
    endedSessions: ended.value,
  });
}

const UPDATE_FIELDS = [
  'type',
  'sessionId',
  'status',
  'hostUrl',
  'title',
  'error',
  'agentRun',
] as const;

function readUpdate(message: Record<string, unknown>): ReadResult<SessionUpdate> {
  const extra = Object.keys(message).find(
    (key) => !(UPDATE_FIELDS as readonly string[]).includes(key),
  );
  if (extra !== undefined) {
    return refused(`the update has \`${extra}\`, which the protocol does not name`);
  }
  const { sessionId, status, hostUrl, title, error, agentRun } = message;
  if (!isId(sessionId)) return refused("`sessionId` is not a session's id");
  const update: SessionUpdate = { type: 'session.update', sessionId };
  if (status !== undefined) {
    if (!isOneOf(SESSION_STATUSES, status)) return refused('`status` is not a session status');
    update.status = status;
  }
  if (hostUrl !== undefined) {
    if (!isHostUrl(hostUrl)) return refused('`hostUrl` is not the origin of a session host');
    update.hostUrl = hostUrl;
  }
  if (title !== undefined) {
    if (!isId(title)) return refused('`title` is not text');
    update.title = title;
  }
  if (error !== undefined) {
    if (!isId(error)) return refused('`error` is not text');
    update.error = error;
  }
  if (agentRun !== undefined) {
    const report = readAgentRunReport(agentRun);
    if (!report.ok) return refused(`\`agentRun\` is not an agent run's report: ${report.reason}`);
    update.agentRun = report.value;
  }
  return read(update);
}

/**
 * Reads what a runner sent the cell. It refuses a `type` it does not know and any field the
 * protocol does not name, and a reason names the field, never what it held.
 */
export function readRunnerMessage(json: unknown): ReadResult<RunnerMessage> {
  if (!isRecord(json)) return refused('the message is not an object');
  if (json.type === 'hello') return readHello(json);
  if (json.type === 'session.update') return readUpdate(json);
  return refused('`type` is not a runner message');
}

const START = ['type', 'sessionId', 'workspaceId', 'harness', 'passPublicKeyPem'] as const;

function readStart(message: Record<string, unknown>): ReadResult<SessionStart> {
  const asAgentRun = Object.hasOwn(message, 'agentRun');
  // A start with no repository leaves `repository` out; one that names it names a repository.
  const withRepository = Object.hasOwn(message, 'repository');
  const fields = fieldProblem(
    message,
    [...START, ...(withRepository ? ['repository'] : []), ...(asAgentRun ? ['agentRun'] : [])],
    'the start',
  );
  if (fields !== null) return refused(fields);
  const { sessionId, workspaceId, repository, harness, passPublicKeyPem } = message;
  if (!isId(sessionId)) return refused("`sessionId` is not a session's id");
  if (!isId(workspaceId)) return refused("`workspaceId` is not a workspace's id");
  if (withRepository && !isRepository(repository)) {
    return refused('`repository` is not `owner/name`');
  }
  if (!isHarness(harness)) return refused('`harness` is not a harness');
  if (!isId(passPublicKeyPem)) return refused('`passPublicKeyPem` is not a key');
  const start: SessionStart = {
    type: 'session.start',
    sessionId,
    workspaceId,
    ...(isRepository(repository) ? { repository } : {}),
    harness,
    passPublicKeyPem,
  };
  if (asAgentRun) {
    const run = readAgentRun(message.agentRun);
    if (!run.ok) return refused(`\`agentRun\` is not an agent run: ${run.reason}`);
    // A commit to check out is a commit of the repository: with none, there is nothing to fetch.
    if (run.value.checkout !== undefined && start.repository === undefined) {
      return refused('`agentRun` names a `checkout`, but the start names no `repository`');
    }
    start.agentRun = run.value;
  }
  return read(start);
}

function readStop(message: Record<string, unknown>): ReadResult<SessionStop> {
  const fields = fieldProblem(message, ['type', 'sessionId'], 'the stop');
  if (fields !== null) return refused(fields);
  const { sessionId } = message;
  if (!isId(sessionId)) return refused("`sessionId` is not a session's id");
  return read({ type: 'session.stop', sessionId });
}

/** Reads what the cell sent a runner, as strictly as `readRunnerMessage`. */
export function readCellMessage(json: unknown): ReadResult<CellMessage> {
  if (!isRecord(json)) return refused('the message is not an object');
  if (json.type === 'session.start') return readStart(json);
  if (json.type === 'session.stop') return readStop(json);
  return refused('`type` is not a cell message');
}
