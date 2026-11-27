import { messageForRefusal } from './refusal';
import type { RunAnswer, RunsAnswer } from './runs';
import { clockTime } from './runWords';

/** What the Runs pages say, for each answer and each empty list. */

/** Why the list could not be shown. */
export function messageForRunsAnswer(answer: Exclude<RunsAnswer, { kind: 'listed' }>): string {
  if (answer.kind === 'invalid') {
    return 'Consola Cloud couldn’t read this list’s filters. Clear them and try again.';
  }
  return messageForRefusal(answer);
}

/** Why a run could not be shown. */
export function messageForRunAnswer(answer: Exclude<RunAnswer, { kind: 'found' }>): string {
  if (answer.kind === 'not-found') {
    return 'This run isn’t here. It may belong to a team you’re not in, or the link may be wrong.';
  }
  return messageForRefusal(answer);
}

/** A list that refreshed and could not: the rows stay as they were read last. */
export function refreshFailedWords(at: string): string {
  return `Couldn’t refresh. These are the runs as of ${clockTime(at)}.`;
}

/** A run's page that refreshed and could not: the run stays as it was read last. */
export function runRefreshFailedWords(at: string): string {
  return `Couldn’t refresh. This is the run as of ${clockTime(at)}.`;
}

/** No run at all yet. */
export const NO_RUNS_TITLE = 'No runs yet';

export function noRunsWords(workspaceName: string): string {
  return `When someone in ${workspaceName} starts a request, or one of its factories’ automations fires in the cloud, the run shows here as it works.`;
}

/** Runs there are, but none the filters let through. */
export const NO_MATCH_TITLE = 'No runs match these filters';
export const NO_MATCH_WORDS = 'Try fewer filters, or clear them to see every run.';

/** A request's conversation, which this build cannot show yet. */
export const CONVERSATION_LATER_TITLE = 'The orchestrator’s conversation shows here';
export const CONVERSATION_LATER_WORDS =
  'Once requests run in Consola Cloud, its replies, the automations it starts and your follow-ups appear under the request, and you can answer it from here.';

/** An agent step's conversation, which this build cannot show yet. */
export const AGENT_CONVERSATION_LATER_WORDS =
  'The agent’s conversation shows here once steps run in Consola Cloud.';

/** A request whose orchestrator asked something, with no way to read or answer it here yet. */
export function questionOpenWords(until: string): string {
  return `The orchestrator asked a question. It waits for an answer until ${clockTime(until)}; the question and your answer will show here once its conversation does.`;
}

/** An automation that started no steps yet. */
export const NO_STEPS_WORDS = 'No steps have started yet.';

/** A request's Automations tab, before its orchestrator started any. */
export const NO_AUTOMATIONS_STARTED = 'The orchestrator hasn’t started any automations yet.';

/** A request that started no automations yet. */
export const NO_CHILDREN_WORDS = 'None started yet.';
