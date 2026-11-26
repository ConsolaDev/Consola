import type { Refusal } from './refusal';
import type { components } from './apiContract';
import type { WorkspaceMember } from './teams';

/**
 * A workspace's runs as the web app sees them. They live in the API
 * (`apps/cloud-api/AGENTS.md`, "Runs"), which decides everything: which runs a person sees,
 * each run's phase (a request rolls up to `needs-you` while one of its automations needs
 * someone), the chips' counts and what the filter menus offer. The page only shows it.
 *
 * A request is a run whose one step is the factory's orchestrator, started by a person with text;
 * the automations it starts are its children, each an ordinary automation run with steps. Other
 * runs at the top of the list are automation runs nothing's orchestrator started: a schedule, an
 * event, a poll ("background runs"), or a person's manual run.
 */

type Schemas = components['schemas'];

export type Phase = Schemas['Phase'];
export type RunStatus = Schemas['RunStatus'];
export type RunTrigger = Schemas['RunTrigger'];
export type StepStatus = Schemas['StepStatus'];
export type RunItem = Schemas['RunItem'];
export type PhaseCounts = Schemas['PhaseCounts'];
export type RunSummary = Schemas['RunSummary'];
export type StepSummary = Schemas['StepSummary'];
export type StepDefinition = Schemas['StepDefinition'];
export type RunList = Schemas['RunList'];
export type RunDetail = Schemas['RunDetail'];

export type LineRange = Schemas['LineRange'];
export type RunSource = Schemas['RunSource'];
export type RunApproval = Schemas['RunApproval'];

/** What the filter menus offer: the factories, teams and automations the person sees. */
export type RunFacets = RunList['facets'];

/**
 * Every phase, in the order the chips show them: what is running, what ended (well, badly), what
 * waits on someone, what was stopped. The API's `counts` hold exactly these (`runs.test.ts`).
 */
export const PHASES = [
  'active',
  'completed',
  'failed',
  'needs-you',
  'stopped',
] as const satisfies readonly Phase[];

/** Every way a run is started, in the Trigger menu's order. */
export const RUN_TRIGGERS = [
  'manual',
  'cron',
  'event',
  'poll',
] as const satisfies readonly RunTrigger[];

/** The triggers of a "background" run: one no person started. */
export const BACKGROUND_TRIGGERS: readonly RunTrigger[] = ['cron', 'event', 'poll'];

export function isPhase(value: unknown): value is Phase {
  return typeof value === 'string' && (PHASES as readonly string[]).includes(value);
}

export function isRunTrigger(value: unknown): value is RunTrigger {
  return typeof value === 'string' && (RUN_TRIGGERS as readonly string[]).includes(value);
}

/** Whether a run can still change: it runs, or it waits on someone. */
export function isLive(run: { phase: Phase }): boolean {
  return run.phase === 'active' || run.phase === 'needs-you';
}

/**
 * Whether a step will not run again in this attempt: the API's own rule for a run's progress
 * (`progress.done`), so the steps pane and the info panel count alike. Read by its status, never
 * by whether it has a finish time.
 */
export function stepHasEnded(step: { status: StepStatus }): boolean {
  return ENDED_STEP_STATUSES.has(step.status);
}

const ENDED_STEP_STATUSES: ReadonlySet<StepStatus> = new Set<StepStatus>([
  'completed',
  'failed',
  'skipped',
  'reported',
  'not-run',
]);

/** A page of runs, at most this many, as the API allows. */
export const PAGE_MAX = 100;
/** A page of runs, as the API gives one unasked. */
export const PAGE_SIZE = 50;

/**
 * How many runs a refresh of the list asks for: as many as it shows, so every row shown is read
 * again, up to the API's page.
 */
export function refreshLimit(shown: number): number {
  return Math.min(PAGE_MAX, Math.max(PAGE_SIZE, shown));
}

/** Newest first, as the API orders them: by `createdAt`, then by id. */
function newerFirst(a: RunSummary, b: RunSummary): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/**
 * The list after a refresh. The refresh asked for the newest runs again (`refreshLimit`), so it
 * replaces every row it reaches, adds the runs that arrived and drops those gone (ended out of a
 * phase filter, or no longer the person's to see). Rows shown that it no longer reaches, because
 * new runs pushed them past its end, stay as they were, and "Load more" goes on after them.
 */
export function mergeRefresh(
  shown: { runs: readonly RunSummary[]; nextCursor: string | null },
  fresh: { runs: readonly RunSummary[]; nextCursor: string | null },
): { runs: RunSummary[]; nextCursor: string | null } {
  const last = fresh.runs.at(-1);
  if (!last || fresh.nextCursor === null) {
    return { runs: [...fresh.runs], nextCursor: fresh.nextCursor };
  }
  const reached = new Set(fresh.runs.map((run) => run.id));
  const beyond = shown.runs.filter((run) => !reached.has(run.id) && newerFirst(run, last) > 0);
  if (beyond.length === 0) return { runs: [...fresh.runs], nextCursor: fresh.nextCursor };
  return { runs: [...fresh.runs, ...beyond], nextCursor: shown.nextCursor };
}

/** How often the list is read again: often while anything shown can still change. */
export const LIST_POLL_LIVE_MS = 5000;
export const LIST_POLL_QUIET_MS = 30_000;
/** How often a run's page is read again: while it runs, and, more slowly, while it waits on someone. */
export const RUN_POLL_ACTIVE_MS = 3000;
export const RUN_POLL_WAITING_MS = 15_000;

/** When the list is read again, given every run it shows, the expanded requests' automations included. */
export function listPollDelay(shown: ReadonlyArray<{ phase: Phase }>): number {
  return shown.some(isLive) ? LIST_POLL_LIVE_MS : LIST_POLL_QUIET_MS;
}

/**
 * When a run's page is read again, or null once nothing on it can change: the run and every
 * automation it started have ended.
 */
export function runPollDelay(detail: {
  run: { phase: Phase };
  children: ReadonlyArray<{ phase: Phase }>;
}): number | null {
  const all = [detail.run, ...detail.children];
  if (all.some((run) => run.phase === 'active')) return RUN_POLL_ACTIVE_MS;
  if (all.some((run) => run.phase === 'needs-you')) return RUN_POLL_WAITING_MS;
  return null;
}

/**
 * How far along a run is, from 0 to 1, for its status icon: an automation run's steps ended, or a
 * request's automations ended. Null when nothing says (a request that started none yet).
 */
export function progressOf(run: Pick<RunSummary, 'progress' | 'children'>): number | null {
  if (run.progress && run.progress.total > 0) {
    return Math.min(1, Math.max(0, run.progress.done / run.progress.total));
  }
  if (run.children && run.children.total > 0) {
    const ended = run.children.total - run.children.active - run.children.needsYou;
    return Math.min(1, Math.max(0, ended / run.children.total));
  }
  return null;
}

/**
 * Who started a run, as the page shows them: a member of the workspace; someone the members list
 * no longer holds (who left); nobody, for a run a schedule, an event, a poll or a request started.
 * `members` is null while they are not known, and then a person shows without a name.
 */
export type Starter =
  | { kind: 'member'; member: WorkspaceMember }
  | { kind: 'left'; personId: string }
  | { kind: 'unknown'; personId: string }
  | { kind: 'none' };

export function starterOf(
  run: Pick<RunSummary, 'startedBy'>,
  members: readonly WorkspaceMember[] | null,
): Starter {
  if (run.startedBy === null) return { kind: 'none' };
  if (members === null) return { kind: 'unknown', personId: run.startedBy };
  const member = members.find((listed) => listed.id === run.startedBy);
  return member ? { kind: 'member', member } : { kind: 'left', personId: run.startedBy };
}

/**
 * An item's address, only when it is a web page on `https:`: it lands in a link. The API refuses
 * any other, and the page checks again.
 */
export function safeItemUrl(url: string): string | null {
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** What reading a page of runs came to. */
export type RunsAnswer =
  | { kind: 'listed'; list: RunList }
  /** The API refused the list's filters or its place in the list (a cursor it cannot read). */
  | { kind: 'invalid' }
  | Refusal;

/** What reading one run came to. */
export type RunAnswer =
  | { kind: 'found'; detail: RunDetail }
  /** No such run, or one the person does not see: the API says the same of both. */
  | { kind: 'not-found' }
  | Refusal;

/** What reading the workspace's members came to, to name who started each run. */
export type MembersAnswer = { kind: 'listed'; members: WorkspaceMember[] } | Refusal;
