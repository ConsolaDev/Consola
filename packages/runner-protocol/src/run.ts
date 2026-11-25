import { GIT_REF_MAX } from './github.js';
import {
  boolean,
  isTextUpTo,
  listOf,
  mapOf,
  nullable,
  number,
  objectOf,
  oneOf,
  type Reader,
  type ReadResult,
  readerOf,
  text,
} from './read.js';

/**
 * A run, as a runner records it into its cell (`run.record`) and the cell hands it back
 * (`run.answered`): the one wire definition of a run. Its shape is the cell's `RunWrite`
 * (`apps/cloud-region/src/domain/run.ts`), field for field.
 *
 * A run is one of two kinds: a **request**, whose one step is its factory's orchestrator, started
 * by a person with text; and an **automation run**, with steps, started by a trigger, a person or
 * a request (a child, whose `parent` names the request).
 *
 * `readRunRecord` checks the shape alone: every field present and of its type, every word one of
 * its vocabulary, no field the protocol does not name, and every list bounded. It also checks an
 * item's `headSha` (40 lowercase hex) and `baseRef` (1 to `GIT_REF_MAX` characters), which a
 * runner that restarted rebuilds the run's checkout from. What a record means (which combinations hold, ids and times in their form, sizes in bytes) is the cell's
 * `checkRun`, which refuses a record with `run.refused` and every problem named.
 */

/** The run statuses: the engine's, and the ones slices 4 and 6b add. The set only grows. */
export const RUN_STATUSES = [
  'queued',
  'running',
  'needs-approval',
  'completed',
  'failed',
  'rejected',
  'waiting',
  'expired',
  'cancelled',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** How a run was started: a schedule, an event, a poll's check, or someone's act. */
export const RUN_TRIGGERS = ['cron', 'event', 'poll', 'manual'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

/** What a waiting run waits on: its open child, or a person's answer. */
export const WAITING_ON = ['run', 'person'] as const;
export type WaitingOn = (typeof WAITING_ON)[number];

export const STEP_KINDS = ['agent', 'run', 'orchestrator'] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/** A step's statuses: the engine's, and `waiting`, a step parked on a gate or a child. */
export const STEP_STATUSES = [
  'pending',
  'queued',
  'running',
  'completed',
  'failed',
  'skipped',
  'reported',
  'not-run',
  'waiting',
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const ITEM_KINDS = ['pr', 'issue'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/**
 * The most of each of a step's stdout and stderr the cell keeps: the end of it, in UTF-8 bytes. A
 * runner sends at most this much of each (its last whole lines); the cell's check refuses more.
 */
export const OUTPUT_TAIL_MAX = 16 * 1024;

/** The longest a request's text may be, in bytes of UTF-8; the cell's check refuses more. */
export const REQUEST_TEXT_MAX_BYTES = 64 * 1024;

/** The most steps a record holds. An automation has at most 20 (factory-spec's `MAX_STEPS`). */
export const RUN_STEPS_MAX = 256;

/** The most outputs a step's record holds. A step declares at most 10 (`MAX_OUTPUTS`). */
export const STEP_OUTPUTS_MAX = 64;

/** The most documents a step's record lists. */
export const STEP_ARTIFACTS_MAX = 256;

/** The most refused tools a step's turn lists. */
export const STEP_DENIED_TOOLS_MAX = 256;

/** The most earlier attempts a step's record lists. */
export const STEP_PREVIOUS_MAX = 256;

/** The item a run is about: a pull request or an issue, as its runner saw it. */
export type RunItem = {
  /** Its page: an https address, never another scheme. */
  readonly url: string;
  /** Author-controlled: shown as text, never as markup. */
  readonly title: string;
  readonly kind: ItemKind | null;
  readonly repo: string | null;
  readonly number: number | null;
  /** A pull request's head commit when the run was recorded, which is the commit the run reads: 40 lowercase hex. Null for anything else. */
  readonly headSha: string | null;
  /** A pull request's base branch. Null for anything else. */
  readonly baseRef: string | null;
};

/** A value a step's outputs hold: validated against its declared type by the runner. */
export type OutputValue = string | number | boolean;

/** An earlier attempt of a step, in the same run. */
export type PreviousAttempt = {
  readonly attempt: number;
  readonly status: StepStatus;
  readonly error: string | null;
  readonly finishedAt: string | null;
  readonly costUsd: number | null;
  readonly turns: number | null;
};

/**
 * One step of a run, as its runner records it: the engine's `StepRun` (factory-spec), as much of
 * it as the web shows, and the end of what it printed.
 */
export type StepRecord = {
  /** The step's id in its automation, or `orchestrator`, a request's one step. */
  readonly id: string;
  readonly kind: StepKind;
  readonly status: StepStatus;
  /** From 1: the nth time this step ran in this run. */
  readonly attempt: number;
  /** The agent file's name (`agents/<name>.md`), when the step names one. */
  readonly agent: string | null;
  readonly model: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly costUsd: number | null;
  readonly error: string | null;
  /** Why it was skipped. */
  readonly skipped: string | null;
  /** The latest execution's validated outputs. */
  readonly outputs: Record<string, OutputValue> | null;
  /** The documents it wrote, by name, and their size. */
  readonly artifacts: { readonly name: string; readonly bytes: number }[];
  /** An agent step's turns over its latest attempt: how many, its cap, the tools refused. */
  readonly turn: {
    readonly turns: number | null;
    readonly maxTurns: number | null;
    readonly deniedTools: string[];
  } | null;
  /** A command step's result. */
  readonly command: {
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly stdoutBytes: number | null;
    readonly stderrBytes: number | null;
    readonly truncated: boolean;
  } | null;
  /** Earlier attempts, oldest first. */
  readonly previous: PreviousAttempt[];
  /** Whether Consola reminded the agent to finish its step. */
  readonly reminded: boolean;
  /**
   * The end of what its latest attempt printed, as the runner last sent it: at most
   * `OUTPUT_TAIL_MAX` bytes of each, `truncated` when more came before. Untrusted text.
   */
  readonly output: {
    readonly stdout: string;
    readonly stderr: string;
    readonly truncated: boolean;
  } | null;
};

/** What a request spent or may spend: dollars, by the CLI's estimate, and runs started. */
export type Spend = { readonly usd: number; readonly runs: number };

/** A request's own facts. Its text lives beside them (`RunRecord.request.text`). */
export type RequestFacts = {
  readonly budget: Spend | null;
  /** Its turns and its children's runs, as the engine sums them. */
  readonly spent: Spend;
  /** The orchestrator's open question, while one is open: when it was asked, and its deadline. */
  readonly question: { readonly at: string; readonly until: string } | null;
};

/** On a run a request started: the request, and which of its moves started it. */
export type RunParent = { readonly runId: string; readonly move: number };

/**
 * A run as a runner records it: everything the cell keeps of it. The run's id is the runner's,
 * and a record of an id the workspace already holds replaces it, unless it is older.
 */
export type RunRecord = {
  readonly id: string;
  /** The factory it belongs to, and the version of it that it ran. */
  readonly factoryId: string;
  readonly factoryVersion: number;
  readonly parent: RunParent | null;
  /** The automation's name; null exactly for a request. */
  readonly automation: string | null;
  readonly status: RunStatus;
  readonly waitingOn: WaitingOn | null;
  readonly trigger: RunTrigger;
  /** The event's name, the cron schedule or the poll's check: what the trigger was. */
  readonly triggerDetail: string | null;
  /** The global id of the person who started it, for a run a person started. */
  readonly startedBy: string | null;
  readonly item: RunItem | null;
  /** Which runner ran it: `cloud` for now; the set grows. */
  readonly runner: string;
  /** An automation run's steps in file order; a request's one `orchestrator` step. */
  readonly steps: readonly StepRecord[];
  /** A request's text and facts; null exactly for an automation run. */
  readonly request: (RequestFacts & { readonly text: string }) | null;
  /** One human sentence once it ends. */
  readonly summary: string | null;
  readonly error: string | null;
  /** The CLI's estimate, summed; a request's is its `spent.usd`. Null while none was reported. */
  readonly costUsd: number | null;
  /** ISO 8601 times, to the millisecond at most, with their offset. */
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  /** When the runner last changed it: an older record never replaces a newer one. */
  readonly updatedAt: string;
};

const outputValue: Reader<OutputValue> = readerOf(
  (value: unknown): value is OutputValue =>
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)),
  'text, a number or true or false',
);

const stepStatus = oneOf(STEP_STATUSES, 'a step status');

/** A commit's id: 40 lowercase hex digits. */
const SHA = /^[0-9a-f]{40}$/;

const readPrevious = objectOf<PreviousAttempt>({
  attempt: number,
  status: stepStatus,
  error: nullable(text),
  finishedAt: nullable(text),
  costUsd: nullable(number),
  turns: nullable(number),
});

const readStep = objectOf<StepRecord>({
  id: text,
  kind: oneOf(STEP_KINDS, 'a step kind'),
  status: stepStatus,
  attempt: number,
  agent: nullable(text),
  model: nullable(text),
  startedAt: nullable(text),
  finishedAt: nullable(text),
  costUsd: nullable(number),
  error: nullable(text),
  skipped: nullable(text),
  outputs: nullable(mapOf(outputValue, STEP_OUTPUTS_MAX)),
  artifacts: listOf(objectOf({ name: text, bytes: number }), STEP_ARTIFACTS_MAX),
  turn: nullable(
    objectOf({
      turns: nullable(number),
      maxTurns: nullable(number),
      deniedTools: listOf(text, STEP_DENIED_TOOLS_MAX),
    }),
  ),
  command: nullable(
    objectOf({
      exitCode: nullable(number),
      signal: nullable(text),
      stdoutBytes: nullable(number),
      stderrBytes: nullable(number),
      truncated: boolean,
    }),
  ),
  previous: listOf(readPrevious, STEP_PREVIOUS_MAX),
  reminded: boolean,
  output: nullable(objectOf({ stdout: text, stderr: text, truncated: boolean })),
});

const readSpend = objectOf<Spend>({ usd: number, runs: number });

const readRun = objectOf<RunRecord>({
  id: text,
  factoryId: text,
  factoryVersion: number,
  parent: nullable(objectOf<RunParent>({ runId: text, move: number })),
  automation: nullable(text),
  status: oneOf(RUN_STATUSES, 'a run status'),
  waitingOn: nullable(oneOf(WAITING_ON, 'what a run waits on')),
  trigger: oneOf(RUN_TRIGGERS, 'a trigger'),
  triggerDetail: nullable(text),
  startedBy: nullable(text),
  item: nullable(
    objectOf<RunItem>({
      url: text,
      title: text,
      kind: nullable(oneOf(ITEM_KINDS, 'an item kind')),
      repo: nullable(text),
      number: nullable(number),
      headSha: nullable(
        readerOf(
          (value: unknown): value is string => typeof value === 'string' && SHA.test(value),
          "a commit's 40 lowercase hex digits",
        ),
      ),
      baseRef: nullable(
        readerOf(
          (value: unknown): value is string => isTextUpTo(value, GIT_REF_MAX),
          `a branch's name of at most ${GIT_REF_MAX} characters`,
        ),
      ),
    }),
  ),
  runner: text,
  steps: listOf(readStep, RUN_STEPS_MAX),
  request: nullable(
    objectOf<RequestFacts & { readonly text: string }>({
      budget: nullable(readSpend),
      spent: readSpend,
      question: nullable(objectOf({ at: text, until: text })),
      text,
    }),
  ),
  summary: nullable(text),
  error: nullable(text),
  costUsd: nullable(number),
  createdAt: text,
  startedAt: nullable(text),
  finishedAt: nullable(text),
  updatedAt: text,
});

/**
 * Reads a run record's shape (above). A reason names the field (`run.steps[2].status`), never what
 * it held. `at` names where the record sits in its message.
 */
export function readRunRecord(json: unknown, at = 'run'): ReadResult<RunRecord> {
  return readRun(json, at);
}
