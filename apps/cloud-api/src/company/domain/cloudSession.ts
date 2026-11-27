import { isHarness, isRepository } from '@consola/runner-protocol';
import type { AgentRunReport, EndedStatus, Harness, Repository } from '@consola/runner-protocol';

/** Where a cloud session is in its life. `stopped` and `failed` are ends. */
export const CLOUD_SESSION_STATUSES = ['starting', 'running', 'stopped', 'failed'] as const;
export type CloudSessionStatus = (typeof CLOUD_SESSION_STATUSES)[number];

/**
 * The codes of failures the app decides itself, which `cloud-web` words. A failure a runner
 * reports is its own message instead, kept in `error` and never mistaken for one of these
 * (`CloudSession.errorCode`).
 */
export const CELL_FAILURE_CODES = {
  /** The runner restarted and its sandbox for the session is gone (the runner's `hello`). */
  runnerRestarted: 'runner_restarted',
  /** The app could not hand the start to the runner. */
  runnerUnreachable: 'runner_unreachable',
  /** The runner reported a failure without a message of its own. */
  runnerFailed: 'runner_failed',
  /** An agent run found no runner connected for its workspace, so nothing ran. */
  runnerUnavailable: 'runner_unavailable',
  /** An agent run's repository is not one the connected runner offers. */
  repositoryNotOffered: 'repository_not_offered',
  /** An agent run's agent names a harness the connected runner does not offer. */
  harnessNotOffered: 'harness_not_offered',
  /** The app could not compose a start the protocol reads from the factory's team. */
  agentRunInvalid: 'agent_run_invalid',
} as const;
export type CellFailureCode = (typeof CELL_FAILURE_CODES)[keyof typeof CELL_FAILURE_CODES];

/** The item an agent run was started on: a GitHub pull request, as its event described it. */
export type AgentRunItem = {
  kind: 'pull_request';
  /** `owner/name`. */
  repository: string;
  number: number;
  url: string;
  title: string;
  /** The commit the event named, which the run checks out. */
  headSha: string;
};

/** What started an agent run an automation of a factory's team started, on an item. */
export type AutomationOrigin = {
  kind: 'automation';
  factoryId: string;
  factoryName: string;
  automation: string;
  /** The agent that takes the first turn: the automation's, by default the team's orchestrator. */
  agent: string;
  item: AgentRunItem;
};

/** The Slack message a request from Slack came from, and the thread Consola answers in. */
export type SlackOriginMessage = {
  /** The Slack workspace (`T…`). */
  teamId: string;
  /** The channel, or the direct message, it was written in. */
  channelId: string;
  /** The thread Consola answers in: the message's own, or the one it was written in. */
  threadTs: string;
  /** The message itself. */
  messageTs: string;
  /** Its permalink, from Slack (`chat.getPermalink`). */
  permalink: string;
  /** Its first line, cut: written by a person in Slack, shown as text. */
  title: string;
};

/**
 * What started a request from Slack: a person mentioned a factory's bot, or sent it a direct
 * message, and its orchestrator takes it.
 */
export type SlackOrigin = {
  kind: 'slack';
  factoryId: string;
  factoryName: string;
  /** The agent that takes the first turn: the factory's orchestrator. */
  agent: string;
  /** `mention`: the bot was mentioned in a channel; `dm`: sent a direct message. */
  via: 'mention' | 'dm';
  message: SlackOriginMessage;
};

/**
 * What started an agent run: an automation of a factory's team, on an item, or a request made in
 * Slack. A person's session has none.
 */
export type SessionOrigin = AutomationOrigin | SlackOrigin;

/**
 * One cloud session as the app records it. Times are whole seconds since the epoch.
 *
 * A session is a person's, or an agent run: a session an automation started, which nobody types
 * into (`origin`). A person's session is theirs alone; an agent run is the workspace's, and every
 * member sees it (`isSeenBy`).
 *
 * A failure carries exactly one of two things, never both: `error`, the message the runner
 * reported (provider or start script), or `errorCode`, a code the app decided itself
 * (`CELL_FAILURE_CODES`). Both are null while the session lives or when it was stopped.
 */
export type CloudSession = {
  id: string;
  workspaceId: string;
  /**
   * The person who started it, by their id: the only one who sees it. Null for an agent
   * run, which no person started.
   */
  personId: string | null;
  /**
   * The repository it works in, as `owner/name`. Null for an agent run of a factory that names
   * none (a request from Slack): its sandbox starts in an empty folder, with no git credentials.
   * A person's session, and an agent run on a pull request, always have one.
   */
  repository: Repository | null;
  harness: Harness;
  status: CloudSessionStatus;
  title: string | null;
  /** The origin the session's host listens on, once the runner reported it. */
  hostUrl: string | null;
  error: string | null;
  errorCode: CellFailureCode | null;
  /**
   * The runner the start was handed to; only its updates count. Null for an agent run no runner
   * took, which ended `failed` as it was recorded.
   */
  runnerId: string | null;
  createdAt: number;
  endedAt: number | null;
  /** What started an agent run (an automation, or a request from Slack); null for a person's session. */
  origin: SessionOrigin | null;
  /** The last report the runner sent of an agent run; null until it sent one. */
  agentRun: AgentRunReport | null;
};

/** Whether the session is an agent run, which an automation started and the workspace sees. */
export const isAgentRun = (session: CloudSession): boolean => session.origin !== null;

/**
 * Whether a person of a workspace sees a session: their own, or any agent run of the workspace.
 * Anything else is not found, as if it did not exist.
 */
export const isSeenBy = (
  session: CloudSession,
  viewer: { workspaceId: string; personId: string },
): boolean =>
  session.workspaceId === viewer.workspaceId &&
  (session.personId === viewer.personId || isAgentRun(session));

export const isEnded = (status: CloudSessionStatus): boolean =>
  status === 'stopped' || status === 'failed';

/** The statuses of a session that has not ended. */
export const LIVE_STATUSES = [
  'starting',
  'running',
] as const satisfies readonly CloudSessionStatus[];

/**
 * Who a runner is: the workspace its secret serves, and the id it calls itself in `hello`. A
 * runner picks its own id, so two workspaces' runners may share one: the workspace tells them
 * apart.
 */
export type RunnerIdentity = { workspaceId: string; runnerId: string };

/** Whether the row is that runner's: the runner it names, in the workspace the runner serves. */
export const belongsToRunner = (session: CloudSession, runner: RunnerIdentity): boolean =>
  session.workspaceId === runner.workspaceId && session.runnerId === runner.runnerId;

/**
 * The status after an update names `update`: `starting` goes to `running` or `failed`, `running`
 * to `stopped` or `failed`. Anything else, an ended session included, stays as it is.
 */
export function nextStatus(
  current: CloudSessionStatus,
  update: 'running' | 'stopped' | 'failed',
): CloudSessionStatus {
  if (current === 'starting' && (update === 'running' || update === 'failed')) return update;
  if (current === 'running' && (update === 'stopped' || update === 'failed')) return update;
  return current;
}

/** The session after `nextStatus` moved it at `now`: reaching an end sets `endedAt`. */
export function transition(
  session: CloudSession,
  update: 'running' | 'stopped' | 'failed',
  now: number,
): CloudSession {
  const status = nextStatus(session.status, update);
  if (status === session.status) return session;
  return { ...session, status, endedAt: isEnded(status) ? now : null };
}

/**
 * The status after a runner's `hello` reported how a session ended while its socket was down: a
 * live session takes that end, `starting` included, since the `running` before it may have been
 * lost with the socket. An ended session keeps its own end.
 */
export function endReported(current: CloudSessionStatus, end: EndedStatus): CloudSessionStatus {
  return isEnded(current) ? current : end;
}

/**
 * How a failure a runner reported is kept: its own message in `error`, or, when it gave none,
 * the app's `runner_failed`. So a failed row always carries one of the two, and never both.
 */
export function runnerFailure(
  error: string | undefined,
): Pick<CloudSession, 'error' | 'errorCode'> {
  return error === undefined
    ? { error: null, errorCode: CELL_FAILURE_CODES.runnerFailed }
    : { error, errorCode: null };
}

/** What a person asks for when they start a session. */
export type StartRequest = { repository: Repository; harness: Harness };

const START_FIELDS = ['repository', 'harness'];

/** Reads a request body: exactly `{ repository, harness }`, each valid. Never throws. */
export function readStartRequest(body: unknown): { ok: true; value: StartRequest } | { ok: false } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false };
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== START_FIELDS.length || !keys.every((key) => START_FIELDS.includes(key))) {
    return { ok: false };
  }
  const { repository, harness } = record;
  if (!isRepository(repository) || !isHarness(harness)) return { ok: false };
  return { ok: true, value: { repository, harness } };
}
