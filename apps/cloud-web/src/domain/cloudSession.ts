import type { Refusal } from './refusal';
import type { components, paths } from './apiContract';
import {
  AGENT_RUN_PHASE_WORDS,
  failedWords,
  HARNESS_NAMES,
  NO_REPOSITORY_TITLE,
  NO_REPOSITORY_WORDS,
  SESSION_STATUS_WORDS,
  STARTING_WORDS,
  STOPPED_WORDS,
  UNPUSHED_CHANGES_WARNING,
} from './cloudSessionMessages';
import { safeItemUrl } from './runs';
import type { RunItem } from './runs';
import { SLACK_VIA_WORDS, slackSourceOf } from './runWords';
import type { SlackSource } from './runWords';

/**
 * Cloud sessions as the web app sees them: each a sandbox the workspace's runner runs, with an
 * agent CLI working in one of the runner's repositories. A person's own session is started from
 * the New session form, and only they see it; an agent run is started by an automation of a
 * factory's agent team, when a pull request opens, and every member of the workspace sees it
 * (`origin` names what started it, `agentRun` is the runner's last report of it). They live in
 * the API (`apps/cloud-api/AGENTS.md`, "Cloud sessions"), which decides
 * every status: `starting` goes to `running` or `failed`, and `running` to `stopped` or
 * `failed`, the two ends. A running session's chat connects straight to its sandbox's host, with
 * a short-lived pass the API signs.
 */

type Schemas = components['schemas'];

export type CloudSession = Schemas['CloudSession'];
export type CloudSessionOptions = Schemas['CloudSessionOptions'];
export type CloudSessionPass = Schemas['CloudSessionPass'];
export type CloudSessionStatus = CloudSession['status'];
export type Harness = CloudSession['harness'];
/** A failure the API decided itself, which the page words (never shows as a code). */
export type CellFailureCode = NonNullable<CloudSession['errorCode']>;

/** What started an agent run: an automation of a factory's agent team, on a pull request. */
export type AutomationOrigin = Schemas['CloudSessionOrigin'];
/**
 * What started an agent run a person asked for in Slack, by mentioning a factory's bot
 * (`via: 'mention'`) or messaging it (`dm`): the factory, its orchestrator, and the message
 * (CON-144), whose `title` is its first line, written by a person and shown as text.
 */
export type SlackOrigin = Schemas['SlackSessionOrigin'];
/**
 * What started an agent run: an automation on a pull request, or a message in Slack. Every
 * reader branches on its `kind` (`originFacts`): only an automation's has a pull request.
 */
export type AgentRunOrigin = NonNullable<CloudSession['origin']>;
/** The runner's last report of an agent run. */
export type AgentRunReport = Schemas['AgentRunReport'];
export type AgentRunState = AgentRunReport['state'];
/** An agent the run's first agent (the foreman) dispatched, as the runner last reported it. */
export type DispatchedAgent = NonNullable<AgentRunReport['agents']>[number];
export type DispatchedAgentStatus = DispatchedAgent['status'];

/**
 * An agent run: a session an automation, or a request from Slack, started, which nobody types
 * into.
 */
export type AgentRun = CloudSession & { origin: AgentRunOrigin };

/**
 * Whether a session is an agent run (an automation, or a request from Slack, started it), not a
 * person's own.
 */
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
export function pullRequestLabel(item: AutomationOrigin['item']): string {
  const title = item.title.trim();
  return `${item.repository}#${item.number}${title ? ` ${title}` : ''}`;
}

/** The pull request's address, only when it is an `https:` one: the API passes GitHub's on. */
export function pullRequestUrl(item: AutomationOrigin['item']): string | null {
  return safeItemUrl(item.url);
}

/** The Slack message an agent run came from, only when its permalink is an `https:` one. */
export function slackMessageUrl(origin: SlackOrigin): string | null {
  return safeItemUrl(origin.message.permalink);
}

/**
 * What an agent run's origin says, as its pages show it, read by its `kind`: an automation's run
 * names the automation, its pull request (a link only on `https:`) and the commit it checks out;
 * a request from Slack names how it came (`SLACK_VIA_WORDS`), the message's first line and the
 * message (a link only on `https:`). Both name their factory.
 */
export type OriginFacts =
  | {
      kind: 'automation';
      factory: { id: string; name: string };
      automation: string;
      pullRequest: string;
      url: string | null;
      headSha: string;
      shortSha: string;
    }
  | {
      kind: 'slack';
      factory: { id: string; name: string };
      via: string;
      title: string;
      url: string | null;
    };

export function originFacts(origin: AgentRunOrigin): OriginFacts {
  const factory = { id: origin.factoryId, name: origin.factoryName };
  if (origin.kind === 'slack') {
    return {
      kind: 'slack',
      factory,
      // A way of asking a newer API names is still from Slack.
      via: Object.hasOwn(SLACK_VIA_WORDS, origin.via) ? SLACK_VIA_WORDS[origin.via] : 'From Slack',
      title: origin.message.title,
      url: slackMessageUrl(origin),
    };
  }
  return {
    kind: 'automation',
    factory,
    automation: origin.automation,
    pullRequest: pullRequestLabel(origin.item),
    url: pullRequestUrl(origin.item),
    headSha: origin.item.headSha,
    shortSha: shortSha(origin.item.headSha),
  };
}

/**
 * Slack as the source of a request's conversation, or null for a request that did not come from
 * Slack. Its session's origin says it once the session is read (how it came, and its message);
 * until then, or for a session that names none, the run's own record does (`slackSourceOf`: its
 * `triggerDetail` and its Slack item).
 */
export function conversationSlackSource(
  run: { triggerDetail: string | null; item: RunItem | null },
  session: CloudSession | null,
): SlackSource | null {
  if (session !== null && isAgentRun(session)) {
    const facts = originFacts(session.origin);
    if (facts.kind === 'slack') return { words: facts.via, url: facts.url };
  }
  return slackSourceOf(run);
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
 * Why the API refused to start a session, by its code: no runner connected, a repository or a
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

/**
 * The repository a session works in, as its pages name it: `owner/name`, or "No repository" for
 * an agent run of a factory that names none, which works in an empty folder with no git token.
 */
export function repositoryWords(repository: string | null): string {
  return repository ?? NO_REPOSITORY_WORDS;
}

/** What hovering a session's repository says: which it is, or that it has none, and so pushes nowhere. */
export function repositoryTitle(repository: string | null): string {
  return repository === null ? NO_REPOSITORY_TITLE : `Repository ${repository}`;
}

/**
 * Whether a session's pages name its repository beside what started it: a person's session and a
 * request from Slack do, whether it has one or not; an automation's run on a pull request names
 * it in the pull request already (`pullRequestLabel`).
 */
export function showsRepository(session: Pick<CloudSession, 'origin'>): boolean {
  return session.origin === null || session.origin.kind === 'slack';
}

/** What a session is called: its title, or "Session" and its id's first eight characters. */
export function sessionLabel(session: Pick<CloudSession, 'id' | 'title'>): string {
  const title = session.title?.trim();
  return title ? title : `Session ${session.id.slice(0, 8)}`;
}

/** When a session started, as an ISO time (the API counts epoch seconds). */
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
 * Whether the chat may ask the API for a new pass when its own expires: only while the session
 * runs. A session starting has no host yet, and one ended never will, so no pass is asked for and
 * the chat does not loop reconnecting.
 */
export function shouldRenewPass(status: CloudSessionStatus): boolean {
  return status === 'running';
}

/**
 * Whether a read that came to nothing keeps what the page shows (a session, with its chat; the
 * list), saying when it was read: only while the API is out for a while (`unavailable`), since
 * the next read may work. Signed out, or with another workspace open, the page says so instead
 * and a running chat unmounts, so no one goes on using a session the page can no longer vouch
 * for; and a session the API no longer has is gone.
 */
export function keepsShownOn(answer: { kind: Refusal['kind'] | 'not-found' }): boolean {
  return answer.kind === 'unavailable';
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
export type SessionsAnswer = { kind: 'listed'; sessions: CloudSession[] } | Refusal;

/** What reading one session came to. */
export type SessionAnswer =
  | { kind: 'found'; session: CloudSession }
  /** None, or someone else's: the API says the same of both. */
  | { kind: 'not-found' }
  | Refusal;

/** What asking what a new session can be came to. */
export type OptionsAnswer =
  | { kind: 'offered'; options: CloudSessionOptions }
  | { kind: 'no-runner' }
  | Refusal;

/** What starting a session came to. */
export type StartAnswer =
  | { kind: 'started'; session: CloudSession }
  | { kind: 'refused'; code: StartRefusalCode }
  | Refusal;

/** What stopping a session came to: once stopped, the session, ended. */
export type StopAnswer =
  | { kind: 'stopped'; session: CloudSession }
  | { kind: 'not-found' }
  | Refusal;

/** What asking for a pass to a session's host came to. */
export type PassAnswer =
  | { kind: 'issued'; pass: CloudSessionPass }
  /** The session is not running, or its host has no address yet. */
  | { kind: 'not-found' }
  /** The API has no pass key, and so no runner. */
  | { kind: 'no-runner' }
  | Refusal;
