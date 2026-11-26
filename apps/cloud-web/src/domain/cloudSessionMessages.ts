import { messageForRefusal } from './refusal';
import type {
  AgentRunPhase,
  CellFailureCode,
  CloudSession,
  CloudSessionStatus,
  DispatchedAgentStatus,
  Harness,
  PassAnswer,
  SessionAnswer,
  StartAnswer,
  StopAnswer,
} from './cloudSession';
import { clockTime } from './runWords';

/** What the Sessions pages say: the API answers in codes, and the page words each. */

/** What the page calls each harness: a harness the API gains fails the typecheck until named. */
export const HARNESS_NAMES: Readonly<Record<Harness, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

/** How a status is said, in a row and on a session's page. */
export const SESSION_STATUS_WORDS: Readonly<Record<CloudSessionStatus, string>> = {
  starting: 'Starting',
  running: 'Running',
  stopped: 'Stopped',
  failed: 'Failed',
};

/** The API's `no_runner`: no runner is configured or connected for the workspace. */
export const NO_RUNNER_WORDS = 'No runner is connected for this workspace.';

/** A runner connected, with no repository or no harness to offer. */
export const NOTHING_OFFERED_WORDS =
  'This workspace’s runner offers no repository or harness to start a session with.';

/** What the New session form says above Start: the one thing starting trusts. */
export const START_NOTE =
  'Starting a session runs this repository’s own settings and hooks inside a sandbox for this session.';

export const STARTING_WORDS = 'Starting the sandbox…';

/** Above a running session's chat: the sandbox is all there is. */
export const UNPUSHED_CHANGES_WARNING =
  'Changes not pushed to a branch are lost when this session stops.';

export const STOPPED_WORDS = 'This session has stopped.';

/** A running session whose chat is on its way: a pass asked for, or the chat's code loading. */
export const CONNECTING_WORDS = 'Connecting to the session…';

/** The chat's code did not arrive (a new version of the app was deployed meanwhile, say). */
export const CHAT_NOT_LOADED_WORDS = 'The chat couldn’t be loaded. Reload the page to try again.';

type Failed = Pick<CloudSession, 'error' | 'errorCode' | 'repository' | 'harness'>;

/**
 * A failure the API decided itself, by its code. The last four are an agent run's that the API
 * could not hand to a runner when the pull request's event arrived: it was recorded failed, and
 * nothing ran.
 */
const FAILURE_CODE_WORDS: Readonly<Record<CellFailureCode, (session: Failed) => string>> = {
  runner_restarted: () => 'The runner restarted.',
  runner_unreachable: () => 'The runner couldn’t be reached to start this session.',
  runner_failed: () => 'The runner stopped this session without saying why.',
  runner_unavailable: () =>
    'No runner was connected when the pull request’s event arrived, so this run never started.',
  repository_not_offered: ({ repository }) =>
    `The connected runner doesn’t offer ${repository}, so this run never started.`,
  harness_not_offered: ({ harness }) =>
    `The connected runner has no API key for ${HARNESS_NAMES[harness] ?? harness}, so this run never started.`,
  agent_run_invalid: () =>
    'Consola Cloud couldn’t put this run together from the factory’s files, so it never started.',
};

/**
 * Why a session failed: the runner's message as it came, or the sentence for the API's code. A
 * code this page does not know (a newer API's) is never shown as text.
 */
export function failedWords(session: Failed): string {
  if (session.error) return `This session failed: ${session.error}`;
  const code = session.errorCode;
  if (code && Object.hasOwn(FAILURE_CODE_WORDS, code)) return FAILURE_CODE_WORDS[code](session);
  return 'This session failed.';
}

/** How an agent run's phase is said (`agentRunPhase`), in a row and on its page. */
export const AGENT_RUN_PHASE_WORDS: Readonly<Record<AgentRunPhase, string>> = {
  starting: 'Starting',
  working: 'Working',
  waiting: 'Waiting on a question',
  done: 'Finished',
  failed: 'Failed',
  stopped: 'Stopped before it finished',
};

/** How a dispatched agent's status is said. */
export const DISPATCHED_STATUS_WORDS: Readonly<Record<DispatchedAgentStatus, string>> = {
  working: 'Working',
  done: 'Done',
  failed: 'Failed',
};

/** What marks an agent run in the list, beside its automation's name. */
export const AGENT_RUN_LABEL = 'Agent run';

/** An agent run that has reported no result yet, by where it stands. */
export function noSummaryWords(phase: AgentRunPhase, agent: string): string {
  switch (phase) {
    case 'starting':
      return `${agent} starts once the sandbox is ready.`;
    case 'working':
    case 'waiting':
      return `${agent} hasn’t reported a result yet.`;
    default:
      return `${agent} reported no result.`;
  }
}

/** An agent run that has dispatched no agent, by where it stands. */
export function noAgentsWords(phase: AgentRunPhase, agent: string): string {
  return phase === 'starting' || phase === 'working' || phase === 'waiting'
    ? `${agent} hasn’t dispatched an agent yet.`
    : `${agent} dispatched no agent.`;
}

/** A dispatched agent that has sent no report. */
export const NO_AGENT_REPORT = 'No report yet.';

/** How many agents the run dispatched, as the section's head counts them. */
export function dispatchedCount(count: number): string {
  return count === 1 ? '1 agent' : `${count} agents`;
}

/**
 * A session that is not the person’s, or not there: the API says the same of both. (An agent
 * run is every member’s, so for one this is a run that is gone or a wrong link.)
 */
const NOT_HERE = 'This session isn’t here. It may be someone else’s, or the link may be wrong.';

/** Why a session could not be started, for what was asked. */
export function messageForStartAnswer(
  answer: Exclude<StartAnswer, { kind: 'started' }>,
  asked: { repository: string; harness: Harness },
): string {
  if (answer.kind !== 'refused') return messageForRefusal(answer);
  switch (answer.code) {
    case 'no_runner':
      return NO_RUNNER_WORDS;
    case 'repository_not_offered':
      return `This runner does not offer ${asked.repository}.`;
    case 'harness_not_offered':
      return `This runner has no API key for ${HARNESS_NAMES[asked.harness]}.`;
    case 'invalid_request':
      return 'Consola Cloud couldn’t read this repository or harness. Pick them again.';
  }
}

/** Why a session could not be read. */
export function messageForSessionAnswer(answer: Exclude<SessionAnswer, { kind: 'found' }>): string {
  return answer.kind === 'not-found' ? NOT_HERE : messageForRefusal(answer);
}

/** Why a session could not be stopped. */
export function messageForStopAnswer(answer: Exclude<StopAnswer, { kind: 'stopped' }>): string {
  return answer.kind === 'not-found' ? NOT_HERE : messageForRefusal(answer);
}

/** Why there is no pass to the session's host. */
export function messageForPassAnswer(answer: Exclude<PassAnswer, { kind: 'issued' }>): string {
  if (answer.kind === 'not-found') return 'This session isn’t running any more.';
  if (answer.kind === 'no-runner') return NO_RUNNER_WORDS;
  return messageForRefusal(answer);
}

/** No session yet. */
export const NO_SESSIONS_TITLE = 'No sessions yet';
export const NO_SESSIONS_WORDS =
  'A session runs an agent on one of the runner’s repositories, in a sandbox of its own. Only you see your sessions; agent runs a factory starts on a pull request show here for everyone.';

/** A list that refreshed and could not: the rows stay as they were read last. */
export function sessionsRefreshFailedWords(at: string): string {
  return `Couldn’t refresh. These are the sessions as of ${clockTime(at)}.`;
}

/** A session's page that refreshed and could not: the session stays as it was read last. */
export function sessionRefreshFailedWords(at: string): string {
  return `Couldn’t refresh. This is the session as of ${clockTime(at)}.`;
}
