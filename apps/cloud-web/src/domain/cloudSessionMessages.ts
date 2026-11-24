import { messageForCellRefusal } from './cell';
import type {
  CellFailureCode,
  CloudSession,
  CloudSessionStatus,
  Harness,
  PassAnswer,
  SessionAnswer,
  StartAnswer,
  StopAnswer,
} from './cloudSession';
import { clockTime } from './runWords';

/** What the Sessions pages say: the cell answers in codes, and the page words each. */

type Workspace = { name: string; region: string };

/** What the page calls each harness: a harness the cell gains fails the typecheck until named. */
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

/** The cell's `no_runner`: no runner is configured or connected for the workspace. */
export const NO_RUNNER_WORDS = 'No runner is connected for this workspace.';

/** What the New session form says above Start: the one thing starting trusts. */
export const START_NOTE =
  'Starting a session runs this repository’s own settings and hooks inside a sandbox for this session.';

export const STARTING_WORDS = 'Starting the sandbox…';

/** Above a running session's chat: the sandbox is all there is. */
export const UNPUSHED_CHANGES_WARNING =
  'Changes not pushed to a branch are lost when this session stops.';

export const STOPPED_WORDS = 'This session has stopped.';

/** A failure the cell decided itself, by its code. */
const FAILURE_CODE_WORDS: Readonly<Record<CellFailureCode, string>> = {
  runner_restarted: 'The runner restarted.',
  runner_unreachable: 'The runner couldn’t be reached to start this session.',
  runner_failed: 'The runner stopped this session without saying why.',
};

/**
 * Why a session failed: the runner's message as it came, or the sentence for the cell's code. A
 * code this page does not know (a newer cell's) is never shown as text.
 */
export function failedWords(session: Pick<CloudSession, 'error' | 'errorCode'>): string {
  if (session.error) return `This session failed: ${session.error}`;
  const code = session.errorCode;
  if (code && Object.hasOwn(FAILURE_CODE_WORDS, code)) return FAILURE_CODE_WORDS[code];
  return 'This session failed.';
}

/** A session that is not the person's, or not there: the cell says the same of both. */
const NOT_HERE = 'This session isn’t here. It may be someone else’s, or the link may be wrong.';

/** Why a session could not be started, for what was asked. */
export function messageForStartAnswer(
  answer: Exclude<StartAnswer, { kind: 'started' }>,
  asked: { repository: string; harness: Harness },
  workspace: Workspace,
): string {
  if (answer.kind !== 'refused') return messageForCellRefusal(answer, workspace);
  switch (answer.code) {
    case 'no_runner':
      return NO_RUNNER_WORDS;
    case 'repository_not_offered':
      return `This runner does not offer ${asked.repository}.`;
    case 'harness_not_offered':
      return `This runner has no API key for ${HARNESS_NAMES[asked.harness]}.`;
    case 'invalid_request':
      return 'The region couldn’t read this repository or harness. Pick them again.';
  }
}

/** Why a session could not be read. */
export function messageForSessionAnswer(
  answer: Exclude<SessionAnswer, { kind: 'found' }>,
  workspace: Workspace,
): string {
  return answer.kind === 'not-found' ? NOT_HERE : messageForCellRefusal(answer, workspace);
}

/** Why a session could not be stopped. */
export function messageForStopAnswer(
  answer: Exclude<StopAnswer, { kind: 'stopped' }>,
  workspace: Workspace,
): string {
  return answer.kind === 'not-found' ? NOT_HERE : messageForCellRefusal(answer, workspace);
}

/** Why there is no pass to the session's host. */
export function messageForPassAnswer(
  answer: Exclude<PassAnswer, { kind: 'issued' }>,
  workspace: Workspace,
): string {
  if (answer.kind === 'not-found') return 'This session isn’t running any more.';
  if (answer.kind === 'no-runner') return NO_RUNNER_WORDS;
  return messageForCellRefusal(answer, workspace);
}

/** No session yet. */
export const NO_SESSIONS_TITLE = 'No sessions yet';
export const NO_SESSIONS_WORDS =
  'A session runs an agent on one of the runner’s repositories, in a sandbox of its own. Only you see your sessions.';

/** A list that refreshed and could not: the rows stay as they were read last. */
export function sessionsRefreshFailedWords(at: string): string {
  return `Couldn’t refresh. These are your sessions as of ${clockTime(at)}.`;
}

/** A session's page that refreshed and could not: the session stays as it was read last. */
export function sessionRefreshFailedWords(at: string): string {
  return `Couldn’t refresh. This is the session as of ${clockTime(at)}.`;
}
