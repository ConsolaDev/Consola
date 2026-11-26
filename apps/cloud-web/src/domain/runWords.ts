import { isLive } from './runs';
import type {
  Phase,
  RunDetail,
  RunItem,
  RunStatus,
  RunSummary,
  RunTrigger,
  StepStatus,
  StepSummary,
} from './runs';

/**
 * How the Runs pages say a run: its phase on a chip, its status in words and as a look (which
 * icon and colour), how it was started, its item, its times, its cost. The API's words are its
 * own; these are the page's, and a word a newer API sends that this build does not know is still
 * said, never dropped.
 */

/** What each phase's chip says. "Blocked" is a run that waits for someone. */
export const PHASE_LABELS: Record<Phase, string> = {
  active: 'Running',
  completed: 'Complete',
  failed: 'Failed',
  'needs-you': 'Blocked',
  stopped: 'Cancelled',
};

/** What a phase's chip means, said where the chip's name is too short to. */
export const PHASE_HINTS: Record<Phase, string> = {
  active: 'Queued, running, or waiting on the automations it started',
  completed: 'Ended with its work done',
  failed: 'Failed, or ran out of time',
  'needs-you': 'Waiting for someone: an approval, or an answer',
  stopped: 'Cancelled, or an approval said no',
};

const STATUS_WORDS: Record<RunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  'needs-approval': 'Needs approval',
  completed: 'Completed',
  failed: 'Failed',
  rejected: 'Rejected',
  waiting: 'Waiting',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

/** A word the page does not know, said as the API sent it, capitalised. */
function asSent(word: string): string {
  const spaced = word.replaceAll(/[-_]+/g, ' ').trim();
  return spaced === '' ? 'Unknown' : spaced[0].toUpperCase() + spaced.slice(1);
}

function knownWord<Word extends string>(words: Record<Word, string>, word: string): string {
  return Object.hasOwn(words, word) ? words[word as Word] : asSent(word);
}

/**
 * Where a run stands, in words. A waiting run says what it waits on, and a request that waits on
 * someone only because one of its automations does says so.
 */
export function statusWords(
  run: Pick<RunSummary, 'kind' | 'status' | 'phase' | 'waitingOn'>,
): string {
  if (run.status === 'waiting' && run.waitingOn === 'person') return 'Waiting for an answer';
  if (run.status === 'waiting' && run.waitingOn === 'run') {
    return run.kind === 'request' ? 'Waiting on its automations' : 'Waiting on a run';
  }
  if (run.kind === 'request' && run.phase === 'needs-you' && run.status !== 'needs-approval') {
    return 'An automation needs someone';
  }
  return knownWord(STATUS_WORDS, run.status);
}

/**
 * How a run's status is drawn: its icon and colour. `needs-you` and `question` are the only
 * yellow ones, since yellow marks what waits for a person.
 */
export type RunLook =
  | 'queued'
  | 'running'
  | 'needs-you'
  | 'question'
  | 'completed'
  | 'failed'
  | 'stopped';

const LOOK_OF_PHASE: Record<Phase, RunLook> = {
  active: 'running',
  'needs-you': 'needs-you',
  completed: 'completed',
  failed: 'failed',
  stopped: 'stopped',
};

export function lookOf(run: Pick<RunSummary, 'status' | 'phase' | 'waitingOn'>): RunLook {
  switch (run.status) {
    case 'queued':
      return run.phase === 'needs-you' ? 'needs-you' : 'queued';
    case 'needs-approval':
      return 'needs-you';
    case 'waiting':
      if (run.waitingOn === 'person') return 'question';
      return run.phase === 'needs-you' ? 'needs-you' : 'running';
    case 'running':
      return run.phase === 'needs-you' ? 'needs-you' : 'running';
    case 'completed':
      return 'completed';
    case 'failed':
    case 'expired':
      return 'failed';
    case 'cancelled':
    case 'rejected':
      return 'stopped';
    default:
      // A status this build does not know: its phase still says how it is doing.
      return Object.hasOwn(LOOK_OF_PHASE, run.phase) ? LOOK_OF_PHASE[run.phase] : 'stopped';
  }
}

const STEP_WORDS: Record<StepStatus, string> = {
  pending: 'Not started',
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  skipped: 'Skipped',
  reported: 'Reported',
  'not-run': 'Not run',
  waiting: 'Waiting',
};

export function stepStatusWords(status: StepSummary['status']): string {
  return knownWord(STEP_WORDS, status);
}

export function stepLook(status: StepSummary['status']): RunLook {
  switch (status) {
    case 'running':
    case 'waiting':
      return 'running';
    case 'completed':
    case 'reported':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'skipped':
    case 'not-run':
      return 'stopped';
    default:
      return 'queued';
  }
}

/** What a step is, beside its id: the agent it runs, or a command. */
export function stepKindWords(step: Pick<StepSummary, 'kind' | 'agent'>): string {
  if (step.kind === 'agent') return step.agent ? `Agent ${step.agent}` : 'Agent';
  if (step.kind === 'run') return 'Command';
  if (step.kind === 'orchestrator') return 'Orchestrator';
  return asSent(step.kind);
}

/** Each way a run is started, as the Filter menu names it. */
export const TRIGGER_LABELS: Record<RunTrigger, string> = {
  manual: 'By a person',
  cron: 'Schedule',
  event: 'Event',
  poll: 'Poll',
};

export function triggerWords(trigger: RunTrigger): string {
  return knownWord(TRIGGER_LABELS, trigger);
}

/**
 * A pull request or an issue as a chip names it: its repository's name and number
 * (`consola #96`), or, for an item with neither, its title.
 */
export function itemLabel(item: RunItem): string {
  const repo = item.repo?.split('/').at(-1) ?? null;
  if (item.number !== null) return repo ? `${repo} #${item.number}` : `#${item.number}`;
  return item.title;
}

/** What an item is, as a sentence names it. */
export function itemNoun(item: Pick<RunItem, 'kind'>): string {
  if (item.kind === 'pr') return 'pull request';
  if (item.kind === 'issue') return 'issue';
  return 'item';
}

/** Where a run ran, in words: the cloud by its name, any other runner as the API names it. */
export function runnerWords(runner: string): string {
  return runner === 'cloud' ? 'Consola Cloud' : asSent(runner);
}

/** A factory's version, and, when the run used an older one, that it did. */
export function versionWords(version: number, latest: number | null): string {
  return latest !== null && latest > version
    ? `v${version}, v${latest} is the latest`
    : `v${version}`;
}

/** `1 automation`, `3 automations`. */
export function counted(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** A request's automations, in a few words: how many, and those that need a look. */
export function childrenWords(children: NonNullable<RunSummary['children']>): string {
  const parts = [counted(children.total, 'automation')];
  if (children.needsYou > 0) parts.push(`${children.needsYou} blocked`);
  if (children.failed > 0) parts.push(`${children.failed} failed`);
  if (children.active > 0) parts.push(`${children.active} running`);
  return parts.join(', ');
}

/** How the badge of a request's count is drawn: by the automation that most needs a look. */
export function childrenTone(
  children: NonNullable<RunSummary['children']>,
): 'needs-you' | 'failed' | 'running' | 'quiet' {
  if (children.needsYou > 0) return 'needs-you';
  if (children.failed > 0) return 'failed';
  if (children.active > 0) return 'running';
  return 'quiet';
}

/** Where an automation run is in its steps: `Step 2 of 4: review`, or `4 of 4 steps` once done. */
export function progressWords(progress: NonNullable<RunSummary['progress']>): string {
  if (progress.current !== null) {
    const at = Math.min(progress.done + 1, progress.total);
    return `Step ${at} of ${progress.total}: ${progress.current}`;
  }
  return `${progress.done} of ${counted(progress.total, 'step')}`;
}

/** A length of time as a run's duration says it: `<1s`, `42s`, `3m 5s`, `1h 04m` (the desktop's). */
export function durationInWords(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds === 0) return '<1s';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** How long a run (or a step) worked: from its start to its end, or to now. Null before it starts. */
export function workedFor(
  run: { startedAt: string | null; finishedAt: string | null },
  now: number,
): number | null {
  if (run.startedAt === null) return null;
  const start = Date.parse(run.startedAt);
  const end = run.finishedAt === null ? now : Date.parse(run.finishedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

/** How long ago, as a list says it: `just now`, `5m ago`, `3h ago`, `2d ago`, then the date. */
export function agoInWords(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** A time of day, as a deadline says it (`14:30`). */
export function clockTime(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** A moment in full, for a title a pointer brings up. */
export function fullTime(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  return new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Dollars, to the cent, as the CLI estimates them; a cost below a cent says so. */
export function costInWords(usd: number | null): string | null {
  if (usd === null || !Number.isFinite(usd)) return null;
  if (usd > 0 && usd < 0.01) return '<$0.01';
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** How much of a budget is spent, from 0 to 1, for its meter. */
export function shareOf(spent: number, budget: number): number {
  if (!(budget > 0)) return spent > 0 ? 1 : 0;
  return Math.min(1, Math.max(0, spent / budget));
}

/** A request's open question: the API holds when it was asked and its deadline, not its words. */
export function questionWords(
  question: NonNullable<NonNullable<RunDetail['request']>['question']>,
  now: number,
): string {
  return `Asked ${agoInWords(question.at, now)}, open until ${clockTime(question.until)}`;
}

/**
 * Where an automation a request started is, in a line: the step it is on (`Step 2 of 4 ·
 * report`), what it waits for, or how it ended (its error or summary, else its status).
 */
export function childStateWords(run: RunSummary): string {
  if (isLive(run)) {
    if (run.phase === 'active' && run.progress && run.progress.current !== null) {
      const at = Math.min(run.progress.done + 1, run.progress.total);
      return `Step ${at} of ${run.progress.total} · ${run.progress.current}`;
    }
    return statusWords(run);
  }
  const ended = (run.error ?? run.summary)?.split('\n').find((line) => line.trim() !== '');
  return ended?.trim() ?? statusWords(run);
}

/** When an automation started, how long it worked and what it cost: `5m ago · 1m 2s · $0.12`. */
export function childFactsWords(run: RunSummary, now: number): string {
  const worked = workedFor(run, now);
  const cost = costInWords(run.costUsd);
  return [
    agoInWords(run.startedAt ?? run.createdAt, now),
    worked !== null ? durationInWords(worked) : null,
    cost,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
}
