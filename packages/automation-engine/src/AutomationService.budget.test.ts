import { describe, expect, it } from 'vitest';
import { automationVersion, leafSteps, parseFactorySpec } from '@consola/factory-spec';
import type { RunRecord, StepRun } from '@consola/factory-spec';
import { stepsHarness, turnReport, WORKSPACE_ID } from './steps/steps.test-helpers';
import type { StepsHarness, StepsHarnessOptions } from './steps/steps.test-helpers';

/** One `- name:` entry: its head lines as given, then `steps:` with each item's lines. */
function entry(name: string, head: string, ...steps: string[]): string {
  const items = steps.map((step) => `      ${step.replace(/\n/g, '\n      ')}`).join('\n');
  return `  - name: ${name}\n${head}    steps:\n${items}\n`;
}
const file = (...entries: string[]) => `version: 1\nautomations:\n${entries.join('')}`;

const MANUAL = '    on: manual\n    scope: catalog-portal\n    mode: auto\n';
const BUDGET = (usd: number) => `    budget: { usd: ${usd} }\n`;

/** A loop's steps, indented under its `steps:`. */
const inner = (...steps: string[]) =>
  steps.map((step) => `  - ${step.replace(/\n/g, '\n    ')}`).join('\n');
const LOOK =
  'id: look\nprompt: Look for what is left to fix.\noutputs:\n  findings: { type: integer }';
const FIX = 'id: fix\nif: steps.look.findings > 0\nrun: ./fix\ndry_run: run';
const POLISH = `- id: polish\n  repeat: { max: 3, until: steps.look.findings == 0 }\n  steps:\n${inner(LOOK, FIX)}`;
const DONE = '- id: done\n  run: ./done';
/** The loop over `look` and `fix`, then `done`; `head` is the entry's own lines after its trigger. */
const LOOP_ENTRY = (head = BUDGET(1)) => file(entry('budgeted', `${MANUAL}${head}`, POLISH, DONE));

const OVER = 'over its budget: $1.20 spent of $1.00';
const OVER_BUDGET_RETRY =
  "This run can't continue: it is over the budget it was approved with. Raise `budget:` in the file and run it again.";
/** A failed turn that still reported what it cost. */
const failedTurn = (cost: number) => ({
  exitCode: 1,
  lastLine: 'Rate limited.',
  report: turnReport({ cost }),
});
/** Its words: a turn with a report is worded from it, so the last line is not quoted. */
const LOOK_ERROR = 'It stopped before finishing (exit 1).';
const MINUTE = 60_000;

/** Accept every entry in `yaml` at its version, as a person approving each once would. */
function acceptEvery(h: StepsHarness, yaml: string): void {
  for (const automation of parseFactorySpec(yaml).automations) {
    if (leafSteps(automation.steps ?? []).some((step) => step.kind === 'agent' && step.action))
      throw new Error('no action steps here');
    h.store.accept(`${WORKSPACE_ID} ${automation.name}`, automationVersion(automation));
  }
}

async function accepted(yaml: string, options: StepsHarnessOptions = {}): Promise<StepsHarness> {
  const h = await stepsHarness({ yaml, ...options });
  acceptEvery(h, yaml);
  return h;
}

const byId = (steps: StepRun[] | undefined, id: string) =>
  (steps ?? []).find((step) => step.id === id)!;
const rowOf = (h: StepsHarness, runId: string, id: string) => byId(h.store.get(runId)!.steps, id);

async function fire(h: StepsHarness, name = 'budgeted'): Promise<RunRecord> {
  const run = (await h.service.trigger(WORKSPACE_ID, name))!;
  await h.flush();
  return h.store.get(run.id)!;
}

/** The running `look` of a run ends with `findings`, its turn reporting `cost`. */
async function endLook(h: StepsHarness, runId: string, findings: number, cost: number) {
  const sessionId = rowOf(h, runId, 'look').sessionId!;
  h.world.setOutputs(sessionId, { findings });
  await h.world.endTurn(sessionId, { exitCode: 0, report: turnReport({ cost }) });
}

/** The run's running command `step` ends, exit 0. */
async function endCommand(h: StepsHarness, runId: string, step: string): Promise<void> {
  const command = h.world.commands.find(
    (candidate) =>
      !candidate.ended &&
      candidate.spec.env.CONSOLA_RUN_ID === runId &&
      candidate.spec.env.CONSOLA_STEP === step,
  );
  if (!command) throw new Error(`no running ${step} in ${runId}`);
  await command.end({});
}

/** Round 1 (`look` 0.6, `fix`) and round 2's `look` (0.6): $1.20 spent of a $1 budget. */
async function overBudget(h: StepsHarness): Promise<RunRecord> {
  const run = await fire(h);
  await endLook(h, run.id, 1, 0.6);
  // $0.60 of $1.00: the boundary before `fix` lets it start, and the one before round 2 too.
  expect(rowOf(h, run.id, 'fix').status).toBe('running');
  await endCommand(h, run.id, 'fix');
  expect(rowOf(h, run.id, 'polish')).toMatchObject({ status: 'running', round: 2 });
  await endLook(h, run.id, 1, 0.6);
  return h.store.get(run.id)!;
}

describe("a run's budget", () => {
  it('fails at the next boundary once spent reaches the budget, later steps not-run', async () => {
    const h = await accepted(LOOP_ENTRY());
    const run = await overBudget(h);
    expect(h.store.get(run.id)).toMatchObject({ status: 'failed', error: OVER, costUsd: 1.2 });
    // The step it would have started is the failed row, never started; its loop fails with it.
    expect(rowOf(h, run.id, 'fix')).toMatchObject({ status: 'failed', error: OVER, round: 2 });
    expect(rowOf(h, run.id, 'fix')).not.toHaveProperty('startedAt');
    expect(rowOf(h, run.id, 'polish')).toMatchObject({ status: 'failed', round: 2 });
    expect(rowOf(h, run.id, 'done').status).toBe('not-run');
    expect(
      h.world.commands.filter((command) => command.spec.env.CONSOLA_STEP === 'fix'),
    ).toHaveLength(1);
    expect(h.notices.at(-1)).toMatchObject({
      title: 'budgeted went over its budget',
      body: OVER,
      runId: run.id,
    });
  });

  it('checks the boundary before a step: exactly at the budget is over it', async () => {
    const h = await accepted(LOOP_ENTRY());
    const run = await fire(h);
    await endLook(h, run.id, 1, 1);
    // $1.00 of $1.00 after `look`: `fix` is not started, and no round 2.
    expect(h.store.get(run.id)).toMatchObject({
      status: 'failed',
      error: 'over its budget: $1.00 spent of $1.00',
    });
    expect(rowOf(h, run.id, 'fix')).toMatchObject({ status: 'failed', round: 1 });
    expect(h.world.commands).toHaveLength(0);
    expect(h.world.launches).toHaveLength(1);
    await expect(h.service.retry(run.id)).rejects.toThrow(OVER_BUDGET_RETRY);
  });

  it('checks the boundary before a round begins: the loop fails, no round starts', async () => {
    const lookOnly = `- id: polish\n  repeat: { max: 3, until: steps.look.findings == 0 }\n  steps:\n${inner(LOOK)}`;
    const h = await accepted(file(entry('budgeted', `${MANUAL}${BUDGET(1)}`, lookOnly, DONE)));
    const run = await fire(h);
    await endLook(h, run.id, 1, 1.25);
    expect(h.store.get(run.id)).toMatchObject({
      status: 'failed',
      error: 'over its budget: $1.25 spent of $1.00',
    });
    expect(rowOf(h, run.id, 'polish')).toMatchObject({
      status: 'failed',
      round: 1,
      error: 'over its budget: $1.25 spent of $1.00',
    });
    expect(rowOf(h, run.id, 'look')).toMatchObject({ status: 'completed', round: 1, attempt: 1 });
    expect(rowOf(h, run.id, 'done').status).toBe('not-run');
    expect(h.world.launches).toHaveLength(1);
    expect(h.notices.at(-1)?.title).toBe('budgeted went over its budget');
  });

  it('a run under its budget is never stopped by it', async () => {
    const h = await accepted(LOOP_ENTRY(BUDGET(5)));
    const run = await fire(h);
    await endLook(h, run.id, 1, 0.6);
    await endCommand(h, run.id, 'fix');
    await endLook(h, run.id, 0, 0.6);
    await endCommand(h, run.id, 'done');
    expect(h.store.get(run.id)).toMatchObject({ status: 'completed', costUsd: 1.2 });
  });

  it('refuses a retry over budget, even after the file raised it (Review Focus 5)', async () => {
    const h = await accepted(LOOP_ENTRY());
    const run = await overBudget(h);
    await expect(h.service.retry(run.id)).rejects.toThrow(OVER_BUDGET_RETRY);
    // Before the target's own check: whatever step it names.
    await expect(h.service.retry(run.id, 'look')).rejects.toThrow(OVER_BUDGET_RETRY);
    const raised = LOOP_ENTRY(BUDGET(100));
    await h.setYaml(raised);
    acceptEvery(h, raised);
    await h.flush();
    await expect(h.service.retry(run.id)).rejects.toThrow(OVER_BUDGET_RETRY);
    expect(h.store.get(run.id)).toMatchObject({ status: 'failed', error: OVER });
    expect(h.world.launches).toHaveLength(2);
    expect(h.world.commands).toHaveLength(1);
  });

  it('a run that never started is still told it never started', async () => {
    const h = await accepted(LOOP_ENTRY());
    const run = await overBudget(h);
    // A hand-built record: refused before it started, though over budget (it cannot be, but the order is the rule).
    h.store.update(run.id, { startedAt: undefined });
    await expect(h.service.retry(run.id)).rejects.toThrow('It never started; run it again.');
  });

  it('a run under its budget retries as before', async () => {
    const h = await accepted(LOOP_ENTRY(BUDGET(5)));
    const run = await fire(h);
    const sessionId = rowOf(h, run.id, 'look').sessionId!;
    await h.world.endTurn(sessionId, failedTurn(0.6));
    expect(h.store.get(run.id)).toMatchObject({ status: 'failed', error: LOOK_ERROR });
    await h.service.retry(run.id);
    await h.flush();
    expect(rowOf(h, run.id, 'look')).toMatchObject({ status: 'running', attempt: 2 });
  });

  it('nothing over budget retries by itself: not the step', async () => {
    const h = await accepted(
      file(
        entry(
          'budgeted',
          `${MANUAL}${BUDGET(1)}`,
          '- id: look\n  prompt: Look for what is left to fix.\n  on_failure: { retry: 1 }',
        ),
      ),
    );
    const run = await fire(h);
    const sessionId = rowOf(h, run.id, 'look').sessionId!;
    await h.world.endTurn(sessionId, failedTurn(1.5));
    expect(h.store.get(run.id)).toMatchObject({
      status: 'failed',
      error: LOOK_ERROR,
      costUsd: 1.5,
    });
    expect(rowOf(h, run.id, 'look')).toMatchObject({ status: 'failed', error: LOOK_ERROR });
    expect(rowOf(h, run.id, 'look')).not.toHaveProperty('retryAt');
    expect(rowOf(h, run.id, 'look')).not.toHaveProperty('retries');
    h.advance(15 * MINUTE);
    await h.tick();
    expect(h.world.launches).toHaveLength(1);
    // Its own failure, so its own words.
    expect(h.notices.at(-1)).toMatchObject({ title: 'budgeted did not finish', body: LOOK_ERROR });
  });

  it('nothing over budget retries by itself: not the entry, after a step failed or at the boundary', async () => {
    const failed = await accepted(
      file(
        entry(
          'budgeted',
          `${MANUAL}${BUDGET(1)}    on_failure: { retry: 1 }\n`,
          '- id: look\n  prompt: Look for what is left to fix.',
        ),
      ),
    );
    const one = await fire(failed);
    await failed.world.endTurn(rowOf(failed, one.id, 'look').sessionId!, failedTurn(1.5));
    expect(failed.store.get(one.id)).toMatchObject({ status: 'failed', error: LOOK_ERROR });
    expect(failed.store.get(one.id)).not.toHaveProperty('retryAt');

    const boundary = await accepted(LOOP_ENTRY(`${BUDGET(1)}    on_failure: { retry: 1 }\n`));
    const two = await overBudget(boundary);
    expect(boundary.store.get(two.id)).toMatchObject({ status: 'failed', error: OVER });
    expect(boundary.store.get(two.id)).not.toHaveProperty('retryAt');
    boundary.advance(15 * MINUTE);
    await boundary.tick();
    expect(boundary.store.get(two.id)?.status).toBe('failed');
    expect(boundary.world.launches).toHaveLength(2);
  });

  it('under its budget, a step still retries by itself', async () => {
    const h = await accepted(
      file(
        entry(
          'budgeted',
          `${MANUAL}${BUDGET(5)}`,
          '- id: look\n  prompt: Look for what is left to fix.\n  on_failure: { retry: 1 }',
        ),
      ),
    );
    const run = await fire(h);
    const sessionId = rowOf(h, run.id, 'look').sessionId!;
    await h.world.endTurn(sessionId, failedTurn(1.5));
    expect(rowOf(h, run.id, 'look')).toMatchObject({ status: 'waiting', retries: 1 });
  });

  it('no budget means no ceiling', async () => {
    const h = await accepted(LOOP_ENTRY(''));
    const run = await fire(h);
    await endLook(h, run.id, 1, 0.6);
    await endCommand(h, run.id, 'fix');
    await endLook(h, run.id, 1, 0.6);
    await endCommand(h, run.id, 'fix');
    await endLook(h, run.id, 0, 0.6);
    expect(rowOf(h, run.id, 'polish')).toMatchObject({
      status: 'completed',
      round: 3,
      note: 'clean after round 3',
    });
    await endCommand(h, run.id, 'done');
    expect(h.store.get(run.id)).toMatchObject({ status: 'completed' });
    expect(h.store.get(run.id)?.costUsd).toBeCloseTo(1.8, 10);
    expect(h.world.launches).toHaveLength(3);
  });

  it('every key runs now: no entry is refused for its control flow', async () => {
    const yaml = file(
      entry(
        'everything',
        `${MANUAL}${BUDGET(5)}    on_failure: { retry: 1 }\n`,
        '- id: triage\n  prompt: Triage it.\n  on_failure: { retry: 2 }\n  outputs:\n    kind: { enum: [bug, feature] }',
        "- id: not-ours\n  if: steps.triage.kind == 'feature'\n  run: ./label\n  dry_run: run\n  then: stop",
        POLISH,
        '- id: decide\n  gate: { ask: Open it?, choices: [approve, comment] }',
        DONE,
      ),
    );
    const h = await stepsHarness({ yaml });
    const view = h.service.list(WORKSPACE_ID).find((candidate) => candidate.name === 'everything');
    expect(view).toBeDefined();
    expect(view?.problem).toBeUndefined();
    // And it runs: its first step starts.
    acceptEvery(h, yaml);
    const run = await fire(h, 'everything');
    expect(rowOf(h, run.id, 'triage').status).toBe('running');
  });
});
