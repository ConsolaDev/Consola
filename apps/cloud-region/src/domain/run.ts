import {
  AUTOMATION_NAME_PATTERN,
  type Automation,
  describeOutputType,
  flatSteps,
  type LineRange,
  type RunStatus as EngineRunStatus,
  type StepRunStatus,
} from '@consola/factory-spec';
import {
  ITEM_KINDS,
  type ItemKind,
  OUTPUT_TAIL_MAX,
  type OutputValue,
  type PreviousAttempt,
  REQUEST_TEXT_MAX_BYTES,
  type RequestFacts,
  RUN_PROBLEM_TEXT_MAX,
  RUN_PROBLEMS_MAX,
  RUN_STATUSES,
  RUN_TRIGGERS,
  type RunItem,
  type RunParent,
  type RunProblem,
  type RunRecord,
  type RunRefused,
  type RunStatus,
  type RunTrigger,
  STEP_KINDS,
  STEP_STATUSES,
  type Spend,
  type StepKind,
  type StepRecord,
  type StepStatus,
  WAITING_ON,
  type WaitingOn,
} from '@consola/runner-protocol';

/**
 * A workspace's runs, held in its region's cell: what each factory's runners ran, for the web's
 * Runs pages. A run is one of two kinds (the orchestrator spec, slice 6b, "A request is a run"):
 *
 * - a **request**, a run whose one step is the factory's orchestrator, started by a person with
 *   text, which starts automation runs of its own factory;
 * - an **automation run**, with steps: one a request started (a child, whose `parent` names the
 *   request and never changes), or one a trigger or a person started (a top-level run).
 *
 * The cell writes no run of its own. A runner records each (`RunStore.record`), and a record is
 * stored only once `checkRun` finds nothing wrong with it, so every run the cell answers keeps
 * these rules. Who sees a run follows its factory (`factoriesSeenBy`): owners and admins every
 * run, a member the runs of the factories of the teams they are in.
 *
 * Each run is in a **phase**, the cell's grouping of its status, which the list filters and
 * counts by (`phaseOf`). A request whose own phase is active and one of whose children needs a
 * person needs one too (`requestPhase`), so a request parked on a child at a gate is filed with
 * the runs that need someone, not with those at work.
 */

export const PHASES = ['active', 'needs-you', 'completed', 'failed', 'stopped'] as const;
export type Phase = (typeof PHASES)[number];

/**
 * A run on the wire is the protocol's `RunRecord` (`@consola/runner-protocol`), its one
 * definition, which a runner records and the cell hands back: its vocabularies and its parts are
 * the protocol's, and the cell's own word for one is `RunWrite`. The protocol's reader checks a
 * record's shape alone; what it means is `checkRun`'s, below.
 */
export {
  ITEM_KINDS,
  type ItemKind,
  OUTPUT_TAIL_MAX,
  type OutputValue,
  type PreviousAttempt,
  REQUEST_TEXT_MAX_BYTES,
  type RequestFacts,
  RUN_STATUSES,
  RUN_TRIGGERS,
  type RunItem,
  type RunParent,
  type RunProblem,
  type RunStatus,
  type RunTrigger,
  STEP_KINDS,
  STEP_STATUSES,
  type Spend,
  type StepKind,
  type StepRecord,
  type StepStatus,
  WAITING_ON,
  type WaitingOn,
};

export const RUN_KINDS = ['request', 'automation'] as const;
export type RunKind = (typeof RUN_KINDS)[number];

// The engine's words are all the cell's: a status the engine records is never refused here.
type Missing<Engine, Cell> = Exclude<Engine, Cell> extends never ? true : Exclude<Engine, Cell>;
const engineRunStatusesHeld: Missing<EngineRunStatus, RunStatus> = true;
const engineStepStatusesHeld: Missing<StepRunStatus, StepStatus> = true;
void engineRunStatusesHeld;
void engineStepStatusesHeld;

/** What a step did, printed and produced, beside what it is and where it stands. */
export type StepDetail = Pick<StepRecord, NewStepFields>;

/** A step that has done and produced nothing yet, and printed nothing. */
export const NO_STEP_DETAIL: StepDetail = {
  outputs: null,
  artifacts: [],
  turn: null,
  command: null,
  previous: [],
  reminded: false,
  output: null,
};

const NEWLINE = 0x0a;

/**
 * The end of `text` a step's output keeps: all of it when it fits in `max` bytes of UTF-8, else
 * its last whole lines that do (or its last `max` bytes, when no line ends in them), and
 * `truncated`, since more came before.
 */
export function tailOf(text: string, max = OUTPUT_TAIL_MAX): { text: string; truncated: boolean } {
  const bytes = utf8.encode(text);
  if (bytes.length <= max) return { text, truncated: false };
  const from = bytes.length - max;
  // A cut inside a character decodes to U+FFFD, which the first whole line leaves behind.
  const end = new TextDecoder().decode(bytes.subarray(from));
  if (bytes[from - 1] === NEWLINE) return { text: end, truncated: true };
  const newline = end.indexOf('\n');
  const kept = newline === -1 ? end.replace(/^\uFFFD+/, '') : end.slice(newline + 1);
  return { text: kept, truncated: true };
}

/** What a step was asked: its definition at the factory version its run executed. */
export type StepDefinition = {
  readonly kind: 'agent' | 'run';
  /** As written: a template, never rendered. */
  readonly prompt: string | null;
  readonly action: string | null;
  readonly agent: string | null;
  /** The command, as written. */
  readonly run: string | null;
  readonly env: { readonly name: string; readonly value: string }[];
  readonly if: string | null;
  /** Its declared outputs, each type in words (`describeOutputType`). */
  readonly outputs: { readonly name: string; readonly type: string }[];
  readonly artifacts: string[];
  readonly maxTurns: number | null;
  readonly timeoutMs: number | null;
  /** The file its automation is written in, inside the factory. */
  readonly file: string;
  /** The factory version it was read from. */
  readonly version: number;
  /** Its lines in the file its automation is written in, when they are known. */
  readonly range: LineRange | null;
};

export type { LineRange };

/** One step of a run, as a run's page shows it: as recorded, with what it was asked. */
export type StepSummary = StepRecord & { readonly definition: StepDefinition | null };

/**
 * A step's definition, from its automation as the factory version's files define it, or null
 * when the automation has no such step (or no steps at all: a legacy entry). A step inside a
 * loop has its own; a loop's block runs nothing itself and a gate is a person's decision, so
 * neither is an agent or a command step, the two a definition describes, and both are null.
 */
export function stepDefinitionOf(
  automation: Automation,
  stepId: string,
  version: number,
  range: LineRange | null = null,
): StepDefinition | null {
  const step = flatSteps(automation.steps ?? []).find(
    (candidate) => candidate.step.id === stepId,
  )?.step;
  if (!step || (step.kind !== 'agent' && step.kind !== 'run')) return null;
  const outputs = Object.entries(step.outputs).map(([name, type]) => ({
    name,
    type: describeOutputType(type),
  }));
  const common = {
    if: step.if ?? null,
    outputs,
    file: automation.file ?? 'factory.yml',
    version,
    range,
  };
  if (step.kind === 'agent') {
    return {
      kind: 'agent',
      prompt: step.prompt ?? null,
      action: step.action ?? null,
      agent: step.agent ?? null,
      run: null,
      env: [],
      artifacts: [...step.artifacts],
      maxTurns: step.maxTurns ?? null,
      timeoutMs: null,
      ...common,
    };
  }
  return {
    kind: 'run',
    prompt: null,
    action: null,
    agent: null,
    run: step.run,
    env: Object.entries(step.env).map(([name, value]) => ({ name, value })),
    artifacts: [],
    maxTurns: null,
    timeoutMs: step.timeoutMs,
    ...common,
  };
}

/**
 * A step as stored before its later fields existed, given them: no outputs, artifacts, turn,
 * command, attempts or output, and not reminded. A step recorded now has them all.
 */
export function stepRecordOf(
  stored: Partial<StepRecord> & Omit<StepRecord, NewStepFields>,
): StepRecord {
  return {
    ...stored,
    outputs: stored.outputs ?? null,
    artifacts: stored.artifacts ?? [],
    turn: stored.turn ?? null,
    command: stored.command ?? null,
    previous: stored.previous ?? [],
    reminded: stored.reminded ?? false,
    output: stored.output ?? null,
  };
}

type NewStepFields =
  | 'outputs'
  | 'artifacts'
  | 'turn'
  | 'command'
  | 'previous'
  | 'reminded'
  | 'output';

/** The longest a run's title may be, in characters. */
export const TITLE_MAX = 120;

/**
 * A run as a runner records it: everything the cell keeps of it, the protocol's `RunRecord`. The
 * run's id is the runner's, and a record of an id the workspace already holds replaces it
 * (`RunStore.record`), unless it is older or would move the run backwards (`movesBackwards`).
 */
export type RunWrite = RunRecord;

/**
 * A run's first record: waiting for approval, never started (`needs-approval`, no `startedAt`).
 * Every run a trigger records begins as one, and a runner sends it again whenever it handles the
 * same event afresh: a runner keeps nothing durable, so after a restart it records an event the
 * cell hands it again (never acknowledged) as if new, under the same derived id.
 */
export function isFirstRecord(run: Pick<RunWrite, 'status' | 'startedAt'>): boolean {
  return run.status === 'needs-approval' && run.startedAt === null;
}

/**
 * A run never moves backwards: a first record never replaces a record of the same run that has
 * moved on from it (started, waiting, ended), whatever their times say, so an event handed again
 * can never bring an approved, running or finished run back to waiting for approval, where its
 * answer would be passed again and the run walked twice. A first record still replaces a first
 * record, newer over older, as any record does.
 */
export function movesBackwards(
  held: Pick<RunWrite, 'status' | 'startedAt'>,
  incoming: Pick<RunWrite, 'status' | 'startedAt'>,
): boolean {
  return isFirstRecord(incoming) && !isFirstRecord(held);
}

/** A record `checkRun` found nothing wrong with, with what the cell derives from it. */
export type CheckedRun = RunWrite & {
  readonly kind: RunKind;
  readonly title: string;
  /** Its phase by its own status alone; a request's stored phase also rolls up its children's. */
  readonly ownPhase: Phase;
};

/** A run as the list shows it, and as a run's page heads it. */
export type RunSummary = {
  readonly id: string;
  readonly kind: RunKind;
  readonly title: string;
  readonly status: RunStatus;
  readonly phase: Phase;
  readonly waitingOn: WaitingOn | null;
  readonly factory: { readonly id: string; readonly name: string; readonly version: number };
  /** The factory's team now. */
  readonly teamId: string;
  readonly automation: string | null;
  readonly parentId: string | null;
  readonly trigger: RunTrigger;
  readonly triggerDetail: string | null;
  readonly startedBy: string | null;
  readonly item: RunItem | null;
  readonly runner: string;
  readonly progress: Progress | null;
  readonly children: ChildCounts | null;
  readonly summary: string | null;
  readonly error: string | null;
  readonly costUsd: number | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly updatedAt: string;
};

/** An automation run's steps: how many, how many have ended, and the one at work. */
export type Progress = {
  readonly total: number;
  readonly done: number;
  readonly current: string | null;
};

/** A request's automation runs, by phase. */
export type ChildCounts = {
  readonly total: number;
  readonly active: number;
  readonly needsYou: number;
  readonly failed: number;
};

/** How many runs are in each phase. */
export type PhaseCounts = Readonly<Record<Phase, number>>;

export const NO_RUNS: PhaseCounts = {
  active: 0,
  'needs-you': 0,
  completed: 0,
  failed: 0,
  stopped: 0,
};

/** A run's phase by its own status: what the list files it under. */
export function phaseOf(status: RunStatus, waitingOn: WaitingOn | null): Phase {
  switch (status) {
    case 'queued':
    case 'running':
      return 'active';
    case 'waiting':
      return waitingOn === 'person' ? 'needs-you' : 'active';
    case 'needs-approval':
      return 'needs-you';
    case 'completed':
      return 'completed';
    case 'failed':
    case 'expired':
      return 'failed';
    case 'cancelled':
    case 'rejected':
      return 'stopped';
  }
}

/**
 * A request's phase: its own, but a request at work (active) one of whose children needs a person
 * needs one too. A request that has ended keeps its ended phase, whatever a child says.
 */
export function requestPhase(own: Phase, childPhases: readonly Phase[]): Phase {
  return own === 'active' && childPhases.includes('needs-you') ? 'needs-you' : own;
}

/** A step that will not run again in this attempt. */
const ENDED_STEP: ReadonlySet<StepStatus> = new Set([
  'completed',
  'failed',
  'skipped',
  'reported',
  'not-run',
]);

/** An automation run's progress through its steps; the first running or waiting one is current. */
export function progressOf(steps: readonly StepRecord[]): Progress {
  const current = steps.find((step) => step.status === 'running' || step.status === 'waiting');
  return {
    total: steps.length,
    done: steps.filter((step) => ENDED_STEP.has(step.status)).length,
    current: current?.id ?? null,
  };
}

/** A request's children, counted by phase. */
export function childCountsOf(childPhases: readonly Phase[]): ChildCounts {
  const count = (phase: Phase) => childPhases.filter((p) => p === phase).length;
  return {
    total: childPhases.length,
    active: count('active'),
    needsYou: count('needs-you'),
    failed: count('failed'),
  };
}

/** A control character: a line break, a tab, an escape. No title shows one. */
const CONTROLS = /\p{Cc}+/gu;

/** `text` on one line, at most `TITLE_MAX` characters, an ellipsis ending one that was cut. */
function titleText(text: string): string {
  const line = text.replace(CONTROLS, ' ').replace(/\s+/g, ' ').trim();
  const chars = [...line];
  if (chars.length <= TITLE_MAX) return line;
  return `${chars
    .slice(0, TITLE_MAX - 1)
    .join('')
    .trimEnd()}…`;
}

/**
 * What the list calls a run. A request: its item's title, else its text's first line that holds
 * anything. An automation run: its item's title, else its automation's name.
 */
export function titleOf(run: Pick<RunWrite, 'item' | 'automation' | 'request'>): string {
  const itemTitle = run.item ? titleText(run.item.title) : '';
  if (itemTitle !== '') return itemTitle;
  if (run.request) {
    const line = run.request.text.split(/\r\n|\r|\n/).find((l) => titleText(l) !== '');
    return line === undefined ? 'Request' : titleText(line);
  }
  return run.automation ?? 'Run';
}

/** A run's id: the runner's, letters, digits and `.`, `_`, `:` or `-`, at most 128 characters. */
export const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** An ISO 8601 time with its offset, to the millisecond at most, as the cell stores it. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

const isTime = (value: string): boolean => ISO_TIME.test(value) && !Number.isNaN(Date.parse(value));

/** A UTF-16 surrogate with no partner, which no UTF-8 text can hold. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const utf8 = new TextEncoder();

/** Every string anywhere in `value`, its keys included, with where it is. */
function stringsIn(value: unknown, at: string, found: [string, string][]): [string, string][] {
  if (typeof value === 'string') found.push([at, value]);
  else if (Array.isArray(value))
    value.forEach((entry, i) => stringsIn(entry, `${at}[${i}]`, found));
  else if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      found.push([at, key]);
      stringsIn(entry, `${at}.${key}`, found);
    }
  }
  return found;
}

const isCount = (n: number) => Number.isSafeInteger(n) && n >= 0;

/** A commit's id as a pull request's head names it: 40 lowercase hex digits. */
const HEAD_SHA = /^[0-9a-f]{40}$/;
const isMoney = (n: number) => Number.isFinite(n) && n >= 0;

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

const isWhole = (n: number | null) => n === null || isCount(n);

/**
 * What is wrong with what a step did and produced: outputs that are no values, sizes and counts
 * below zero or not whole, an attempt it does not know, and an output tail over the cap.
 */
function stepDetailProblems(
  step: StepRecord,
  at: string,
  refuse: (field: string, message: string) => void,
): void {
  if (step.outputs !== null) {
    for (const [name, value] of Object.entries(step.outputs)) {
      const ok =
        typeof value === 'string' ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value));
      if (name === '' || !ok)
        refuse(`${at}.outputs`, 'An output is a name and text, a number or true or false.');
    }
  }
  step.artifacts.forEach((artifact, i) => {
    if (artifact.name === '' || !isCount(artifact.bytes)) {
      refuse(`${at}.artifacts[${i}]`, 'An artifact has a name and a size in bytes from 0.');
    }
  });
  if (step.turn !== null && (!isWhole(step.turn.turns) || !isWhole(step.turn.maxTurns))) {
    refuse(`${at}.turn`, 'Turns are whole numbers from 0.');
  }
  if (step.command !== null) {
    const { exitCode, stdoutBytes, stderrBytes } = step.command;
    if (exitCode !== null && !Number.isSafeInteger(exitCode)) {
      refuse(`${at}.command.exitCode`, 'An exit code is a whole number.');
    }
    if (!isWhole(stdoutBytes) || !isWhole(stderrBytes)) {
      refuse(`${at}.command`, 'A byte count is a whole number from 0.');
    }
  }
  step.previous.forEach((attempt, i) => {
    const where = `${at}.previous[${i}]`;
    if (
      !Number.isSafeInteger(attempt.attempt) ||
      attempt.attempt < 1 ||
      attempt.attempt >= step.attempt
    ) {
      refuse(`${where}.attempt`, 'An earlier attempt is numbered from 1, below the latest.');
    }
    if (!(STEP_STATUSES as readonly string[]).includes(attempt.status)) {
      refuse(`${where}.status`, `\`${attempt.status}\` is no step status.`);
    }
    if (attempt.costUsd !== null && !isMoney(attempt.costUsd)) {
      refuse(`${where}.costUsd`, 'A cost is a number from 0.');
    }
    if (!isWhole(attempt.turns)) refuse(`${where}.turns`, 'Turns are whole numbers from 0.');
    if (attempt.finishedAt !== null && !isTime(attempt.finishedAt)) {
      refuse(`${where}.finishedAt`, 'That is no ISO 8601 time.');
    }
  });
  if (step.output !== null) {
    for (const stream of ['stdout', 'stderr'] as const) {
      if (utf8.encode(step.output[stream]).length > OUTPUT_TAIL_MAX) {
        refuse(
          `${at}.output.${stream}`,
          `The cell keeps at most the last ${OUTPUT_TAIL_MAX / 1024} KiB of a step's ${stream}.`,
        );
      }
    }
  }
}

/**
 * Whether a record may be stored, and if so what the cell derives from it: its kind, its title
 * and its own phase. Every problem is named at once. A runner's record is checked as factory
 * files are, so the cell holds no run its pages could not show: no status or kind it does not
 * know, a `waitingOn` exactly when waiting, an automation exactly for an automation run and a
 * request's facts exactly for a request, a parent only on an automation run (started by the
 * request, so `manual` and by no person), an item only at an https address, times it can store,
 * and no string a database text cannot hold (a NUL, a lone surrogate).
 */
export function checkRun(
  run: RunWrite,
): { ok: true; run: CheckedRun } | { ok: false; problems: RunProblem[] } {
  const problems: RunProblem[] = [];
  const refuse = (field: string, message: string) => problems.push({ field, message });

  if (!RUN_ID_PATTERN.test(run.id))
    refuse('id', 'A run id is 1 to 128 letters, digits, ., _, : or -.');
  if (run.factoryId === '') refuse('factoryId', 'A run names its factory.');
  if (!Number.isSafeInteger(run.factoryVersion) || run.factoryVersion < 1) {
    refuse('factoryVersion', "A factory's versions are numbered from 1.");
  }
  if (!(RUN_STATUSES as readonly string[]).includes(run.status)) {
    refuse('status', `\`${run.status}\` is no run status.`);
  }
  if ((run.status === 'waiting') !== (run.waitingOn !== null)) {
    refuse('waitingOn', 'A run says what it waits on exactly while it is waiting.');
  } else if (run.waitingOn !== null && !(WAITING_ON as readonly string[]).includes(run.waitingOn)) {
    refuse('waitingOn', `\`${run.waitingOn}\` is not what a run waits on.`);
  }
  if (!(RUN_TRIGGERS as readonly string[]).includes(run.trigger)) {
    refuse('trigger', `\`${run.trigger}\` is no trigger.`);
  }

  const isRequest = run.request !== null;
  if (isRequest && run.automation !== null) {
    refuse('automation', 'A request runs no automation of its own.');
  }
  if (!isRequest && run.automation === null) {
    refuse('automation', 'An automation run names its automation.');
  }
  if (run.automation !== null && !AUTOMATION_NAME_PATTERN.test(run.automation)) {
    refuse('automation', `\`${run.automation}\` is no automation's name.`);
  }

  if (run.parent !== null) {
    if (isRequest) refuse('parent', 'A request is never started by another.');
    if (!RUN_ID_PATTERN.test(run.parent.runId)) refuse('parent.runId', 'That is no run id.');
    if (run.parent.runId === run.id) refuse('parent.runId', 'A run is not its own parent.');
    if (!isCount(run.parent.move)) refuse('parent.move', "A move's number is a whole number.");
    if (run.trigger !== 'manual' || run.startedBy !== null) {
      refuse('trigger', 'A run a request started is `manual`, started by no person.');
    }
  }

  if (run.item !== null) {
    if (!isHttps(run.item.url)) refuse('item.url', "An item's address is https.");
    if (run.item.kind !== null && !(ITEM_KINDS as readonly string[]).includes(run.item.kind)) {
      refuse('item.kind', `\`${run.item.kind}\` is no item kind.`);
    }
    if (run.item.number !== null && (!isCount(run.item.number) || run.item.number < 1)) {
      refuse('item.number', "An item's number is a whole number from 1.");
    }
    const { headSha, baseRef } = run.item;
    if (run.item.kind !== 'pr' && (headSha !== null || baseRef !== null)) {
      refuse('item', 'Only a pull request has a head commit and a base branch.');
    }
    if (headSha !== null && !HEAD_SHA.test(headSha)) {
      refuse('item.headSha', "A head commit is a commit's 40 lowercase hex digits.");
    }
    if (baseRef !== null && baseRef.trim() === '') {
      refuse('item.baseRef', 'A base branch has a name.');
    }
  }

  run.steps.forEach((step, i) => {
    const at = `steps[${i}]`;
    if (step.id === '') refuse(`${at}.id`, 'A step has an id.');
    if (!(STEP_KINDS as readonly string[]).includes(step.kind)) {
      refuse(`${at}.kind`, `\`${step.kind}\` is no step kind.`);
    }
    if (!(STEP_STATUSES as readonly string[]).includes(step.status)) {
      refuse(`${at}.status`, `\`${step.status}\` is no step status.`);
    }
    if (!Number.isSafeInteger(step.attempt) || step.attempt < 1) {
      refuse(`${at}.attempt`, 'Attempts are numbered from 1.');
    }
    if (step.costUsd !== null && !isMoney(step.costUsd)) {
      refuse(`${at}.costUsd`, 'A cost is a number from 0.');
    }
    for (const [field, time] of [
      ['startedAt', step.startedAt],
      ['finishedAt', step.finishedAt],
    ] as const) {
      if (time !== null && !isTime(time)) refuse(`${at}.${field}`, 'That is no ISO 8601 time.');
    }
    stepDetailProblems(step, at, refuse);
  });
  const orchestrators = run.steps.filter((step) => step.kind === 'orchestrator');
  if (isRequest && (run.steps.length !== 1 || orchestrators.length !== 1)) {
    refuse('steps', "A request's one step is its orchestrator.");
  }
  if (!isRequest && orchestrators.length > 0) {
    refuse('steps', 'Only a request has an orchestrator step.');
  }

  if (run.request !== null) {
    const { text, budget, spent, question } = run.request;
    if (utf8.encode(text).length > REQUEST_TEXT_MAX_BYTES) {
      refuse('request.text', `A request's text is at most ${REQUEST_TEXT_MAX_BYTES / 1024} KB.`);
    }
    for (const [field, spend] of [
      ['budget', budget],
      ['spent', spent],
    ] as const) {
      if (spend !== null && (!isMoney(spend.usd) || !isCount(spend.runs))) {
        refuse(`request.${field}`, 'Dollars are a number from 0, and runs a whole number.');
      }
    }
    if (question !== null && (!isTime(question.at) || !isTime(question.until))) {
      refuse('request.question', "A question's times are ISO 8601 times.");
    }
  }

  if (run.costUsd !== null && !isMoney(run.costUsd))
    refuse('costUsd', 'A cost is a number from 0.');
  if (!isTime(run.createdAt)) refuse('createdAt', 'That is no ISO 8601 time.');
  if (!isTime(run.updatedAt)) refuse('updatedAt', 'That is no ISO 8601 time.');
  for (const [field, time] of [
    ['startedAt', run.startedAt],
    ['finishedAt', run.finishedAt],
  ] as const) {
    if (time !== null && !isTime(time)) refuse(field, 'That is no ISO 8601 time.');
  }

  for (const [at, text] of stringsIn(run, 'run', [])) {
    if (text.includes('\u0000')) refuse(at.slice(4), 'Text holds no NUL character.');
    else if (LONE_SURROGATE.test(text)) refuse(at.slice(4), 'Text holds no lone surrogate.');
  }

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    run: {
      ...run,
      kind: isRequest ? 'request' : 'automation',
      title: titleOf(run),
      ownPhase: phaseOf(run.status, run.waitingOn),
    },
  };
}

/** `text` cut to at most `max` UTF-16 code units, never between the two halves of a pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = /[\uD800-\uDBFF]/.test(text.charAt(max - 1)) ? max - 1 : max;
  return text.slice(0, end);
}

const REFUSED = 'The cell refused the record.';

/**
 * The `run.refused` the cell answers a runner's record with: its problems, at most
 * `RUN_PROBLEMS_MAX`, each `field` and `message` cut to `RUN_PROBLEM_TEXT_MAX`, so the answer is
 * always one the protocol reads. A message may quote a word the runner sent (`` `x` is no
 * automation's name. ``), never more than that cut of it.
 */
export function refusalOf(runId: string, problems: readonly RunProblem[]): RunRefused {
  const kept = problems.slice(0, RUN_PROBLEMS_MAX).map(({ field, message }) => ({
    field: cut(field, RUN_PROBLEM_TEXT_MAX) || 'run',
    message: cut(message, RUN_PROBLEM_TEXT_MAX) || REFUSED,
  }));
  return {
    type: 'run.refused',
    runId,
    problems: kept.length > 0 ? kept : [{ field: 'run', message: REFUSED }],
  };
}

/** Where a page of the list ends: the last run's creation time and id. */
export type RunCursor = { readonly createdAt: string; readonly id: string };

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** The cursor as the list hands it out: base64url of `[createdAt, id]`, both ASCII. */
export function encodeCursor(cursor: RunCursor): string {
  return btoa(JSON.stringify([cursor.createdAt, cursor.id]))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

/** A cursor `encodeCursor` made, or null for anything else. */
export function decodeCursor(text: string): RunCursor | null {
  if (text.length > 512 || !BASE64URL.test(text)) return null;
  let value: unknown;
  try {
    value = JSON.parse(atob(text.replaceAll('-', '+').replaceAll('_', '/')));
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [createdAt, id] = value;
  if (typeof createdAt !== 'string' || typeof id !== 'string') return null;
  if (!isTime(createdAt) || !RUN_ID_PATTERN.test(id)) return null;
  return { createdAt, id };
}
