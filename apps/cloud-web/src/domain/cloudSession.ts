import type { CellRefusal } from './cell';
import type { components, paths } from './cellApiContract';
import {
  AGENT_RUN_PHASE_WORDS,
  failedWords,
  HARNESS_NAMES,
  SESSION_STATUS_WORDS,
  STARTING_WORDS,
  STOPPED_WORDS,
  UNPUSHED_CHANGES_WARNING,
} from './cloudSessionMessages';
import { safeItemUrl } from './runs';

/**
 * Cloud sessions as the web app sees them: each a sandbox the workspace's runner runs, with an
 * agent CLI working in one of the runner's repositories. A person's own session is started from
 * the New session form, and only they see it; an agent run is started by an automation of a
 * factory's agent team, when a pull request opens, and every member of the workspace sees it
 * (`origin` names what started it, `agentRun` is the runner's last report of it). They live in
 * the workspace's regional cell (`apps/cloud-region/AGENTS.md`, "Cloud sessions"), which decides
 * every status: `starting` goes to `running` or `failed`, and `running` to `stopped` or
 * `failed`, the two ends. A running session's chat connects straight to its sandbox's host, with
 * a short-lived pass the cell signs.
 */

type Schemas = components['schemas'];

export type CloudSession = Schemas['CloudSession'];
export type CloudSessionOptions = Schemas['CloudSessionOptions'];
export type CloudSessionPass = Schemas['CloudSessionPass'];
export type CloudSessionStatus = CloudSession['status'];
export type Harness = CloudSession['harness'];
/** A failure the cell decided itself, which the page words (never shows as a code). */
export type CellFailureCode = NonNullable<CloudSession['errorCode']>;

/** What started an agent run: an automation of a factory's agent team, on a pull request. */
export type CloudSessionOrigin = Schemas['CloudSessionOrigin'];
/** The runner's last report of an agent run. */
export type AgentRunReport = Schemas['AgentRunReport'];
export type AgentRunState = AgentRunReport['state'];
/** An agent the run's first agent (the foreman) dispatched, as the runner last reported it. */
export type DispatchedAgent = NonNullable<AgentRunReport['agents']>[number];
export type DispatchedAgentStatus = DispatchedAgent['status'];

/** An agent run: a session an automation started, which nobody types into. */
export type AgentRun = CloudSession & { origin: CloudSessionOrigin };

/** Whether a session is an agent run (an automation started it), not a person's own. */
export function isAgentRun(session: CloudSession): session is AgentRun {
  return session.origin !== null;
}

/**
 * Where an agent run stands, in the page's words: the runner's report while it has one, else the
 * session's status. A report that the run finished or failed is the run's end, whatever came of
 * the sandbox after it; a session that ended before such a report failed, or was stopped before
 * the run finished.
 */
export type AgentRunPhase = 'starting' | AgentRunState | 'stopped';

export function agentRunPhase(session: Pick<CloudSession, 'status' | 'agentRun'>): AgentRunPhase {
  const reported = session.agentRun?.state;
  if (reported === 'done' || reported === 'failed') return reported;
  switch (session.status) {
    case 'starting':
      return 'starting';
    case 'running':
      return reported ?? 'working';
    case 'stopped':
      return 'stopped';
    case 'failed':
      return 'failed';
  }
}

/** How an agent run's phase is said: working, waiting on a question, finished, failed. */
export function agentRunPhaseWords(session: Pick<CloudSession, 'status' | 'agentRun'>): string {
  return AGENT_RUN_PHASE_WORDS[agentRunPhase(session)];
}

/** A pull request as a person names it: `owner/name#12 Title`. */
export function pullRequestLabel(item: CloudSessionOrigin['item']): string {
  const title = item.title.trim();
  return `${item.repository}#${item.number}${title ? ` ${title}` : ''}`;
}

/** The pull request's address, only when it is an `https:` one: the cell passes GitHub's on. */
export function pullRequestUrl(item: CloudSessionOrigin['item']): string | null {
  return safeItemUrl(item.url);
}

/** A commit as it is shown: its first seven characters. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** The agents an agent run dispatched, as the runner last reported them; none before a report. */
export function dispatchedAgents(session: Pick<CloudSession, 'agentRun'>): DispatchedAgent[] {
  return session.agentRun?.agents ?? [];
}

/** The foreman's result: its last message, once the runner reported one with any text. */
export function agentRunSummary(session: Pick<CloudSession, 'agentRun'>): string | null {
  const summary = session.agentRun?.summary;
  return summary && summary.trim() !== '' ? summary : null;
}

type StartError<Status extends 400 | 503> =
  paths['/api/cloud-sessions']['post']['responses'][Status]['content']['application/json']['error'];

/**
 * Why the cell refused to start a session, by its code: no runner connected, a repository or a
 * harness the runner does not offer, or a body it could not read. Nothing was recorded for any.
 */
export type StartRefusalCode = Exclude<
  StartError<400> | StartError<503>,
  'token_check_unavailable'
>;

export function isHarness(value: unknown): value is Harness {
  return typeof value === 'string' && Object.hasOwn(HARNESS_NAMES, value);
}

export function isSessionStatus(value: unknown): value is CloudSessionStatus {
  return typeof value === 'string' && Object.hasOwn(SESSION_STATUS_WORDS, value);
}

/** Whether a session has ended: it never moves again. */
export function isEnded(status: CloudSessionStatus): boolean {
  return status === 'stopped' || status === 'failed';
}

/** What a session is called: its title, or "Session" and its id's first eight characters. */
export function sessionLabel(session: Pick<CloudSession, 'id' | 'title'>): string {
  const title = session.title?.trim();
  return title ? title : `Session ${session.id.slice(0, 8)}`;
}

/** When a session started, as an ISO time (the cell counts epoch seconds). */
export function startedAt(session: Pick<CloudSession, 'createdAt'>): string {
  return new Date(session.createdAt * 1000).toISOString();
}

const POLL_MS: Readonly<Record<CloudSessionStatus, number | null>> = {
  starting: 2000,
  running: 10_000,
  stopped: null,
  failed: null,
};

/** How long an agent run's page waits while it runs: its report (state, result, agents) moves. */
export const AGENT_RUN_POLL_MS = 5000;

/**
 * How long a session's page waits before reading it again: briefly while its sandbox starts,
 * longer while it runs (to notice it stop), and never once it has ended. A running agent run is
 * read more often, since what the page shows of it is its report, which only a read brings.
 */
export function pollIntervalMs(
  status: CloudSessionStatus,
  kind: 'session' | 'agent-run' = 'session',
): number | null {
  return kind === 'agent-run' && status === 'running' ? AGENT_RUN_POLL_MS : POLL_MS[status];
}

/** How long a session's page waits before reading it again, for that session. */
export function sessionPollIntervalMs(session: CloudSession): number | null {
  return pollIntervalMs(session.status, isAgentRun(session) ? 'agent-run' : 'session');
}

/** How long the list waits once nothing shown can change: a session started elsewhere shows. */
export const LIST_POLL_QUIET_MS = 30_000;

/** How long the list waits before reading again: as often as its liveliest session asks. */
export function listPollIntervalMs(
  sessions: ReadonlyArray<{ status: CloudSessionStatus }>,
): number {
  const delays = sessions
    .map((session) => pollIntervalMs(session.status))
    .filter((delay) => delay !== null);
  return delays.length > 0 ? Math.min(...delays) : LIST_POLL_QUIET_MS;
}

/**
 * Whether the page mounts the chat: only while the session runs. Once it has stopped or failed,
 * the chat unmounts, which closes its connection to the host and forgets its pass.
 */
export function chatMounted(status: CloudSessionStatus): boolean {
  return status === 'running';
}

/**
 * Whether the chat may ask the cell for a new pass when its own expires: only while the session
 * runs. A session starting has no host yet, and one ended never will, so no pass is asked for and
 * the chat does not loop reconnecting.
 */
export function shouldRenewPass(status: CloudSessionStatus): boolean {
  return status === 'running';
}

/**
 * Whether a read that came to nothing keeps what the page shows (a session, with its chat; the
 * list), saying when it was read: only while the cell or `cloud-global` is out for a while
 * (`unavailable`, `pending`), since the next read may work. Signed out, or with another workspace
 * open, the page says so instead and a running chat unmounts, so no one goes on using a session
 * the page can no longer vouch for; and a session the cell no longer has is gone.
 */
export function keepsShownOn(answer: { kind: CellRefusal['kind'] | 'not-found' }): boolean {
  return answer.kind === 'unavailable' || answer.kind === 'pending';
}

/** What a session's page shows for it. */
export type SessionScreen =
  /** The sandbox is starting: the words alone, read again shortly. */
  | { kind: 'starting'; words: string }
  /** The chat, with the warning above it and Stop. */
  | { kind: 'running'; warning: string }
  /** The words, with no chat and so no composer. */
  | { kind: 'stopped'; words: string }
  | { kind: 'failed'; words: string };

export function sessionScreen(
  session: Pick<CloudSession, 'status' | 'error' | 'errorCode' | 'repository' | 'harness'>,
): SessionScreen {
  switch (session.status) {
    case 'starting':
      return { kind: 'starting', words: STARTING_WORDS };
    case 'running':
      return { kind: 'running', warning: UNPUSHED_CHANGES_WARNING };
    case 'stopped':
      return { kind: 'stopped', words: STOPPED_WORDS };
    case 'failed':
      return { kind: 'failed', words: failedWords(session) };
  }
}

/** What reading the person's sessions came to. */
export type SessionsAnswer = { kind: 'listed'; sessions: CloudSession[] } | CellRefusal;

/** What reading one session came to. */
export type SessionAnswer =
  | { kind: 'found'; session: CloudSession }
  /** None, or someone else's: the cell says the same of both. */
  | { kind: 'not-found' }
  | CellRefusal;

/** What asking what a new session can be came to. */
export type OptionsAnswer =
  | { kind: 'offered'; options: CloudSessionOptions }
  | { kind: 'no-runner' }
  | CellRefusal;

/** What starting a session came to. */
export type StartAnswer =
  | { kind: 'started'; session: CloudSession }
  | { kind: 'refused'; code: StartRefusalCode }
  | CellRefusal;

/** What stopping a session came to: once stopped, the session, ended. */
export type StopAnswer =
  | { kind: 'stopped'; session: CloudSession }
  | { kind: 'not-found' }
  | CellRefusal;

/** What asking for a pass to a session's host came to. */
export type PassAnswer =
  | { kind: 'issued'; pass: CloudSessionPass }
  /** The session is not running, or its host has no address yet. */
  | { kind: 'not-found' }
  /** The cell has no pass key, and so no runner. */
  | { kind: 'no-runner' }
  | CellRefusal;
