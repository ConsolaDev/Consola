import {
  isAgentRunPreview,
  type AutomationMode,
  type AutomationView,
  type AutomationsSnapshot,
  type FactoryNotice,
  type FactorySpecIssue,
  type ItemTarget,
  type ItemTargetRow,
  type ItemTargets,
  type RunListEntry,
  type RunRecord,
} from '../../../shared/automations';
import type { ConversationEntry } from '../../../shared/conversation';

/** What a run says about itself: a full record and a list entry both have it. */
export type RunFacts = Omit<RunRecord, 'result' | 'approval'>;

const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_DAYS = 30;

/** An automation's name; for an agent's request, what it asks to do ("Delete session"). */
export function runTitle(run: RunFacts): string {
  if (run.source !== 'manual') return run.automationId;
  const words = run.actionName.replace(/^consola#/, '').replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const STATUS_WORDS: Record<RunFacts['status'], string> = {
  queued: 'queued',
  running: 'running',
  'needs-approval': 'waiting',
  waiting: 'on hold',
  completed: 'completed',
  failed: 'failed',
  rejected: 'dismissed',
};

/** Where a run stands, in one word: "waiting" for a person, "dismissed" when they turned it down. */
export function statusWord(status: RunFacts['status']): string {
  return STATUS_WORDS[status];
}

/**
 * What `rejectedAtGate` reads: a record's steps, or a list entry's `step`,
 * which has no records; and whether the run started.
 */
export type RejectedFacts = Pick<RunFacts, 'status' | 'steps' | 'startedAt'> & {
  step?: RunListEntry['step'];
};

/**
 * The gate a person rejected a run at, when they did: from its records (the
 * gate row whose answer is `reject`), or for a list entry its `step`, which
 * names the gate a rejected run ended at (`gate`). Undefined for any other
 * run, a `rejected` one turned down before it started included.
 */
export function rejectedAtGate(run: RejectedFacts): string | undefined {
  if (run.status !== 'rejected') return undefined;
  const row = run.steps?.find((step) => step.gate?.decision === 'reject');
  if (row) return row.id;
  return run.step?.gate ? run.step.id : undefined;
}

/**
 * Whether a `rejected` run started first: a person rejected it at a gate, or
 * it was turned away after it started (its entry's retry started it again,
 * and a review had been started by hand meanwhile, 3-A code review M6). A
 * run turned down before it started has no `startedAt`.
 */
export function rejectedAfterStart(run: RejectedFacts): boolean {
  return (
    run.status === 'rejected' && (rejectedAtGate(run) !== undefined || run.startedAt !== undefined)
  );
}

/**
 * Whether a run worked, so its row gives how long: it completed, failed or
 * runs, or was rejected after it started (3-A code review M5: a run a
 * person rejected at a gate ran first).
 */
export function runWorked(run: RejectedFacts): boolean {
  return (
    run.status === 'completed' ||
    run.status === 'failed' ||
    run.status === 'running' ||
    rejectedAfterStart(run)
  );
}

/**
 * A run's status in one word, as `statusWord` says it, but a run rejected
 * after it started is `rejected`: it ran, then a person said no at a gate,
 * or it was turned away, which is not a run turned down before it started
 * (`dismissed`).
 */
export function runStatusWord(run: RejectedFacts): string {
  return rejectedAfterStart(run) ? 'rejected' : statusWord(run.status);
}

/** A run's status as a label, as `statusLabel` says it, but `Rejected` for a run rejected after it started. */
export function runStatusLabel(run: RejectedFacts): string {
  return rejectedAfterStart(run) ? 'Rejected' : statusLabel(run.status);
}

/** A time of day, as the run list says one: `10:42`, in the person's own clock. */
export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** What an automation does when it fires, in words. */
export function modeInWords(
  mode: AutomationMode,
  asksFirst = false,
  source: AutomationView['source'] = 'cron',
  needsAllow = false,
): string {
  // A poll entry is accepted by Allow, never by approving a run.
  if (source === 'poll' && needsAllow) {
    if (mode === 'confirm') return 'Asks you before each run, once you allow it';
    if (mode === 'notify') return 'Runs dry runs once you allow it';
    return 'Runs on its own once you allow it';
  }
  if (source === 'poll') asksFirst = false;
  if (mode === 'confirm') return 'Asks you before each run';
  if (mode === 'notify') return 'Tells you what it would do, and starts nothing';
  return asksFirst
    ? 'Runs on its own once you approve a run no agent asked for'
    : 'Runs on its own';
}

/** What a run ran: an agent run's "Review action" or "Prompt", else its tool. */
export function ranInWords(run: RunRecord): string {
  if (isAgentRunPreview(run.result)) return run.result.runs;
  return `Tool: ${run.actionName.split('#').pop()}`;
}

/**
 * What the side panel shows of a run below its facts. An agent run has a
 * conversation only once a session ran it; one dismissed, only reported
 * (notify), or that could not start never had one.
 */
export type RunStage =
  | 'agent-waiting'
  | 'agent-queued'
  | 'agent-running'
  | 'agent-finished'
  | 'agent-unstarted'
  | 'tool';

export function runStage(run: RunRecord): RunStage {
  if (!isAgentRunPreview(run.result)) return 'tool';
  if (run.status === 'needs-approval') return 'agent-waiting';
  if (run.status === 'queued') return 'agent-queued';
  if (run.status === 'running') return 'agent-running';
  return run.conversation || run.sessionId ? 'agent-finished' : 'agent-unstarted';
}

export function triggerLabel(run: RunFacts): string {
  if (run.trigger.kind === 'cron') return run.trigger.catchUp ? 'catch-up' : 'scheduled';
  if (run.trigger.kind === 'event') return 'event';
  if (run.trigger.kind === 'poll') return 'check';
  return run.trigger.by === 'agent' ? 'asked by an agent' : 'run now';
}

/**
 * What fired a run, as a run list's second line says it, the way GitHub
 * Actions writes "Scheduled" or "Manually run": a sentence fragment, where
 * `triggerLabel` is a column's word.
 */
export function triggerInWords(run: RunFacts): string {
  if (run.trigger.kind === 'cron') return run.trigger.catchUp ? 'Scheduled, run late' : 'Scheduled';
  if (run.trigger.kind === 'event') return 'Inbox event';
  if (run.trigger.kind === 'poll') return 'Found by its check';
  return run.trigger.by === 'agent' ? 'Asked for by an agent' : 'Run by you';
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** How long a run worked: from when it started (not when it queued) to when it finished, or to now. */
export function formatDuration(run: RunFacts, now: Date): string | null {
  const start = Date.parse(run.startedAt ?? run.createdAt);
  const end = run.finishedAt ? Date.parse(run.finishedAt) : now.getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return formatElapsed(end - start);
}

/**
 * A length of time as a run's duration says it: "<1s", "42s", "3m 5s",
 * "1h 04m". A tool run is often over within the second, and "0s" would
 * read as though it never ran.
 */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds === 0) return '<1s';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * What a run was about: the item it ran on (an event's, a check's, or one a
 * person picked); for a failure, the
 * first line of why it failed; else its summary, else where it stands.
 */
export function runAbout(run: RunFacts): string {
  if (run.trigger.item?.title) return run.trigger.item.title;
  if (run.status === 'failed') {
    const why = run.error
      ?.split('\n')
      .find((line) => line.trim())
      ?.trim();
    if (why) return why;
  }
  return run.summary || run.status;
}

/**
 * The summary the engine gives a run held for another run's checkout of the
 * same item: its `WAITING_FOR_CHECKOUT`, which `stepWords.parity.test.ts`
 * keeps this equal to.
 */
export const CHECKOUT_WAIT = "waiting for this item's checkout";

/**
 * Where a `steps:` run is, in the words a row shows in place of `runAbout`:
 * "waiting for you at decide" at a gate, "retrying fix at 10:42" out a
 * step's retry, "retrying the run at 10:42" out the entry's (it waits at no
 * step, and may wait before any ran), "round 2 of 3 · review" inside a
 * loop, "running · publish", "waiting for a slot before publish", "failed at publish" ("failed before
 * publish" when it failed between steps, and the engine names the step it
 * did not reach), that it waits for its item's checkout (for another
 * run's gate, `waitingForWords`), or "waiting for you to close fix" while a
 * person's session in its own checkout holds it (slice 3-B; the entry names
 * the session). Null when there is nothing step-shaped to
 * say (a legacy run, a run that finished), so the row keeps `runAbout`.
 */
export function stepWords(run: RunListEntry): string | null {
  // A person's session in the run's own checkout holds it (slice 3-B): that is what it waits on.
  if (run.waitingFor?.session !== undefined)
    return `waiting for you to close ${run.waitingFor.session}`;
  if (run.status === 'queued' && run.summary === CHECKOUT_WAIT)
    return waitingForWords(run) ?? CHECKOUT_WAIT;
  if (run.status === 'waiting' && run.retryAt !== undefined && run.step?.status !== 'waiting')
    return `retrying the run at ${clockTime(run.retryAt)}`;
  const step = run.step;
  if (!step) return null;
  if (run.status === 'waiting' && step.gate) return `waiting for you at ${step.id}`;
  if (run.status === 'waiting' && step.retryAt !== undefined)
    return `retrying ${step.id} at ${clockTime(step.retryAt)}`;
  if (
    run.status === 'running' &&
    step.status === 'running' &&
    step.loop !== undefined &&
    step.round !== undefined &&
    step.max !== undefined
  )
    return `round ${step.round} of ${step.max} · ${step.id}`;
  if (run.status === 'running' && step.status === 'running') return `running · ${step.id}`;
  if (run.status === 'running' && step.status === 'queued')
    return `waiting for a slot before ${step.id}`;
  if (run.status === 'failed')
    return step.status === 'not-run' ? `failed before ${step.id}` : `failed at ${step.id}`;
  return null;
}

/**
 * What a sidebar row's run waits for (it has a row because it wants the
 * person, `runAttention`): the person at a gate, a loop's exhaustion gate
 * included, or their approval of its start. Answering a gate is not
 * approving a run (3-A code review M2).
 */
export function sidebarRunWaits(run: Pick<RunListEntry, 'status' | 'step'>): string {
  return run.status === 'waiting' && run.step?.gate
    ? `waiting for you at ${run.step.id}`
    : 'waiting for your approval';
}

/**
 * What a run held by another run's gate waits for (it waits for its item's
 * checkout, which that run holds while it waits for the person): "waiting
 * for you at `decide` in `review-assigned-prs-gated`". Null for any other.
 */
export function waitingForWords(run: Pick<RunListEntry, 'waitingFor'>): string | null {
  const gate = run.waitingFor?.gate;
  return gate ? `waiting for you at \`${gate.step}\` in \`${gate.automation}\`` : null;
}

/** Whether a run waits for the person at a gate: a list entry's `step` says so, or a record's waiting gate row. */
function isWaitingAtGate(run: RunFacts & { step?: RunListEntry['step'] }): boolean {
  return (
    run.status === 'waiting' &&
    (run.step?.gate === true ||
      (run.steps ?? []).some((step) => step.status === 'waiting' && step.gate !== undefined))
  );
}

/** The runs Activity's first group shows: waiting for the person at a gate, oldest first. */
export function waitingForYouRuns(runs: readonly RunListEntry[]): RunListEntry[] {
  return runs
    .filter((run) => isWaitingAtGate(run))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/**
 * The run an automation's page asks the person about: one waiting for their
 * approval, else the oldest waiting for them at a gate. A run waiting out a
 * retry asks no one (3-A code review M3).
 */
export function runWaitingForYou(runs: readonly RunListEntry[]): RunListEntry | undefined {
  return runs.find((run) => run.status === 'needs-approval') ?? waitingForYouRuns(runs)[0];
}

export type RunFilter = 'all' | 'agent' | 'tool' | 'failed';

/** What narrows the run list: free text, a kind, and one automation. */
export interface RunListFilter {
  query: string;
  kind: RunFilter;
  /** A run's `automationId`: an entry's name, or an agent request's tool reference. Null for every one. */
  automation: string | null;
}

export const NO_RUN_FILTER: RunListFilter = { query: '', kind: 'all', automation: null };

export function isRunFilterNarrowed(filter: RunListFilter): boolean {
  return filter.query.trim() !== '' || filter.kind !== 'all' || filter.automation !== null;
}

/**
 * How many runs each kind would list with the rest of the filter as it is,
 * so the kind buttons can say so ("Failed 2") before they are pressed.
 */
export function runKindCounts(
  runs: RunListEntry[],
  filter: RunListFilter,
  now: Date,
): Record<RunFilter, number> {
  const count = (kind: RunFilter) => filterRuns(runs, { ...filter, kind }, now).length;
  return { all: count('all'), agent: count('agent'), tool: count('tool'), failed: count('failed') };
}

/**
 * The counts the run list shows while it is neither narrowed nor paged: the
 * total, and each kind's. They come from the snapshot, which holds every live
 * run but only the newest ended ones, so while it leaves older runs out
 * (`hasOlder`) each is a floor and reads "N+".
 */
export function snapshotRunCounts(
  snapshot: Pick<AutomationsSnapshot, 'runs' | 'hasOlder'>,
  filter: RunListFilter,
  now: Date,
): { all: string; kinds: Record<RunFilter, string> } {
  const said = (count: number) => `${count}${snapshot.hasOlder ? '+' : ''}`;
  const kinds = runKindCounts(snapshot.runs, filter, now);
  return {
    all: said(filterRuns(snapshot.runs, NO_RUN_FILTER, now).length),
    kinds: {
      all: said(kinds.all),
      agent: said(kinds.agent),
      tool: said(kinds.tool),
      failed: said(kinds.failed),
    },
  };
}

/** A local calendar day of a run list, as its heading says it, with its runs in the list's order. */
export interface RunDayGroup<T extends RunFacts = RunFacts> {
  key: string;
  label: string;
  runs: T[];
}

/**
 * A run list (newest first) split by the local day each run started:
 * "Today", "Yesterday", the weekday and date within the week, else the
 * date. Each row then needs only its time of day.
 */
export function groupRunsByDay<T extends RunFacts>(runs: T[], now: Date): Array<RunDayGroup<T>> {
  const groups: Array<RunDayGroup<T>> = [];
  for (const run of runs) {
    const at = new Date(run.createdAt);
    const key = Number.isNaN(at.getTime())
      ? 'unknown'
      : `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`;
    const last = groups[groups.length - 1];
    if (last?.key === key) last.runs.push(run);
    else groups.push({ key, label: dayLabel(at, now), runs: [run] });
  }
  return groups;
}

function dayLabel(at: Date, now: Date): string {
  if (Number.isNaN(at.getTime())) return 'Unknown day';
  const days = calendarDaysBefore(at, now);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const date = at.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
  if (days > 1 && days < 7)
    return `${at.toLocaleDateString(undefined, { weekday: 'long' })}, ${date}`;
  return date;
}

/**
 * Waiting for a person or a slot, parked at a gate or a retry, or working:
 * history never drops these, so neither does the list.
 */
const LIVE_STATUSES: ReadonlySet<RunFacts['status']> = new Set([
  'needs-approval',
  'waiting',
  'queued',
  'running',
]);

/**
 * The runs history keeps, newest first, narrowed by a filter. The same rule
 * as retention (`RunStore`): a run that ended in the last 30 days, by when
 * it ended, and every live run however old.
 */
export function filterRuns(runs: RunListEntry[], filter: RunListFilter, now: Date): RunListEntry[] {
  const cutoff = now.getTime() - HISTORY_DAYS * DAY_MS;
  const needle = filter.query.trim().toLowerCase();
  return runs
    .filter((run) => {
      if (LIVE_STATUSES.has(run.status)) return true;
      const ended = endedAt(run);
      return Number.isNaN(ended) || ended >= cutoff;
    })
    .filter((run) => filter.automation === null || run.automationId === filter.automation)
    .filter((run) => {
      if (filter.kind === 'agent') return run.kind === 'agent';
      if (filter.kind === 'tool') return run.kind === 'tool' || run.kind === 'request';
      if (filter.kind === 'failed') return run.status === 'failed';
      return true;
    })
    .filter((run) => {
      if (!needle) return true;
      return [run.automationId, run.trigger.item?.title, run.summary].some((text) =>
        text?.toLowerCase().includes(needle),
      );
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** Newest first by `createdAt`, ties by id descending: the engine's `newestFirst`, so both sides order one way. */
export function newestRunFirst(
  a: { createdAt: string; id: string },
  b: { createdAt: string; id: string },
): number {
  return (
    Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
  );
}

/**
 * Pages of runs laid together, newest first: `first` wins for a run in both,
 * so the live snapshot's copy of a run is never replaced by an older fetch.
 */
export function mergeRunPages(first: RunListEntry[], ...rest: RunListEntry[][]): RunListEntry[] {
  const seen = new Set<string>();
  const merged: RunListEntry[] = [];
  for (const run of [first, ...rest].flat()) {
    if (seen.has(run.id)) continue;
    seen.add(run.id);
    merged.push(run);
  }
  return merged.sort(newestRunFirst);
}

/**
 * The snapshot holds every live run and the newest 200 ended ones, so each
 * push can move its edge: a run that ends pushes the 200th out. The ended
 * runs the previous snapshot held and this one dropped go into `older`, so
 * no run falls between the snapshot and the pages loaded below it.
 */
export function foldDroppedRuns(
  previous: RunListEntry[],
  next: RunListEntry[],
  older: RunListEntry[],
): RunListEntry[] {
  const held = new Set(next.map((run) => run.id));
  const dropped = previous.filter((run) => !LIVE_STATUSES.has(run.status) && !held.has(run.id));
  return dropped.length === 0 ? older : mergeRunPages(older, dropped);
}

/**
 * A row's words: its title, and where a steps run is beside it. A run on an
 * item keeps its item's title; any other steps run says its step as its title.
 */
export function runRowWords(run: RunListEntry): { about: string; step: string | null } {
  const step = stepWords(run);
  if (step && !run.trigger.item?.title) return { about: step, step: null };
  return { about: runAbout(run), step };
}

/**
 * Where "Show older runs" continues from: the oldest run that has ended. Never
 * the last row, which may be an old live run: continuing after it would skip
 * ended runs (`ListRunsQuery.before`).
 */
export function olderRunsCursor(runs: RunListEntry[]): string | undefined {
  for (let i = runs.length - 1; i >= 0; i--) {
    if (!LIVE_STATUSES.has(runs[i].status)) return runs[i].id;
  }
  return undefined;
}

/** One automation the run list can narrow to, as its rows name it, with how many runs it has there. */
export interface RunAutomationOption {
  id: string;
  label: string;
  count: number;
  /** An entry in factory.yml now; else an entry since removed, or an agent's request. */
  inFile: boolean;
}

/**
 * What the run list can be narrowed to: factory.yml's entries in the file's
 * order, then anything else with runs in `history` — an entry since removed,
 * or an agent's request ("Delete session"). The one already chosen stays
 * listed even with neither, so the menu still shows what is ticked.
 */
export function runAutomationOptions(
  snapshot: AutomationsSnapshot,
  history: RunListEntry[],
  chosen: string | null,
): RunAutomationOption[] {
  const counts = new Map<string, number>();
  for (const run of history) counts.set(run.automationId, (counts.get(run.automationId) ?? 0) + 1);
  const options: RunAutomationOption[] = snapshot.automations.map((automation) => ({
    id: automation.name,
    label: automation.name,
    count: counts.get(automation.name) ?? 0,
    inFile: true,
  }));
  const listed = new Set(options.map((option) => option.id));
  for (const run of history) {
    if (listed.has(run.automationId)) continue;
    listed.add(run.automationId);
    options.push({
      id: run.automationId,
      label: runTitle(run),
      count: counts.get(run.automationId) ?? 0,
      inFile: false,
    });
  }
  if (chosen !== null && !listed.has(chosen))
    options.push({ id: chosen, label: chosen, count: 0, inFile: false });
  return options;
}

/** Midnight-to-midnight days from `at` to `now`, in local time; DST days still count as one. */
function calendarDaysBefore(at: Date, now: Date): number {
  const midnight = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  return Math.round((midnight(now) - midnight(at)) / DAY_MS);
}

/**
 * When a run started, as short as a list row can say it: the time alone
 * today, "Yesterday" or the weekday within the week, else the date. The
 * full `formatTime` goes in the row's tooltip.
 */
export function formatRunWhen(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const days = calendarDaysBefore(at, now);
  if (days === 0) return time;
  if (days === 1) return `Yesterday, ${time}`;
  if (days > 1 && days < 7)
    return `${at.toLocaleDateString(undefined, { weekday: 'short' })}, ${time}`;
  const date = at.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
  return `${date}, ${time}`;
}

/**
 * How long ago, as a row's second line says it: "just now", "14m ago",
 * "3h ago", "2d ago", and the date from a week back.
 */
export function formatAgo(iso: string, now: Date): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const minutes = Math.floor((now.getTime() - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return formatRunWhen(iso, now).split(',')[0];
}

/**
 * How long until an automation is due, counted down: "in 14m", "in 3h 12m",
 * "in 2d 4h"; "due now" once it is. Minutes round up, so it never says
 * "in 0m" while there is still time.
 */
export function formatCountdown(iso: string, now: Date): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const totalMinutes = Math.ceil((at - now.getTime()) / 60_000);
  if (totalMinutes <= 0) return 'due now';
  if (totalMinutes < 60) return `in ${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  if (hours < 24)
    return totalMinutes % 60 === 0 ? `in ${hours}h` : `in ${hours}h ${totalMinutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `in ${days}d` : `in ${days}d ${hours % 24}h`;
}

/**
 * When an automation is next due, by the calendar: the time alone today,
 * "Tomorrow" or the weekday within the week, else the date. The countdown
 * says how soon; this says when.
 */
export function formatDueAt(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const days = -calendarDaysBefore(at, now);
  if (days <= 0) return time;
  if (days === 1) return `Tomorrow, ${time}`;
  if (days < 7) return `${at.toLocaleDateString(undefined, { weekday: 'short' })}, ${time}`;
  const date = at.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
  return `${date}, ${time}`;
}

/** How many of its runs an automation's row draws. */
export const RECENT_RUNS = 12;

/**
 * An automation's latest runs, oldest first, as its row draws them left to
 * right. The same runs Activity lists for it, so the strip and "Open in
 * Activity" never disagree.
 */
export function recentRuns(
  runs: RunListEntry[],
  automation: string,
  now: Date,
  limit = RECENT_RUNS,
): RunListEntry[] {
  return filterRuns(runs, { ...NO_RUN_FILTER, automation }, now)
    .slice(0, limit)
    .reverse();
}

/**
 * The strip's slots: `recentRuns` padded on the left with empty ones, so
 * every row's newest run sits at the same x, at the strip's right edge.
 */
export function historySlots<T>(runs: T[], size = RECENT_RUNS): Array<T | null> {
  const shown = runs.slice(-size);
  return [...Array<null>(size - shown.length).fill(null), ...shown];
}

const STRIP_ORDER: ReadonlyArray<RunFacts['status']> = [
  'completed',
  'failed',
  'running',
  'needs-approval',
  'waiting',
  'queued',
  'rejected',
];

/** The strip in words, for whoever cannot see its colours: "Last 12 runs: 11 completed, 1 failed". */
export function recentRunsInWords(runs: Array<RunFacts & RejectedFacts>): string {
  if (runs.length === 0) return 'No runs in the last 30 days';
  const lead = runs.length === 1 ? 'Last run' : `Last ${runs.length} runs`;
  const counts = wordCounts(runs);
  if (counts.length === 1) return `${lead}: ${runs.length === 1 ? '' : 'all '}${counts[0].word}`;
  return `${lead}: ${statusCountsInWords(runs)}`;
}

/**
 * How runs ended, counted in the strip's order: "3 completed, 1 failed". A
 * run rejected at a gate counts apart from one turned down before it
 * started: "1 rejected, 1 dismissed" (`runStatusWord`).
 */
export function statusCountsInWords(runs: Array<RunFacts & RejectedFacts>): string {
  return wordCounts(runs)
    .map(({ word, count }) => `${count} ${word}`)
    .join(', ');
}

/** Runs counted by `runStatusWord`, in the strip's order (a gate's `rejected` before `dismissed`). */
function wordCounts(runs: Array<RunFacts & RejectedFacts>): Array<{ word: string; count: number }> {
  const counts: Array<{ word: string; count: number }> = [];
  for (const status of STRIP_ORDER) {
    const words =
      status === 'rejected' ? ['rejected', statusWord('rejected')] : [statusWord(status)];
    for (const word of words) {
      const count = runs.filter(
        (run) => run.status === status && runStatusWord(run) === word,
      ).length;
      if (count > 0) counts.push({ word, count });
    }
  }
  return counts;
}

/** Runs counted by status, in the strip's order, leaving out the ones none have. */
export function statusCounts(
  runs: RunFacts[],
): Array<{ status: RunFacts['status']; count: number }> {
  return STRIP_ORDER.map((status) => ({
    status,
    count: runs.filter((run) => run.status === status).length,
  })).filter(({ count }) => count > 0);
}

/**
 * What an automation's runs add up to, as a CI dashboard sums up a
 * pipeline. `runs` are what history keeps for it (`filterRuns`), newest first.
 */
export interface RunInsights {
  total: number;
  /** Completed out of those that worked to an end (completed or failed), 0–1; null when none did. */
  successRate: number | null;
  /** The middle duration of those that worked to an end, in ms; null when none did. */
  medianMs: number | null;
  /** When the newest failure ended; null when none failed. */
  lastFailureAt: string | null;
  /** The newest runs that worked to an end, counted while they ended the same way. */
  streak: { status: 'completed' | 'failed'; count: number } | null;
}

export function runInsights(runs: RunFacts[]): RunInsights {
  const ended = runs.filter(
    (run): run is RunFacts & { status: 'completed' | 'failed' } =>
      run.status === 'completed' || run.status === 'failed',
  );
  const completed = ended.filter((run) => run.status === 'completed').length;
  const durations = ended
    .map((run) => Date.parse(run.finishedAt ?? '') - Date.parse(run.startedAt ?? run.createdAt))
    .filter((ms) => Number.isFinite(ms) && ms >= 0)
    .sort((a, b) => a - b);
  const middle = Math.floor(durations.length / 2);
  const medianMs =
    durations.length === 0
      ? null
      : durations.length % 2 === 1
        ? durations[middle]
        : (durations[middle - 1] + durations[middle]) / 2;
  const lastFailure = ended.find((run) => run.status === 'failed');
  let streak: RunInsights['streak'] = null;
  if (ended.length > 0) {
    const status = ended[0].status;
    const broken = ended.findIndex((run) => run.status !== status);
    streak = { status, count: broken === -1 ? ended.length : broken };
  }
  return {
    total: runs.length,
    successRate: ended.length === 0 ? null : completed / ended.length,
    medianMs,
    lastFailureAt: lastFailure
      ? (lastFailure.finishedAt ?? lastFailure.updatedAt ?? lastFailure.createdAt)
      : null,
    streak,
  };
}

/** One local calendar day of an automation's runs, newest run first. */
export interface RunDay<T extends RunFacts = RunFacts> {
  /** Local midnight that starts it. */
  day: Date;
  runs: T[];
}

/**
 * The last `days` local calendar days, oldest first and today last, each
 * with the runs created on it. A day with no runs is still there, so a gap
 * in a schedule shows as one.
 */
export function runsByDay<T extends RunFacts>(
  runs: T[],
  now: Date,
  days = HISTORY_DAYS,
): Array<RunDay<T>> {
  const result: Array<RunDay<T>> = [];
  for (let back = days - 1; back >= 0; back--) {
    result.push({
      day: new Date(now.getFullYear(), now.getMonth(), now.getDate() - back),
      runs: [],
    });
  }
  for (const run of runs) {
    const at = new Date(run.createdAt);
    if (Number.isNaN(at.getTime())) continue;
    const index = days - 1 - calendarDaysBefore(at, now);
    if (index >= 0 && index < days) result[index].runs.push(run);
  }
  for (const entry of result)
    entry.runs.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return result;
}

/**
 * The step a person stands in between an automation firing and it acting,
 * when there is one: approving each run (`confirm`), approving the next one
 * (`auto`, new or changed since approved), or only being told (`notify`),
 * which follows a preview rather than gating a run.
 */
export interface ApprovalStep {
  kind: 'approve' | 'notify';
  title: string;
  detail: string;
}

/**
 * What the Activity banner's Add writes, after "Adds review-assigned-prs to
 * factory.yml": the same entry as the template (decision 8), which reviews
 * read-only, posts as the person and never approves (decision 7).
 */
export const ASSIGNED_REVIEWS_OFFER =
  'When a pull request asks for your review or is assigned to you, a read-only agent reviews it in a checkout of ' +
  'its own, then Consola posts the review on GitHub as you, as a comment or a request for changes, never an ' +
  'approval. It skips a commit it already reviewed, and asks you once first, with every command shown.';

/** How a template's entry will treat the person once added: a card's line, where `approvalStep` is a pipeline's node. */
export function templateModeWords(
  mode: AutomationMode,
  source: AutomationView['source'] = 'cron',
): string {
  if (source === 'poll' && mode === 'auto') return 'Starts once you allow it, then runs on its own';
  if (mode === 'confirm') return 'You approve each run';
  if (mode === 'notify') return 'Only tells you what it would do';
  return 'Asks once, then runs on its own';
}

/**
 * Run again's tooltip: what pressing it will do. An `auto` entry it no longer
 * asks about runs now. So does a `notify` steps entry: it starts its agent
 * steps (read-only) and its `dry_run: run` commands at once, said as its
 * pipeline's approval node says it, or, when every step only reports, starts
 * nothing. Anything that asks first previews and waits.
 */
export function runAgainTitle(
  automation: Pick<AutomationView, 'mode' | 'asksFirst' | 'kind' | 'steps' | 'problem'>,
): string {
  if (automation.problem) return `Not running: ${automation.problem}`;
  if (automation.mode === 'auto' && !automation.asksFirst) return 'Run it again now';
  if (automation.mode === 'notify' && automation.steps && !automation.asksFirst) {
    const starts = automation.steps.some((step) => step.kind === 'agent' || step.dryRun);
    return starts
      ? `Run it again now. ${approvalStep(automation)!.detail}`
      : 'Run it again now; it starts nothing and reports what it would run';
  }
  return 'Preview it again now; nothing changes until you approve';
}

export function approvalStep(
  automation: Pick<AutomationView, 'mode' | 'asksFirst' | 'kind' | 'steps'> &
    Partial<Pick<AutomationView, 'source' | 'needsAllow'>>,
  /** Not in the file yet (a template): an `auto` entry's first run is the one it asks about. */
  draft = false,
): ApprovalStep | null {
  const { steps } = automation;
  // A poll entry is accepted by Allow alone: approving a run never accepts it, and its check runs even when its steps only report.
  const poll = automation.source === 'poll';
  if (automation.mode === 'notify') {
    // A steps entry's dry run starts its agent steps (read-only) and the commands marked `dry_run: run`.
    const runs = steps?.filter((step) => step.kind === 'agent' || step.dryRun) ?? [];
    if (steps && runs.length > 0) {
      // A loop's own row runs nothing and reports nothing: its steps are named (3-A code review M4).
      const reports = steps
        .filter((step) => !runs.includes(step) && step.kind !== 'repeat')
        .map((step) => step.id);
      const agents = runs.filter((step) => step.kind === 'agent').map((step) => step.id);
      const commands = runs.filter((step) => step.kind === 'run').map((step) => step.id);
      // Two groups, said apart: an agent step is read-only, a command runs as the person.
      const groups = [
        ...(agents.length > 0 ? [`${agents.join(' and ')} read-only`] : []),
        ...(commands.length > 0 ? [`${commands.join(' and ')} as you`] : []),
      ].join(' and ');
      return {
        kind: 'notify',
        title: poll ? 'Runs dry runs once you allow it' : 'Asks once, then runs',
        detail: `Runs ${groups}${reports.length > 0 ? `; ${reports.join(', ')} only ${reports.length > 1 ? 'report' : 'reports'}` : ''}.`,
      };
    }
    if (poll) {
      return {
        kind: 'notify',
        title: 'Checks once you allow it',
        detail: 'Its check command runs as you; its steps only report.',
      };
    }
    return { kind: 'notify', title: 'Tells you what it would do', detail: 'Starts nothing' };
  }
  if (automation.mode === 'confirm') {
    if (steps)
      return {
        kind: 'approve',
        title: 'You approve each run',
        detail: 'Its steps run when you press Start',
      };
    return {
      kind: 'approve',
      title: 'You approve each run',
      detail:
        automation.kind === 'agent'
          ? 'Its session starts when you press Start'
          : 'It previews first; nothing changes until you approve',
    };
  }
  if (poll && automation.mode === 'auto') {
    if (!draft && !automation.needsAllow && !automation.asksFirst) return null;
    return {
      kind: 'approve',
      title: 'You allow it first',
      detail: 'Then it checks, and runs on its own',
    };
  }
  if (draft && automation.mode === 'auto') {
    return {
      kind: 'approve',
      title: 'You approve its first run',
      detail: 'Then it runs on its own',
    };
  }
  if (automation.asksFirst) {
    return {
      kind: 'approve',
      title: 'You approve its next run',
      detail:
        'New or changed since you last did. Once you approve a run no agent asked for, it runs on its own',
    };
  }
  return null;
}

/** A piece of one line of YAML, by what it is, so an entry shows as written but easier to read. */
export interface YamlToken {
  kind:
    | 'space'
    | 'dash'
    | 'key'
    | 'colon'
    | 'punct'
    | 'string'
    | 'number'
    | 'literal'
    | 'plain'
    | 'comment';
  text: string;
}

/** An inline map or list's pieces: a quoted string, a key, a number, punctuation, space, or a bare word. */
const YAML_FLOW =
  /("[^"]*"|'[^']*')|([^\s{}[\],:"']+)(?=\s*:)|(-?\d+(?:\.\d+)?)(?=[\s,}\]]|$)|([{}[\],])|(:)|(\s+)|([^\s{}[\],:"']+|.)/g;

/** `{ cron: "0 9 * * *" }` and `[merged, closed]`, shaded inside as a block mapping is. */
function yamlFlowTokens(value: string): YamlToken[] {
  const tokens: YamlToken[] = [];
  for (const [text, string, key, number, punct, colon, space] of value.matchAll(YAML_FLOW)) {
    const kind: YamlToken['kind'] = string
      ? 'string'
      : key
        ? 'key'
        : number
          ? 'number'
          : punct
            ? 'punct'
            : colon
              ? 'colon'
              : space
                ? 'space'
                : /^(true|false|null|~)$/i.test(text)
                  ? 'literal'
                  : 'plain';
    tokens.push({ kind, text });
  }
  return tokens;
}

const YAML_KEY = /^((?:"[^"]*"|'[^']*'|[^\s#'"][^:#]*?))(:)(?=\s|$)/;

/**
 * An entry's lines as tokens. Shading only: nothing here decides what the
 * file means. A block scalar's body (`prompt: |`) is text however it looks,
 * so it is never read as keys.
 */
export function yamlTokens(text: string): YamlToken[][] {
  let blockIndent: number | null = null;
  return text.split('\n').map((line) => {
    const indent = line.length - line.trimStart().length;
    const body = line.slice(indent);
    const tokens: YamlToken[] = indent > 0 ? [{ kind: 'space', text: line.slice(0, indent) }] : [];
    if (blockIndent !== null) {
      if (body === '' || indent > blockIndent) {
        if (body) tokens.push({ kind: 'string', text: body });
        return tokens;
      }
      blockIndent = null;
    }
    let rest = body;
    let column = indent;
    while (rest.startsWith('- ') || rest === '-') {
      tokens.push({ kind: 'dash', text: '-' });
      if (rest.length > 1) tokens.push({ kind: 'space', text: ' ' });
      rest = rest.slice(2);
      column += 2;
    }
    if (rest.startsWith('#')) return [...tokens, { kind: 'comment', text: rest }];
    const key = YAML_KEY.exec(rest);
    if (key) {
      tokens.push({ kind: 'key', text: key[1] }, { kind: 'colon', text: ':' });
      rest = rest.slice(key[0].length);
      if (/^\s*[|>][-+0-9]*\s*(#.*)?$/.test(rest)) blockIndent = column;
    }
    if (rest) tokens.push(...yamlValueTokens(rest));
    return tokens;
  });
}

function yamlValueTokens(rest: string): YamlToken[] {
  const lead = rest.length - rest.trimStart().length;
  const tokens: YamlToken[] = lead > 0 ? [{ kind: 'space', text: rest.slice(0, lead) }] : [];
  let value = rest.slice(lead);
  let comment = '';
  if (!/^["']/.test(value)) {
    const hash = value.search(/\s#/);
    if (hash !== -1) {
      comment = value.slice(hash);
      value = value.slice(0, hash);
    }
  }
  if (/^[{[]/.test(value)) tokens.push(...yamlFlowTokens(value));
  else if (value) {
    const kind: YamlToken['kind'] = /^(["']).*\1$/.test(value)
      ? 'string'
      : /^-?\d+(\.\d+)?$/.test(value)
        ? 'number'
        : /^(true|false|null|~|[|>][-+0-9]*)$/i.test(value)
          ? 'literal'
          : 'plain';
    tokens.push({ kind, text: value });
  }
  if (comment) {
    const space = comment.length - comment.trimStart().length;
    tokens.push(
      { kind: 'space', text: comment.slice(0, space) },
      { kind: 'comment', text: comment.slice(space) },
    );
  }
  return tokens;
}

/** What an automation's row says about its latest run: the word, its tone, and when or how long. */
export interface LatestRun {
  run: RunFacts;
  tone: RunFacts['status'];
  label: string;
  detail: string;
}

const LATEST_LABELS: Record<RunFacts['status'], string> = {
  queued: 'Queued',
  running: 'Running',
  'needs-approval': 'Waiting for you',
  waiting: 'On hold',
  completed: 'Completed',
  failed: 'Failed',
  rejected: 'Dismissed',
};

/** Where a run stands, as a label rather than a word in a sentence: "Waiting for you", "Completed". */
export function statusLabel(status: RunFacts['status']): string {
  return LATEST_LABELS[status];
}

/**
 * The run an automation's row speaks for, strongest first: one waiting for
 * the person's approval however old, then one waiting for them at a gate,
 * then one running, then one queued, else the newest. `runs` oldest first,
 * as `recentRuns` gives them; `place` is a queued run's place in line. A
 * waiting run's detail is the run page's: `asked <ago>` at a gate (since the
 * line it parked on), `retries at 10:42` out a retry.
 */
export function latestRun(
  runs: Array<RunFacts & { step?: RunListEntry['step'] }>,
  now: Date,
  place?: (runId: string) => number | undefined,
): LatestRun | null {
  const newestFirst = [...runs].reverse();
  const run =
    newestFirst.find((candidate) => candidate.status === 'needs-approval') ??
    newestFirst.find((candidate) => isWaitingAtGate(candidate)) ??
    newestFirst.find((candidate) => candidate.status === 'running') ??
    newestFirst.find((candidate) => candidate.status === 'queued') ??
    newestFirst[0];
  if (!run) return null;
  const label = runStatusLabel(run);
  if (run.status === 'waiting') {
    if (isWaitingAtGate(run))
      return { run, tone: run.status, label, detail: `asked ${formatAgo(run.updatedAt, now)}` };
    const retryAt =
      run.step?.retryAt ??
      run.steps?.find((step) => step.status === 'waiting')?.retryAt ??
      run.retryAt;
    return {
      run,
      tone: run.status,
      label,
      detail: retryAt ? `retries at ${clockTime(retryAt)}` : formatAgo(run.updatedAt, now),
    };
  }
  if (run.status === 'running')
    return { run, tone: run.status, label, detail: `for ${formatDuration(run, now) ?? '0s'}` };
  if (run.status === 'queued') {
    const line = place?.(run.id);
    return {
      run,
      tone: run.status,
      label,
      detail: line !== undefined ? `${line} in line` : formatAgo(run.createdAt, now),
    };
  }
  if (run.status === 'needs-approval')
    return { run, tone: run.status, label, detail: formatAgo(run.createdAt, now) };
  return {
    run,
    tone: run.status,
    label,
    detail: formatAgo(run.finishedAt ?? run.updatedAt ?? run.createdAt, now),
  };
}

/** When a run reached its outcome: its finish, else the last time it changed. */
function endedAt(run: RunFacts): number {
  return Date.parse(run.finishedAt ?? run.updatedAt ?? run.createdAt);
}

/** The runs that failed after `lastSeen`, when the person last looked at the workspace's runs. */
export function unseenFailures(snapshot: AutomationsSnapshot, lastSeen: string): RunListEntry[] {
  const seen = Date.parse(lastSeen);
  return snapshot.runs.filter((run) => run.status === 'failed' && endedAt(run) > seen);
}

/**
 * Whether the Automations table shows every unseen failure, so that looking
 * at the table can count as seeing them: each must be the run its row's
 * "Last run" speaks for, the one cell the table keeps at every width. A
 * failure outside factory.yml (an entry since removed, an agent's request),
 * or one a later run has taken the place of, shows only in Activity.
 */
export function tableShowsUnseenFailures(
  snapshot: AutomationsSnapshot,
  lastSeen: string,
  now: Date,
): boolean {
  const unseen = unseenFailures(snapshot, lastSeen);
  if (unseen.length === 0) return true;
  const shown = new Set(
    snapshot.automations.flatMap(
      (automation) => latestRun(recentRuns(snapshot.runs, automation.name, now), now)?.run.id ?? [],
    ),
  );
  return unseen.every((run) => shown.has(run.id));
}

/**
 * What a workspace's Automations row says in the sidebar, strongest first:
 * something waiting on the person, then a failure they have not seen yet
 * (`lastSeen` is when they last looked at its runs), then agents running.
 */
export function sidebarRowState(
  snapshot: AutomationsSnapshot | undefined,
  lastSeen: string,
  /** How many runs main says are waiting; the sidebar's own count, so the two agree. */
  waiting: number,
): { kind: 'waiting' | 'failed' | 'running'; count: number } | { kind: 'idle' } {
  if (!snapshot) return { kind: 'idle' };
  if (waiting > 0) return { kind: 'waiting', count: waiting };
  const failed = unseenFailures(snapshot, lastSeen).length;
  if (failed > 0) return { kind: 'failed', count: failed };
  const running = snapshot.runs.filter(
    (run) => run.status === 'running' && run.kind === 'agent',
  ).length;
  if (running > 0) return { kind: 'running', count: running };
  return { kind: 'idle' };
}

export type CollapsedStep =
  | ConversationEntry
  | { kind: 'more'; count: number; hidden: ConversationEntry[] };

/** Splits a conversation into the prompt, the work in between, and the closing answer. */
function partition(entries: ConversationEntry[]): {
  prompts: ConversationEntry[];
  work: ConversationEntry[];
  answer: ConversationEntry[];
} {
  let promptEnd = 0;
  while (promptEnd < entries.length && entries[promptEnd].kind === 'prompt') promptEnd++;
  let lastStep = -1;
  entries.forEach((entry, index) => {
    if (entry.kind === 'step') lastStep = index;
  });
  const workEnd = Math.max(lastStep + 1, promptEnd);
  return {
    prompts: entries.slice(0, promptEnd),
    work: entries.slice(promptEnd, workEnd),
    answer: entries.slice(workEnd),
  };
}

/**
 * Folds the middle of a long run into "N more steps", keeping its first and
 * last few. Only worth hiding when the fold would hide more than one step.
 */
export function collapseSteps(entries: ConversationEntry[], head = 4, tail = 4): CollapsedStep[] {
  const { prompts, work, answer } = partition(entries);
  if (work.length <= head + tail + 1) return entries;
  const hidden = work.slice(head, work.length - tail);
  return [
    ...prompts,
    ...work.slice(0, head),
    { kind: 'more', count: hidden.length, hidden },
    ...work.slice(work.length - tail),
    ...answer,
  ];
}

/**
 * The run's closing answer: the text after its last step. Text between steps
 * is the agent narrating, so it stays with the steps (the prompt is not one).
 */
export function finalAnswer(entries: ConversationEntry[]): {
  steps: ConversationEntry[];
  answer: string | null;
} {
  const { work, answer } = partition(entries);
  const texts = answer.flatMap((entry) => (entry.kind === 'text' ? [entry.text] : []));
  return { steps: work, answer: texts.length > 0 ? texts.join('\n\n') : null };
}

/** What a command node of a `steps:` entry does: under `notify` it only reports, unless marked `dry_run: run`. */
export function commandFoot(step: { dryRun?: true }, mode: AutomationMode): string {
  return mode === 'notify' && !step.dryRun ? 'Reports what it would run' : 'Runs as you';
}

const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? '' : 's'} ago`;

/** How long ago, in words a sentence takes: "10 minutes ago", "yesterday", "2 days ago". */
function whenWords(iso: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - Date.parse(iso)) / 60_000);
  if (Number.isNaN(minutes) || minutes < 1) return 'just now';
  if (minutes < 60) return plural(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return plural(hours, 'hour');
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  return days < 7 ? plural(days, 'day') : formatAgo(iso, now);
}

/** A row's item, the same however its repository is cased: a work item's identity, or a key. */
function rowIdentity(row: ItemTargetRow): string {
  const { target } = row;
  if ('workItem' in target) {
    const { repo, number, type } = target.workItem;
    return `${repo.toLowerCase()}#${number}:${type}`;
  }
  return 'key' in target ? `key:${target.key}` : `url:${target.url}`;
}

/** Run on…'s two lists with each item once: one in its last check is not listed again from the Inbox. */
export function runOnRows(targets: ItemTargets): Pick<ItemTargets, 'items' | 'inbox'> {
  const listed = new Set(targets.items.map(rowIdentity));
  return {
    items: targets.items,
    inbox: targets.inbox.filter((row) => !listed.has(rowIdentity(row))),
  };
}

/** What Run on… says of an item's newest run of this automation: "ran 2 days ago", "waiting for you". */
export function lastRunWords(lastRun: ItemTargetRow['lastRun'], now: Date): string {
  if (!lastRun) return 'never run';
  switch (lastRun.status) {
    case 'running':
    case 'queued':
      return 'running now';
    case 'needs-approval':
      return 'waiting for you';
    case 'waiting':
      return lastRun.gate !== undefined ? `waiting for you at ${lastRun.gate}` : 'retrying';
    case 'failed':
      return `failed ${whenWords(lastRun.at, now)}`;
    case 'rejected':
      return lastRun.gate !== undefined
        ? `rejected at \`${lastRun.gate}\` ${whenWords(lastRun.at, now)}`
        : lastRun.started
          ? `rejected ${whenWords(lastRun.at, now)}`
          : `dismissed ${whenWords(lastRun.at, now)}`;
    default:
      return `ran ${whenWords(lastRun.at, now)}`;
  }
}

/**
 * The item a run was about, as Run again sends it back: the work item when its
 * record kept repo, number and type; the key of a key item (no page, no connection); the URL of a
 * work item recorded without its identity. A record from before runs kept
 * those, and a run with no item, has none.
 */
export function runAgainTarget(run: RunRecord): ItemTarget | null {
  const item = run.trigger.item;
  if (!item) return null;
  if (item.repo && item.number !== undefined && item.type) {
    return { workItem: { repo: item.repo, number: item.number, type: item.type } };
  }
  // A work item's record names its connection; a key item's has none and no page.
  if (!run.trigger.connection && !item.url) return { key: item.key };
  // A work item recorded without its identity: the connection parses its URL.
  if (run.trigger.connection && item.url) return { url: item.url };
  return null;
}

/** A name as the factory's files take it (factory-spec's `AUTOMATION_NAME_PATTERN`). */
const FILE_NAME = '[a-z0-9][a-z0-9-]{0,63}';
const OPENABLE = new RegExp(
  `^(?:factory\\.yml|automations/${FILE_NAME}\\.yaml|agents/${FILE_NAME}\\.md|skills/${FILE_NAME}/SKILL\\.md)$`,
);

/**
 * Whether Open accepts this path of the folder: one of the factory's own
 * files (`FactoryFolder.pathOf`'s rule, copied, with a parity test in main).
 * A stray, a skill's folder or its other files, and a name that is no name
 * are listed with their issues but offer no Open, which would only refuse.
 */
export function isOpenableFile(relative: string): boolean {
  return OPENABLE.test(relative);
}

/**
 * The folder's issues by the file each is in, files in the order they first
 * appear and issues in theirs; one with no file is `factory.yml`'s, the file
 * a lone `factory.yml` read reports on.
 */
export function issuesByFile(
  issues: readonly FactorySpecIssue[],
): Array<{ file: string; issues: FactorySpecIssue[] }> {
  const groups = new Map<string, FactorySpecIssue[]>();
  for (const issue of issues) {
    const file = issue.file ?? 'factory.yml';
    const group = groups.get(file);
    if (group) group.push(issue);
    else groups.set(file, [issue]);
  }
  return [...groups].map(([file, grouped]) => ({ file, issues: grouped }));
}

/**
 * The issue list's title: while the folder does not apply, what keeps the
 * changes from applying (the last applied version runs meanwhile); else
 * whether nothing loaded or only some entries did not.
 */
export function issuesTitle(
  snapshot: Pick<AutomationsSnapshot, 'automations' | 'standing'>,
): string {
  if (snapshot.standing) return 'What keeps your changes from applying';
  return snapshot.automations.length === 0
    ? 'The factory did not load'
    : 'Some entries did not load';
}

/**
 * Every notice in one quiet line, each after its place (`file:line`, or the
 * file alone): later slices' folders and model warnings, none of which stops
 * anything. Null when there are none.
 */
export function noticesLine(notices: readonly FactoryNotice[]): string | null {
  if (notices.length === 0) return null;
  return notices
    .map((notice) => {
      const place =
        notice.file === undefined
          ? ''
          : `${notice.file}${notice.line !== undefined ? `:${notice.line}` : ''}: `;
      return `${place}${notice.message}`;
    })
    .join(' ');
}
