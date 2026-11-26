import { stepRecordsOf } from '@consola/automation-engine/core';
import { isStepsEntry, leafSteps } from '@consola/factory-spec';
import type {
  RunRecord as EngineRun,
  RunItem as EngineItem,
  FactoryParseResult,
  StepRun,
  StepsAutomation,
} from '@consola/factory-spec';
import { OUTPUT_TAIL_MAX, SOCKET_FRAME_MAX_BYTES } from '@consola/runner-protocol';
import type {
  PullRequestFacts,
  RunItem,
  RunRecord,
  RunStatus,
  StepRecord,
} from '@consola/runner-protocol';
import type { OutputTail } from '../steps/ports.ts';

/**
 * A run as the ring holds it in this process, and the record it sends the cell. The walk works on
 * the engine's own record (`EngineRun`, factory-spec's), so the engine's functions read and change
 * it as they do on the desktop; `recordOf` maps it onto the protocol's `RunRecord`, the cell's
 * `RunWrite`, which is what crosses the socket. Pure.
 *
 * What a restarted runner needs to rebuild a run lives in the record: its factory and version
 * (`factoryId`, `factoryVersion`), its automation (`automation`), the event (`triggerDetail`), and
 * its pull request (`item`: `url`, `title`, `repo`, `number`, and the commit it read, `headSha`,
 * and its base branch, `baseRef`). The author is not in a record, so the engine's item never
 * carries one, whether or not the runner restarted: a step's fence then shows the title alone.
 */
export type RunState = {
  readonly factory: { readonly id: string; readonly version: number };
  readonly automation: StepsAutomation;
  /** Its factory as parsed at that version: the agents its steps name. */
  readonly parsed: FactoryParseResult;
  readonly item: RunItem;
  /** `pull_request.opened`. */
  readonly triggerDetail: string;
  /** The engine's record: its steps, status, summary, error, cost and times. */
  engine: EngineRun;
  /** The end of what each step's latest attempt printed, by step id. */
  readonly tails: Map<string, OutputTail>;
};

/** A pull request's run id: derived from the delivery, the factory and the automation, so an event delivered twice records one run. */
export function runIdOf(
  digest: (text: string) => string,
  deliveryId: string,
  factoryId: string,
  automation: string,
): string {
  return `run-${digest(JSON.stringify(['github.event', deliveryId, factoryId, automation])).slice(0, 32)}`;
}

/** The protocol's item for a pull request event: what its record carries of it, and all a rebuild reads. */
export function itemOfEvent(event: PullRequestFacts): RunItem {
  return {
    url: event.url,
    title: event.title,
    kind: 'pr',
    repo: event.repository,
    number: event.number,
    headSha: event.headSha,
    baseRef: event.baseRef,
  };
}

/** The engine's item, from the record's alone (`github:<repo>:pr:<n>`, the Inbox's key). */
function engineItemOf(item: RunItem): EngineItem {
  return {
    key: `github:${item.repo ?? ''}:pr:${item.number ?? 0}`,
    url: item.url,
    title: item.title,
    ...(item.repo !== null ? { repo: item.repo } : {}),
    ...(item.number !== null ? { number: item.number } : {}),
    type: item.kind === 'issue' ? 'issue' : 'pr',
  };
}

/** A new run of `automation`, in `status`, with the engine's fresh records for its steps. */
export function newRunState(input: {
  readonly id: string;
  readonly factory: { readonly id: string; readonly version: number };
  readonly automation: StepsAutomation;
  readonly parsed: FactoryParseResult;
  readonly item: RunItem;
  readonly triggerDetail: string;
  readonly status: Extract<RunStatus, 'needs-approval' | 'running'>;
  readonly createdAt: string;
  readonly now: string;
}): RunState {
  const { automation, item, triggerDetail, now } = input;
  const engine: EngineRun = {
    id: input.id,
    runner: 'cloud',
    source: 'org',
    automationId: automation.name,
    actionName: 'steps',
    actionVersion: String(input.factory.version),
    mode: automation.mode,
    trigger: {
      kind: 'event',
      at: input.createdAt,
      connection: 'github',
      events: [triggerDetail],
      item: engineItemOf(item),
    },
    status: input.status,
    steps: stepRecordsOf(automation.steps),
    // The commit its command steps name (`CONSOLA_CHECKOUT_HEAD`), as an item's checkout records it.
    checkout: {
      cwd: '',
      kind: 'item',
      ...(item.headSha !== null ? { head: item.headSha } : {}),
      ...(item.repo !== null ? { repo: item.repo } : {}),
    },
    attribution: { automationId: automation.name, actionName: 'steps', triggerKind: 'event' },
    createdAt: input.createdAt,
    updatedAt: now,
    ...(input.status === 'running' ? { startedAt: now } : {}),
  };
  return {
    factory: input.factory,
    automation,
    parsed: input.parsed,
    item,
    triggerDetail,
    engine,
    tails: new Map(),
  };
}

/** The protocol's step kinds: an agent step and a command step. A loop's own row, a gate and a call have none. */
const recorded = (record: StepRun): record is StepRun & { kind: 'agent' | 'run' } =>
  record.kind === 'agent' || record.kind === 'run';

/**
 * A run approved on the web, from the record the cell stored and its factory at the record's
 * version: running from `now`, its steps the engine's fresh records. A record whose automation
 * that version no longer holds, or whose steps are not that automation's, is refused in a
 * sentence.
 */
export function rebuildRunState(
  record: RunRecord,
  parsed: FactoryParseResult,
  now: string,
):
  | { readonly ok: true; readonly state: RunState }
  | { readonly ok: false; readonly error: string } {
  const version = `version ${record.factoryVersion} of its factory`;
  const automation = parsed.automations.find((candidate) => candidate.name === record.automation);
  if (automation === undefined || !isStepsEntry(automation)) {
    return { ok: false, error: `Its automation \`${record.automation}\` is not in ${version}.` };
  }
  if (record.item === null || record.triggerDetail === null) {
    return {
      ok: false,
      error: 'Its record names no pull request event, so there is nothing to run it on.',
    };
  }
  const state = newRunState({
    id: record.id,
    factory: { id: record.factoryId, version: record.factoryVersion },
    automation,
    parsed,
    item: record.item,
    triggerDetail: record.triggerDetail,
    status: 'running',
    createdAt: record.createdAt,
    now,
  });
  const expected = (state.engine.steps ?? []).filter(recorded).map((step) => step.id);
  const named = record.steps.map((step) => step.id);
  if (expected.join('\n') !== named.join('\n')) {
    return { ok: false, error: `Its steps are not those of \`${automation.name}\` in ${version}.` };
  }
  return { ok: true, state };
}

/** The agent a step names, by its id, as its factory parsed it. */
function agentOf(state: RunState, stepId: string): { name: string; model: string | null } | null {
  const step = leafSteps(state.automation.steps).find((candidate) => candidate.id === stepId);
  if (step?.kind !== 'agent' || step.agent === undefined) return null;
  const agent = state.parsed.agents[step.agent];
  return { name: step.agent, model: agent?.model ?? null };
}

const UTF8 = new TextEncoder();
const bytesOf = (text: string): number => UTF8.encode(text).length;
const NEWLINE = 0x0a;

/**
 * The end of `text` that fits in `max` bytes of UTF-8: all of it when it fits, else its last
 * whole lines that do (its last `max` bytes, when no line ends in them), the cell's `tailOf` rule.
 */
export function tailWithin(text: string, max: number): { text: string; cut: boolean } {
  const bytes = UTF8.encode(text);
  if (bytes.length <= max) return { text, cut: false };
  if (max <= 0) return { text: '', cut: true };
  const from = bytes.length - max;
  const end = new TextDecoder().decode(bytes.subarray(from));
  if (bytes[from - 1] === NEWLINE) return { text: end, cut: true };
  const newline = end.indexOf('\n');
  const kept = newline === -1 ? end.replace(/^�+/, '') : end.slice(newline + 1);
  return { text: kept, cut: true };
}

/** A step's output, each stream cut to `max` bytes; `truncated` once either was cut, or already was. */
function outputWithin(tail: OutputTail, max: number): OutputTail {
  const stdout = tailWithin(tail.stdout, max);
  const stderr = tailWithin(tail.stderr, max);
  return {
    stdout: stdout.text,
    stderr: stderr.text,
    truncated: tail.truncated || stdout.cut || stderr.cut,
  };
}

function stepRecordOf(state: RunState, run: StepRun & { kind: 'agent' | 'run' }): StepRecord {
  const agent = run.kind === 'agent' ? agentOf(state, run.id) : null;
  const tail = state.tails.get(run.id);
  const command = run.command;
  const ran =
    command !== undefined &&
    (command.exitCode !== undefined ||
      command.signal !== undefined ||
      command.stdoutBytes !== undefined);
  return {
    id: run.id,
    kind: run.kind,
    status: run.status,
    attempt: run.attempt,
    agent: run.agent ?? agent?.name ?? null,
    model: run.model ?? agent?.model ?? null,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
    costUsd: run.turn?.costUsd ?? null,
    error: run.error ?? null,
    skipped: run.skipped ?? null,
    outputs: run.outputs !== undefined ? { ...run.outputs } : null,
    artifacts: (run.artifacts ?? []).map(({ name, bytes }) => ({ name, bytes })),
    turn:
      run.kind === 'agent' && run.turn !== undefined
        ? {
            turns: run.turn.turns ?? null,
            maxTurns: run.turn.maxTurns ?? null,
            deniedTools: [...(run.turn.deniedTools ?? [])],
          }
        : null,
    command:
      ran && command !== undefined
        ? {
            exitCode: command.exitCode ?? null,
            signal: command.signal ?? null,
            stdoutBytes: command.stdoutBytes ?? null,
            stderrBytes: command.stderrBytes ?? null,
            truncated: command.truncated ?? false,
          }
        : null,
    previous: (run.previous ?? []).map((earlier) => ({
      attempt: earlier.attempt,
      status: earlier.status,
      error: earlier.error ?? null,
      finishedAt: earlier.finishedAt ?? null,
      costUsd: earlier.costUsd ?? null,
      turns: earlier.turns ?? null,
    })),
    reminded: run.reminded ?? false,
    output: tail === undefined ? null : outputWithin(tail, OUTPUT_TAIL_MAX),
  };
}

/**
 * The run as the protocol records it: its agent and command steps in record order (a loop's own
 * row, a gate and a call have no step kind in the cell's vocabulary yet, so the run's status,
 * `waitingOn` and error say what they hold), each output tail cut to `OUTPUT_TAIL_MAX` bytes.
 */
export function recordOf(state: RunState): RunRecord {
  const { engine } = state;
  return {
    id: engine.id,
    factoryId: state.factory.id,
    factoryVersion: state.factory.version,
    parent: null,
    automation: state.automation.name,
    status: engine.status,
    waitingOn: engine.status === 'waiting' ? 'person' : null,
    trigger: 'event',
    triggerDetail: state.triggerDetail,
    startedBy: null,
    item: state.item,
    runner: 'cloud',
    steps: (engine.steps ?? []).filter(recorded).map((step) => stepRecordOf(state, step)),
    request: null,
    summary: engine.summary ?? null,
    error: engine.error ?? null,
    costUsd: engine.costUsd ?? null,
    createdAt: engine.createdAt,
    startedAt: engine.startedAt ?? null,
    finishedAt: engine.finishedAt ?? null,
    updatedAt: engine.updatedAt,
  };
}

/** How many bytes a record takes on the socket, as `run.record`. */
export const frameBytesOf = (run: RunRecord): number =>
  bytesOf(JSON.stringify({ type: 'run.record', run }));

/**
 * `run` within the socket's frame cap (`SOCKET_FRAME_MAX_BYTES`, or `max`): as it is when it fits,
 * else with every step's output cut to what fits beside the rest, else with no output at all;
 * null when even that does not fit, which the ring fails the run on.
 */
export function withinFrame(
  run: RunRecord,
  max: number = SOCKET_FRAME_MAX_BYTES,
): RunRecord | null {
  if (frameBytesOf(run) <= max) return run;
  const bare: RunRecord = { ...run, steps: run.steps.map((step) => ({ ...step, output: null })) };
  const rest = frameBytesOf(bare);
  if (rest > max) return null;
  const streams = run.steps.filter((step) => step.output !== null).length * 2;
  // Each stream's share of what is left, less room for the quotes and escapes JSON adds.
  const share = Math.floor((max - rest) / Math.max(streams, 1) / 2);
  const cut: RunRecord = {
    ...run,
    steps: run.steps.map((step) =>
      step.output === null ? step : { ...step, output: outputWithin(step.output, share) },
    ),
  };
  return frameBytesOf(cut) <= max ? cut : bare;
}

/**
 * The least a record says of its steps: each one's id, kind, status and attempt, and nothing it
 * printed, produced or said. What the ring sends of a run whose record cannot fit the socket's
 * frame even with no output, once it has failed the run for it.
 */
export function strippedRecordOf(run: RunRecord): RunRecord {
  return {
    ...run,
    steps: run.steps.map((step) => ({
      ...step,
      error: null,
      skipped: null,
      outputs: null,
      artifacts: [],
      turn: null,
      command: null,
      previous: [],
      output: null,
    })),
  };
}

/**
 * A record the ring ends without walking it (a refusal of its approval, a factory version gone):
 * every step it had not reached `not-run`, as the engine's `closeSteps` ends a run.
 */
export function endedRecordOf(
  record: RunRecord,
  end: { readonly status: 'failed'; readonly error: string } | { readonly status: 'rejected' },
  now: string,
): RunRecord {
  return {
    ...record,
    status: end.status,
    waitingOn: null,
    error: end.status === 'failed' ? end.error : record.error,
    steps: record.steps.map((step) =>
      step.status === 'pending' || step.status === 'queued' ? { ...step, status: 'not-run' } : step,
    ),
    finishedAt: now,
    updatedAt: now,
  };
}
