import {
  evaluateExpression,
  type Expr,
  expressionPaths,
  parseExpression,
  parseReadRef,
  templatePaths,
  type ExprValue,
  type Step,
  type StepRun,
  type StepRunStatus,
} from '@consola/factory-spec';

/*
 * What a steps run does next, decided from its record alone. Pure: it reads
 * no file, starts nothing and knows no clock, so the same record always gets
 * the same answer. `AutomationService` applies the answer and persists each
 * transition before the next step starts.
 */

export type Lane = 'agent' | 'command';

export function laneOf(step: Step): Lane {
  return step.kind === 'agent' ? 'agent' : 'command';
}

export interface StepUpdate {
  id: string;
  status: 'skipped' | 'failed' | 'not-run';
  skipped?: string;
  error?: string;
}

export type Advance =
  | { kind: 'wait' }
  | { kind: 'start'; stepId: string; lane: Lane; updates: StepUpdate[] }
  | { kind: 'complete'; summary: string; updates: StepUpdate[] }
  | { kind: 'fail'; stepId: string; error: string; updates: StepUpdate[] };

const DRY_RUN_REASON = 'dry run: ';

const own = (object: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(object, key);

/** A value a step's record holds, by path; `undefined` when it holds none. */
function recorded(record: StepRun | undefined, name: string, file: boolean): ExprValue | undefined {
  if (record?.status !== 'completed') return undefined;
  const hasArtifact = (record.artifacts ?? []).some((artifact) => artifact.name === name);
  if (file) return hasArtifact ? name : undefined;
  if (record.outputs && own(record.outputs, name)) return record.outputs[name];
  return hasArtifact ? name : undefined;
}

/**
 * The word a producer's record gives for why it has no value. Only the states
 * a dependent can meet are named: a failed or stopped producer fails the run
 * before any dependent is considered.
 */
function whyNothing(record: StepRun | undefined): string {
  switch (record?.status) {
    case 'skipped':
      return 'skipped';
    case 'completed':
      return 'completed without it';
    default:
      return 'not run';
  }
}

function noValue(path: string, producer: string, record: StepRun | undefined): string {
  const why = whyNothing(record);
  return `${path} has no value: ${producer} ${why === 'completed without it' ? why : `was ${why}`}`;
}

/** A producer that a dry run left unrun, or one that was skipped because one was. */
function leftUnrunByDryRun(record: StepRun | undefined): boolean {
  return (
    record?.status === 'reported' ||
    (record?.status === 'skipped' && !!record.skipped?.startsWith(DRY_RUN_REASON))
  );
}

const dryRunReason = (producer: string) => `${DRY_RUN_REASON}\`${producer}\` was not run`;

interface Reference {
  path: string;
  step: string;
  /** The artifact or output named; absent for a `reads:` entry, which needs only its producer. */
  name?: string;
  file?: boolean;
}

/**
 * What a pending step needs: its `if:`'s step outputs, its `reads:`, and the
 * paths its templates fill. Item fields in an `if:` are the evaluator's to ask
 * for. A `previous` read or path is never a dependency (Call 5): an earlier
 * run's document is read, or absent, when the step runs.
 */
function dependenciesOf(
  step: Step,
  condition: Expr | undefined,
): { conditions: Reference[]; reads: Reference[]; templates: Reference[]; item: string[] } {
  const conditions: Reference[] = [];
  const item: string[] = [];
  if (condition) {
    for (const path of expressionPaths(condition)) {
      if (path.kind === 'output')
        conditions.push({ path: path.text, step: path.step, name: path.output });
    }
  }
  const reads: Reference[] = [];
  if (step.kind === 'agent') {
    for (const entry of step.reads) {
      const ref = parseReadRef(entry);
      // Validation kept only entries of either shape; one that is neither names no step of this run.
      if (ref && !ref.previous) reads.push({ path: entry, step: ref.step });
    }
  }
  const texts =
    step.kind === 'agent'
      ? step.prompt === undefined
        ? []
        : [step.prompt]
      : Object.values(step.env);
  const templates: Reference[] = [];
  for (const text of texts) {
    for (const path of templatePaths(text)) {
      switch (path.root) {
        case 'steps':
          templates.push({ path: path.text, step: path.step, name: path.name, file: path.file });
          break;
        case 'item':
          item.push(path.field);
          break;
        case 'previous':
          break;
      }
    }
  }
  return { conditions, reads, templates, item };
}

/** A value's type as a skip names it: "a string", "a number", "true or false". */
function typeWord(value: ExprValue): string {
  return typeof value === 'boolean' ? 'true or false' : `a ${typeof value}`;
}

/**
 * Why an `if:` over an untyped item (a poll's fields, which validation types
 * as `unknown`) skips its step, or undefined when it can be evaluated: a field
 * it names is absent, or is of another type than the literal it is compared
 * with. Like a step output that did not complete, every field it names counts,
 * whichever side of an `||` it is on. Validation lets an item field appear
 * only compared with a literal.
 */
function untypedItemSkip(
  expr: Expr,
  itemValue: ((field: string) => ExprValue | undefined) | undefined,
): string | undefined {
  switch (expr.kind) {
    case 'item':
      return itemValue?.(expr.field) === undefined ? `if: item.${expr.field} is absent` : undefined;
    case 'output':
    case 'literal':
      return undefined;
    case 'not':
      return untypedItemSkip(expr.operand, itemValue);
    case 'and':
    case 'or':
      return untypedItemSkip(expr.left, itemValue) ?? untypedItemSkip(expr.right, itemValue);
    case 'compare': {
      const absent =
        untypedItemSkip(expr.left, itemValue) ?? untypedItemSkip(expr.right, itemValue);
      if (absent) return absent;
      const field =
        expr.left.kind === 'item' ? expr.left : expr.right.kind === 'item' ? expr.right : undefined;
      const literal = field === expr.left ? expr.right : expr.left;
      if (!field || literal.kind !== 'literal') return undefined;
      const value = itemValue?.(field.field);
      if (value === undefined || typeof value === typeof literal.value) return undefined;
      return `if: item.${field.field} is ${typeWord(value)}, not ${typeWord(literal.value)}`;
    }
  }
}

/**
 * The run's next move. `itemValue` reads the run's item; `untypedItem` says
 * its fields have no declared types (a poll's), so an `if:` over one that is
 * absent, or of another type than its literal, skips the step rather than
 * failing the run. A typed item's absent field fails it.
 */
export function advanceSteps(input: {
  steps: Step[];
  records: StepRun[];
  dryRun: boolean;
  itemValue?: (field: string) => ExprValue | undefined;
  untypedItem?: boolean;
}): Advance {
  const { steps, dryRun, itemValue, untypedItem } = input;
  if (input.records.some((record) => record.status === 'queued' || record.status === 'running'))
    return { kind: 'wait' };

  const failed = input.records.find((record) => record.status === 'failed');
  if (failed) {
    return {
      kind: 'fail',
      stepId: failed.id,
      error: failed.error ?? 'failed',
      updates: notRunAfter(steps, input.records, failed.id),
    };
  }

  // Updates made in this call are visible to the steps after them.
  const now = new Map(input.records.map((record) => [record.id, { ...record }]));
  const updates: StepUpdate[] = [];
  const settled = () => steps.flatMap((step) => now.get(step.id) ?? []);

  for (const step of steps) {
    const mine = now.get(step.id);
    if (mine?.status !== 'pending') continue;

    const skip = (reason: string): void => {
      mine.status = 'skipped';
      mine.skipped = reason;
      updates.push({ id: step.id, status: 'skipped', skipped: reason });
    };
    let condition: Expr | undefined;
    if (step.if !== undefined) {
      const parsed = parseExpression(step.if);
      if (!parsed.ok)
        return failStep(step.id, `if: ${step.if} could not be read: ${parsed.problem}`);
      condition = parsed.expr;
    }
    const deps = dependenciesOf(step, condition);

    // A dependency that did not complete skips the step; `if:` is not evaluated.
    const missed = [...deps.conditions, ...deps.reads].find(
      (ref) => now.get(ref.step)?.status !== 'completed',
    );
    if (missed) {
      const producer = now.get(missed.step);
      skip(
        dryRun && leftUnrunByDryRun(producer)
          ? dryRunReason(missed.step)
          : noValue(missed.path, missed.step, producer),
      );
      continue;
    }
    const absentCondition = deps.conditions.find(
      (ref) => recorded(now.get(ref.step), ref.name ?? '', false) === undefined,
    );
    if (absentCondition) {
      skip(noValue(absentCondition.path, absentCondition.step, now.get(absentCondition.step)));
      continue;
    }

    if (condition) {
      const untyped = untypedItem ? untypedItemSkip(condition, itemValue) : undefined;
      if (untyped) {
        skip(untyped);
        continue;
      }
      const verdict = evaluateExpression(condition, (path) =>
        path.kind === 'output'
          ? recorded(now.get(path.step), path.output, false)
          : itemValue?.(path.field),
      );
      if (!verdict.ok) {
        return failStep(
          step.id,
          `${verdict.missing.text} has no value: this run has no such item field`,
        );
      }
      if (!verdict.value) {
        skip(`if: ${step.if} is false`);
        continue;
      }
    }

    const lacking = deps.templates.find(
      (ref) => recorded(now.get(ref.step), ref.name ?? '', ref.file === true) === undefined,
    );
    if (lacking) {
      const producer = now.get(lacking.step);
      if (dryRun && leftUnrunByDryRun(producer)) {
        skip(dryRunReason(lacking.step));
        continue;
      }
      return failStep(step.id, noValue(lacking.path, lacking.step, producer));
    }
    const itemMissing = deps.item.find((field) => itemValue?.(field) === undefined);
    if (itemMissing !== undefined) {
      return failStep(step.id, `item.${itemMissing} has no value: this run has no such item field`);
    }

    return { kind: 'start', stepId: step.id, lane: laneOf(step), updates };
  }

  return { kind: 'complete', summary: runSummary(steps, settled()), updates };

  function failStep(stepId: string, error: string): Advance {
    const later = notRunAfter(steps, settled(), stepId);
    return {
      kind: 'fail',
      stepId,
      error,
      updates: [...updates, { id: stepId, status: 'failed', error }, ...later],
    };
  }
}

/** `not-run` for every step after `stepId` that has not settled. */
export function notRunAfter(steps: Step[], records: StepRun[], stepId: string): StepUpdate[] {
  const from = steps.findIndex((step) => step.id === stepId);
  if (from === -1) return [];
  const open: StepRunStatus[] = ['pending', 'queued'];
  return steps
    .slice(from + 1)
    .filter((step) =>
      open.includes(records.find((record) => record.id === step.id)?.status as StepRunStatus),
    )
    .map((step) => ({ id: step.id, status: 'not-run' as const }));
}

/** "a", "a and b", "a, b and c". */
export const joinNames = (names: string[]): string =>
  names.length < 2
    ? names.join('')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** "fresh → review → publish (request-changes)", then what a dry run left unrun and what was skipped. */
export function runSummary(steps: Step[], records: StepRun[]): string {
  const byId = new Map(records.map((record) => [record.id, record]));
  const named = (status: StepRunStatus) =>
    steps.filter((step) => byId.get(step.id)?.status === status);
  const completed = named('completed');

  const verdicts: string[] = [];
  for (const step of completed) {
    const outputs = byId.get(step.id)?.outputs ?? {};
    for (const [name, type] of Object.entries(step.outputs)) {
      if (type.type === 'enum' && own(outputs, name)) verdicts.push(String(outputs[name]));
    }
  }

  let summary = completed.map((step) => step.id).join(' → ');
  if (verdicts.length > 0) summary += ` (${verdicts.join(', ')})`;
  const reported = named('reported').map((step) => step.id);
  if (reported.length > 0) summary += `${summary ? '; ' : ''}${joinNames(reported)} would have run`;
  const skipped = named('skipped').map((step) => step.id);
  if (skipped.length > 0) summary += `${summary ? '; ' : ''}${joinNames(skipped)} skipped`;
  return summary;
}
