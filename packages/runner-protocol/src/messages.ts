import {
  type FactoriesAnswer,
  type FactoriesRequest,
  type GitHubEventAck,
  type GitHubEventNotice,
  type GitHubStepToken,
  type GitHubStepTokenRefused,
  type GitHubStepTokenRequest,
  type RunAnswered,
  type RunRecordMessage,
  type RunRefused,
  readFactoriesAnswer,
  readFactoriesRequest,
  readGitHubEventAck,
  readGitHubEventNotice,
  readGitHubStepToken,
  readGitHubStepTokenRefused,
  readGitHubStepTokenRequest,
  readRunAnswered,
  readRunRecordMessage,
  readRunRefused,
} from './automationMessages.js';
import {
  fieldProblem,
  isId,
  isOneOf,
  isRecord,
  type ReadResult,
  read,
  readList,
  refused,
} from './read.js';
import { isRepository, type Repository } from './repository.js';

/**
 * The most one message's JSON may be on the runner's socket, in bytes of UTF-8: both sides refuse
 * a larger frame, closing the socket with 1009 (Message Too Big) before they read it.
 */
export const SOCKET_FRAME_MAX_BYTES = 4 * 1024 * 1024;

/** The agent CLIs a runner can start a session with. */
export const HARNESSES = ['claude', 'codex'] as const;
export type Harness = (typeof HARNESSES)[number];

export function isHarness(value: unknown): value is Harness {
  return typeof value === 'string' && (HARNESSES as readonly string[]).includes(value);
}

const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

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
  return url.protocol === 'http:' && LOCAL_HOSTS.includes(url.hostname);
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
  /**
   * Whether this runner runs automations: only then does the cell send it GitHub's events and a
   * person's answers to runs, and take its runs and token requests.
   */
  automations: boolean;
};

/** A session's change, as the runner learned of it. */
export type SessionUpdate = {
  type: 'session.update';
  sessionId: string;
  status?: SessionStatus;
  hostUrl?: string;
  title?: string;
  error?: string;
};

export type RunnerMessage =
  | RunnerHello
  | SessionUpdate
  | FactoriesRequest
  | RunRecordMessage
  | GitHubEventAck
  | GitHubStepTokenRequest;

export type SessionStart = {
  type: 'session.start';
  sessionId: string;
  workspaceId: string;
  repository: Repository;
  harness: Harness;
  /** The key the session's host checks passes with. A public key: never a secret. */
  passPublicKeyPem: string;
};

export type SessionStop = { type: 'session.stop'; sessionId: string };

export type CellMessage =
  | SessionStart
  | SessionStop
  | GitHubEventNotice
  | FactoriesAnswer
  | RunAnswered
  | GitHubStepToken
  | GitHubStepTokenRefused
  | RunRefused;

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
  'automations',
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
  const { automations } = message;
  if (typeof automations !== 'boolean') return refused('`automations` is not true or false');
  return read({
    type: 'hello',
    runnerId,
    repositories: repositories.value,
    harnesses: harnesses.value,
    runningSessionIds: running.value,
    endedSessions: ended.value,
    automations,
  });
}

const UPDATE_FIELDS = ['type', 'sessionId', 'status', 'hostUrl', 'title', 'error'] as const;

function readUpdate(message: Record<string, unknown>): ReadResult<SessionUpdate> {
  const extra = Object.keys(message).find(
    (key) => !(UPDATE_FIELDS as readonly string[]).includes(key),
  );
  if (extra !== undefined) {
    return refused(`the update has \`${extra}\`, which the protocol does not name`);
  }
  const { sessionId, status, hostUrl, title, error } = message;
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
  return read(update);
}

/**
 * Reads what a runner sent the cell. It refuses a `type` it does not know and any field the
 * protocol does not name, and a reason names the field, never what it held.
 */
export function readRunnerMessage(json: unknown): ReadResult<RunnerMessage> {
  if (!isRecord(json)) return refused('the message is not an object');
  switch (json.type) {
    case 'hello':
      return readHello(json);
    case 'session.update':
      return readUpdate(json);
    case 'factories.request':
      return readFactoriesRequest(json);
    case 'run.record':
      return readRunRecordMessage(json);
    case 'github.event.ack':
      return readGitHubEventAck(json);
    case 'github.token.request':
      return readGitHubStepTokenRequest(json);
    default:
      return refused('`type` is not a runner message');
  }
}

const START = [
  'type',
  'sessionId',
  'workspaceId',
  'repository',
  'harness',
  'passPublicKeyPem',
] as const;

function readStart(message: Record<string, unknown>): ReadResult<SessionStart> {
  const fields = fieldProblem(message, START, 'the start');
  if (fields !== null) return refused(fields);
  const { sessionId, workspaceId, repository, harness, passPublicKeyPem } = message;
  if (!isId(sessionId)) return refused("`sessionId` is not a session's id");
  if (!isId(workspaceId)) return refused("`workspaceId` is not a workspace's id");
  if (!isRepository(repository)) return refused('`repository` is not `owner/name`');
  if (!isHarness(harness)) return refused('`harness` is not a harness');
  if (!isId(passPublicKeyPem)) return refused('`passPublicKeyPem` is not a key');
  return read({
    type: 'session.start',
    sessionId,
    workspaceId,
    repository,
    harness,
    passPublicKeyPem,
  });
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
  switch (json.type) {
    case 'session.start':
      return readStart(json);
    case 'session.stop':
      return readStop(json);
    case 'github.event':
      return readGitHubEventNotice(json);
    case 'factories':
      return readFactoriesAnswer(json);
    case 'run.answered':
      return readRunAnswered(json);
    case 'github.token':
      return readGitHubStepToken(json);
    case 'github.token.refused':
      return readGitHubStepTokenRefused(json);
    case 'run.refused':
      return readRunRefused(json);
    default:
      return refused('`type` is not a cell message');
  }
}
