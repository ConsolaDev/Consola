import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  automationVersion,
  leafSteps,
  parseFactorySpec,
  type RunRecord,
  type StepRun,
} from '@consola/factory-spec';
import { inboxItem } from './inboxItems.test-helpers';
import {
  checkoutPathFor,
  stepsHarness,
  WORKSPACE_ID,
  type StepsHarness,
  type StepsHarnessOptions,
} from './steps/steps.test-helpers';

/** One `- name:` entry: its head lines as given, then `steps:` with each item's lines. */
function entry(name: string, head: string, ...steps: string[]): string {
  const items = steps.map((step) => `      ${step.replace(/\n/g, '\n      ')}`).join('\n');
  return `  - name: ${name}\n${head}    steps:\n${items}\n`;
}
const file = (...entries: string[]) => `version: 1\nautomations:\n${entries.join('')}`;

const MANUAL = (mode = 'auto') => `    on: manual\n    scope: catalog-portal\n    mode: ${mode}\n`;
const ON_REVIEW = '    on: { github: pull_request.review_requested }\n    mode: auto\n';

/** A loop's steps, indented under its `steps:`. */
const inner = (...steps: string[]) =>
  steps.map((step) => `  - ${step.replace(/\n/g, '\n    ')}`).join('\n');
const LOOK =
  'id: look\nprompt: Look for what is left to fix.\noutputs:\n  findings: { type: integer }';
const FIX = 'id: fix\nif: steps.look.findings > 0\nrun: ./fix\ndry_run: run';
const polish = (head = '', ...steps: string[]) =>
  `- id: polish\n  repeat: { max: 3, until: steps.look.findings == 0 }\n${head}  steps:\n${inner(...(steps.length > 0 ? steps : [LOOK, FIX]))}`;
const DONE = '- id: done\n  run: ./done\n  env: { LEFT: "{{steps.look.findings}}" }';
const LOOP_ENTRY = (head = '', mode = 'auto') =>
  file(entry('loops', MANUAL(mode), polish(head), DONE));

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
const stepsOf = (h: StepsHarness, runId: string) => h.store.get(runId)!.steps!;
const rowOf = (h: StepsHarness, runId: string, id: string) => byId(stepsOf(h, runId), id);

async function fire(h: StepsHarness, name = 'loops'): Promise<RunRecord> {
  const run = (await h.service.trigger(WORKSPACE_ID, name))!;
  await h.flush();
  return h.store.get(run.id)!;
}

/** The running `look` of a run ends with `findings`. */
async function endLook(h: StepsHarness, runId: string, findings: number): Promise<void> {
  const sessionId = rowOf(h, runId, 'look').sessionId!;
  h.world.setOutputs(sessionId, { findings });
  await h.world.endTurn(sessionId);
}

/** The run's running command (`fix`, `done`, …) ends as `how` says, exit 0 by default. */
async function endCommand(
  h: StepsHarness,
  runId: string,
  step: string,
  how: Parameters<StepsHarness['world']['commands'][number]['end']>[0] = {},
): Promise<void> {
  const command = h.world.commands.find(
    (candidate) =>
      !candidate.ended &&
      candidate.spec.env.CONSOLA_RUN_ID === runId &&
      candidate.spec.env.CONSOLA_STEP === step,
  );
  if (!command) throw new Error(`no running ${step} in ${runId}`);
  await command.end(how);
}

/** Every file in a run's folder, by its path inside it. */
function runFolderFiles(h: StepsHarness, runId: string): string[] {
  const root = h.folder.runDir(WORKSPACE_ID, runId);
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else found.push(path.relative(root, full));
    }
  };
  walk(root);
  return found;
}

/** Rounds of `look` with these findings, each followed by `fix` when there are some. */
async function rounds(h: StepsHarness, runId: string, ...findings: number[]): Promise<void> {
  for (const left of findings) {
    await endLook(h, runId, left);
    if (left > 0 && rowOf(h, runId, 'fix').status === 'running') await endCommand(h, runId, 'fix');
  }
}

describe('a loop runs round by round', () => {
  it('runs rounds in order until clean, each execution its own attempt and round', async () => {
    const h = await accepted(LOOP_ENTRY());
    const run = await fire(h);
    expect(rowOf(h, run.id, 'polish')).toMatchObject({ status: 'running', round: 1, max: 3 });
    expect(rowOf(h, run.id, 'look')).toMatchObject({ status: 'running', round: 1, attempt: 1 });
    await endLook(h, run.id, 1);
    await endCommand(h, run.id, 'fix');
    expect(rowOf(h, run.id, 'polish')).toMatchObject({ status: 'running', round: 2 });
    await endLook(h, run.id, 0);
    const look = rowOf(h, run.id, 'look');
    expect(look).toMatchObject({
      attempt: 2,
      round: 2,
      outputs: { findings: 0 },
      previous: [{ attempt: 1, status: 'completed', round: 1 }],
    });
    expect(rowOf(h, run.id, 'fix')).toMatchObject({
      status: 'skipped',
      round: 2,
      attempt: 2,
      previous: [{ attempt: 1, status: 'completed', round: 1 }],
    });
    expect(rowOf(h, run.id, 'polish')).toMatchObject({
      status: 'completed',
      round: 2,
      max: 3,
      note: 'clean after round 2',
    });
    expect(runFolderFiles(h, run.id)).toEqual(
      expect.arrayContaining(['look/1/outputs.json', 'look/2/outputs.json', 'fix/1/command.json']),
    );
    expect(runFolderFiles(h, run.id)).not.toContain('fix/2/command.json');
    // A later step reads the latest round.
    expect(rowOf(h, run.id, 'done').status).toBe('running');
    const done = h.world.commands.at(-1)!;
    expect(done.spec.env.LEFT).toBe('0');
    await done.end();
    expect(h.store.get(run.id)).toMatchObject({
      status: 'completed',
      // `runSummary` reads each step's latest record: round 2's (fix skipped there).
      summary: 'look → done; fix skipped',
    });
    expect(h.world.launches.map((launch) => launch.step?.attempt)).toEqual([1, 2]);
  });

  it.each([
    ['fail', 'failed'],
    ['continue', 'completed'],
  ])('on_exhausted %s after three rounds', async (onExhausted, status) => {
    const h = await accepted(LOOP_ENTRY(`  on_exhausted: ${onExhausted}\n`));
    const run = await fire(h);
    await rounds(h, run.id, 2, 2, 1);
    if (onExhausted === 'fail') {
      expect(h.store.get(run.id)).toMatchObject({
        status,
        error: 'polish: not clean after 3 rounds',
      });
      expect(rowOf(h, run.id, 'polish')).toMatchObject({
        status: 'failed',
        error: 'polish: not clean after 3 rounds',
      });
      expect(rowOf(h, run.id, 'done').status).toBe('not-run');
      return;
    }
    expect(rowOf(h, run.id, 'polish')).toMatchObject({
      status: 'completed',
      note: 'stopped after 3 rounds',
    });
    await endCommand(h, run.id, 'done');
    expect(h.store.get(run.id)?.status).toBe(status);
  });

  it('on_exhausted gate after three rounds: it waits, and approve goes on', async () => {
    const h = await accepted(LOOP_ENTRY('  on_exhausted: { gate: Open it anyway? }\n'));
    const run = await fire(h);
    await rounds(h, run.id, 2, 2, 1);
    expect(h.store.get(run.id)?.status).toBe('waiting');
    expect(rowOf(h, run.id, 'polish')).toMatchObject({
      status: 'waiting',
      round: 3,
      gate: { askedAt: expect.any(String) },
    });
    expect(h.notices.at(-1)).toMatchObject({
      title: 'loops is waiting for you',
      body: 'Open it anyway?',
    });
    expect(h.service.gateOf(run.id, 'polish')).toMatchObject({
      ask: 'Open it anyway?',
      choices: ['approve'],
      loop: { id: 'polish', rounds: 3 },
    });
    expect(h.service.listRuns(WORKSPACE_ID, { limit: 5 }).runs[0].step).toMatchObject({
      id: 'polish',
      kind: 'repeat',
      status: 'waiting',
      round: 3,
      max: 3,
      gate: true,
    });
    h.service.answerGate(run.id, 'polish', 'approve');
    await h.flush();
    expect(rowOf(h, run.id, 'polish')).toMatchObject({
      status: 'completed',
      note: 'you approved after 3 rounds',
      gate: { decision: 'approve', by: 'person' },
    });
    expect(rowOf(h, run.id, 'polish')).not.toHaveProperty('outputs');
    await endCommand(h, run.id, 'done');
    expect(h.store.get(run.id)?.status).toBe('completed');
  });

  it("on_exhausted gate's reject ends the run rejected at the loop", async () => {
    const h = await accepted(LOOP_ENTRY('  on_exhausted: { gate: Open it anyway? }\n'));
    const run = await fire(h);
    await rounds(h, run.id, 2, 2, 1);
    h.service.answerGate(run.id, 'polish', 'reject');
    await h.flush();
    expect(h.store.get(run.id)).toMatchObject({
      status: 'rejected',
      summary: 'rejected at polish',
    });
    expect(rowOf(h, run.id, 'done').status).toBe('not-run');
  });

  it("a run rejected at a gate inside a loop closes its loop's row by the run's end (review R29)", async () => {
    const h = await accepted(
      file(
        entry(
          'loops',
          MANUAL(),
          polish('', LOOK, 'id: ask\ngate: { ask: Keep going? }', FIX),
          DONE,
        ),
      ),
    );
    const run = await fire(h);
    await endLook(h, run.id, 1);
    expect(rowOf(h, run.id, 'ask').status).toBe('waiting');
    expect(rowOf(h, run.id, 'polish').status).toBe('running');
    h.service.answerGate(run.id, 'ask', 'reject');
    expect(h.store.get(run.id)?.status).toBe('rejected');
    // Still in its round when the run ended, not failed: it takes the run's end.
    expect(rowOf(h, run.id, 'polish')).toMatchObject({
      status: 'completed',
      finishedAt: h.now().toISOString(),
    });
    expect(rowOf(h, run.id, 'fix').status).toBe('not-run');
  });

  it('a gate inside a loop is asked afresh each round, and its answer goes on in the round', async () => {
    const h = await accepted(
      file(
        entry(
          'loops',
          MANUAL(),
          polish('', LOOK, 'id: ask\ngate: { ask: Keep going? }', FIX),
          DONE,
        ),
      ),
    );
    const run = await fire(h);
    await endLook(h, run.id, 1);
    h.service.answerGate(run.id, 'ask', 'approve');
    await h.flush();
    await endCommand(h, run.id, 'fix');
    // Round 2: look again, then the gate asks again, its round-1 answer in its `previous`.
    await endLook(h, run.id, 1);
    expect(rowOf(h, run.id, 'ask')).toMatchObject({
      status: 'waiting',
      round: 2,
      attempt: 2,
      previous: [{ attempt: 1, status: 'completed', round: 1, decision: 'approve' }],
    });
    expect(rowOf(h, run.id, 'ask').gate).toEqual({ askedAt: expect.any(String) });
  });
});

describe('retries inside and of a loop', () => {
  it('a retry of a failed inner step stays in its round, then evaluates until', async () => {
    const h = await accepted(LOOP_ENTRY());
    const run = await fire(h);
    await rounds(h, run.id, 1);
    await endLook(h, run.id, 1);
    await endCommand(h, run.id, 'fix', { result: { exitCode: 1 } });
    expect(h.store.get(run.id)?.status).toBe('failed');
    expect(rowOf(h, run.id, 'polish')).toMatchObject({ status: 'failed', round: 2 });
    await h.service.retry(run.id, 'fix');
    await h.flush();
    expect(rowOf(h, run.id, 'fix')).toMatchObject({ status: 'running', attempt: 3, round: 2 });
    expect(rowOf(h, run.id, 'polish')).toMatchObject({ status: 'running', round: 2 });
    expect(rowOf(h, run.id, 'polish')).not.toHaveProperty('error');
    expect(rowOf(h, run.id, 'look')).toMatchObject({ status: 'completed', round: 2, attempt: 2 });
    // fix now ends; look's round-2 findings were 1, so until is not met and a third round starts.
    await endCommand(h, run.id, 'fix');
    expect(rowOf(h, run.id, 'polish')).toMatchObject({ status: 'running', round: 3 });
    await endLook(h, run.id, 0);
    expect(rowOf(h, run.id, 'polish')).toMatchObject({
      status: 'completed',
      note: 'clean after round 3',
    });
  });

  it('a retried inner step whose until is then met ends the loop in that round', async () => {
    const h = await accepted(
      file(
        entry(
          'loops',
          MANUAL(),
          polish(
            '',
            LOOK,
            'id: fix\nif: steps.look.findings > 0\nrun: ./fix\ndry_run: run\noutputs: { clean: boolean }',
          ).replace('until: steps.look.findings == 0', 'until: steps.fix.clean'),
          DONE,
        ),
      ),
    );
    const run = await fire(h);
    await endLook(h, run.id, 1);
    await endCommand(h, run.id, 'fix', { result: { exitCode: 1 } });
    expect(h.store.get(run.id)?.status).toBe('failed');
    await h.service.retry(run.id, 'fix');
    await h.flush();
    await endCommand(h, run.id, 'fix', { outputs: 'clean=true\n' });
    expect(rowOf(h, run.id, 'polish')).toMatchObject({
      status: 'completed',
      round: 1,
      note: 'clean after round 1',
    });
    expect(h.world.launches).toHaveLength(1);
  });

  it('a retry of an exhausted loop runs one more round per click', async () => {
    const h = await accepted(LOOP_ENTRY());
    const run = await fire(h);
    await rounds(h, run.id, 2, 2, 1);
    expect(h.store.get(run.id)).toMatchObject({
      status: 'failed',
      error: 'polish: not clean after 3 rounds',
    });
    await h.service.retry(run.id, 'polish');
    await h.flush();
    expect(rowOf(h, run.id, 'polish')).toMatchObject({ status: 'running', round: 4 });
    expect(rowOf(h, run.id, 'look')).toMatchObject({ status: 'running', round: 4, attempt: 4 });
    await rounds(h, run.id, 1);
    expect(h.store.get(run.id)).toMatchObject({
      status: 'failed',
      error: 'polish: not clean after 4 rounds',
    });
    await h.service.retry(run.id, 'polish');
    await h.flush();
    expect(rowOf(h, run.id, 'look')).toMatchObject({ status: 'running', round: 5, attempt: 5 });
  });

  it('a restart in round 2 continues the round from the record (Review Focus 2)', async () => {
    const h = await accepted(LOOP_ENTRY());
    const run = await fire(h);
    await rounds(h, run.id, 1);
    const polishBefore = rowOf(h, run.id, 'polish');
    expect(rowOf(h, run.id, 'look')).toMatchObject({ status: 'running', round: 2 });
    const session = rowOf(h, run.id, 'look').sessionId!;
    const again = await h.relaunch();
    expect(byId(again.store.get(run.id)!.steps, 'polish')).toEqual(polishBefore);
    // It resumes in its own session, in its round.
    expect(again.world.resumes.map((resume) => resume.sessionId)).toEqual([session]);
    expect(byId(again.store.get(run.id)!.steps, 'look')).toMatchObject({
      status: 'running',
      round: 2,
      sessionId: session,
    });
    again.world.setOutputs(session, { findings: 0 });
    await again.world.endTurn(session);
    expect(byId(again.store.get(run.id)!.steps, 'polish')).toMatchObject({
      status: 'completed',
      note: 'clean after round 2',
    });
  });

  it('a dry run ends a loop whose until waits on a reported command (Call 10)', async () => {
    const yaml = file(
      entry(
        'loops',
        MANUAL('notify'),
        polish('', LOOK, 'id: check\nrun: ./check\noutputs: { clean: boolean }').replace(
          'until: steps.look.findings == 0',
          'until: steps.check.clean == true',
        ),
        '- id: done\n  run: ./done',
      ),
    );
    const h = await accepted(yaml);
    const run = await fire(h);
    expect(h.store.get(run.id)?.dryRun).toBe(true);
    await endLook(h, run.id, 2);
    expect(rowOf(h, run.id, 'check')).toMatchObject({ status: 'reported' });
    expect(rowOf(h, run.id, 'polish')).toMatchObject({
      status: 'reported',
      round: 1,
      note: 'a real run would repeat until steps.check.clean == true',
    });
    expect(h.world.launches).toHaveLength(1);
    expect(h.store.get(run.id)?.status).toBe('completed');
  });
});

describe('a loop and the checkout', () => {
  const PR51 = inboxItem({ repo: 'sprocket/catalog-portal', number: 51 });
  const DIR = checkoutPathFor(PR51.workItem);
  const LOOK_51 =
    'id: look\nprompt: Look at {{item.url}}.\noutputs:\n  findings: { type: integer }';

  async function onPr51(yaml: string): Promise<{ h: StepsHarness; run: RunRecord }> {
    const h = await stepsHarness({ yaml });
    await h.poll([]);
    acceptEvery(h, yaml);
    await h.poll([PR51]);
    return { h, run: h.store.runs()[0] };
  }

  it('a loop as the first step of an item run prepares its checkout first', async () => {
    const { h, run } = await onPr51(file(entry('loops', ON_REVIEW, polish('', LOOK_51))));
    expect(h.world.checkouts.prepared).toHaveLength(1);
    expect(h.store.get(run.id)?.checkout).toMatchObject({ cwd: DIR, head: h.world.checkouts.head });
    expect(h.world.launches[0].step).toMatchObject({ id: 'look', cwd: DIR });
  });

  it('a loop whose first inner step is a gate takes the checkout before it parks (review B2)', async () => {
    const { h, run } = await onPr51(
      file(entry('loops', ON_REVIEW, polish('', 'id: ask-first\ngate: { ask: Go on? }', LOOK_51))),
    );
    expect(h.world.checkouts.prepared).toHaveLength(1);
    expect(h.store.get(run.id)).toMatchObject({
      status: 'waiting',
      checkout: { cwd: DIR, head: h.world.checkouts.head },
    });
    expect(rowOf(h, run.id, 'ask-first').status).toBe('waiting');
    h.service.answerGate(run.id, 'ask-first', 'approve');
    await h.flush();
    expect(h.world.launches[0].step).toMatchObject({ id: 'look', cwd: DIR });
    expect(h.world.checkouts.prepared).toHaveLength(1);
  });

  it("a retry of an exhausted loop on an item run re-prepares the checkout, as an agent step's does (review S11)", async () => {
    const twoRounds = (...steps: string[]) => polish('', ...steps).replace('max: 3', 'max: 2');
    const { h, run } = await onPr51(file(entry('loops', ON_REVIEW, twoRounds(LOOK_51))));
    await endLook(h, run.id, 1);
    await endLook(h, run.id, 1);
    expect(h.store.get(run.id)?.status).toBe('failed');
    h.world.checkouts.head = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2';
    await h.service.retry(run.id, 'polish');
    await h.flush();
    expect(h.world.checkouts.prepared).toHaveLength(2);
    expect(h.store.get(run.id)?.checkout?.head).toBe('b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2');
    expect(rowOf(h, run.id, 'look')).toMatchObject({ status: 'running', round: 3 });

    // The same loop with a command first: it runs in the checkout as it is.
    const first = await onPr51(
      file(entry('loops', ON_REVIEW, twoRounds('id: fix\nrun: ./fix\ndry_run: run', LOOK_51))),
    );
    await endCommand(first.h, first.run.id, 'fix');
    await endLook(first.h, first.run.id, 1);
    await endCommand(first.h, first.run.id, 'fix');
    await endLook(first.h, first.run.id, 1);
    expect(first.h.store.get(first.run.id)?.status).toBe('failed');
    const head = first.h.store.get(first.run.id)!.checkout!.head;
    first.h.world.checkouts.head = 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3';
    await first.h.service.retry(first.run.id, 'polish');
    await first.h.flush();
    expect(first.h.world.checkouts.prepared).toHaveLength(1);
    expect(first.h.store.get(first.run.id)?.checkout?.head).toBe(head);
    expect(rowOf(first.h, first.run.id, 'fix')).toMatchObject({ status: 'running', round: 3 });
  });
});

describe('a stop between rounds (review S8)', () => {
  /** As a crash leaves it: `stepId`'s command done, nothing after it looked at yet. */
  const commandDone = (h: StepsHarness, runId: string, stepId: string) =>
    h.store.update(runId, {
      steps: stepsOf(h, runId).map((step) =>
        step.id === stepId
          ? { ...step, status: 'completed', finishedAt: h.now().toISOString() }
          : step,
      ),
    });

  it('fails the loop and starts no round; a retry runs the next', async () => {
    const h = await accepted(LOOP_ENTRY());
    const run = await fire(h);
    await endLook(h, run.id, 1);
    commandDone(h, run.id, 'fix');
    const launches = h.world.launches.length;
    h.service.stop(run.id);
    expect(h.store.get(run.id)).toMatchObject({
      status: 'failed',
      error: 'Stopped after round 1 of polish.',
    });
    expect(rowOf(h, run.id, 'polish')).toMatchObject({
      status: 'failed',
      round: 1,
      error: 'Stopped after round 1 of polish.',
    });
    expect(h.world.launches).toHaveLength(launches);
    expect(rowOf(h, run.id, 'look')).toMatchObject({ round: 1, attempt: 1 });
    expect(rowOf(h, run.id, 'done').status).toBe('not-run');
    expect(h.notices.filter((notice) => notice.title.endsWith('did not finish'))).toEqual([]);
    await h.service.retry(run.id, 'polish');
    await h.flush();
    expect(rowOf(h, run.id, 'look')).toMatchObject({ status: 'running', round: 2, attempt: 2 });
  });

  it("fails a loop before its first round with slice 1's words", async () => {
    const h = await accepted(
      file(entry('loops', MANUAL(), '- id: first\n  run: ./first', polish(), DONE)),
    );
    const run = await fire(h);
    commandDone(h, run.id, 'first');
    h.service.stop(run.id);
    expect(h.store.get(run.id)).toMatchObject({
      status: 'failed',
      error: 'Stopped before polish started.',
    });
    expect(rowOf(h, run.id, 'look')).toMatchObject({ status: 'not-run' });
    await h.service.retry(run.id, 'polish');
    await h.flush();
    expect(rowOf(h, run.id, 'look')).toMatchObject({ status: 'running', round: 1 });
  });

  it('fails a loop that would ask at its exhaustion gate, naming its last round', async () => {
    const h = await accepted(LOOP_ENTRY('  on_exhausted: { gate: Open it anyway? }\n'));
    const run = await fire(h);
    await rounds(h, run.id, 2, 2);
    await endLook(h, run.id, 1);
    commandDone(h, run.id, 'fix');
    const notices = h.notices.length;
    h.service.stop(run.id);
    expect(h.store.get(run.id)).toMatchObject({
      status: 'failed',
      error: 'Stopped after round 3 of polish.',
    });
    expect(
      h.history.appends.some((line) => line.run.id === run.id && line.run.status === 'waiting'),
    ).toBe(false);
    expect(h.notices).toHaveLength(notices);
  });
});

describe("a loop's own row is never work under way", () => {
  it("holds no slot: another run's command starts while a loop's agent step runs", async () => {
    const yaml = file(
      entry('loops', MANUAL(), polish(), DONE),
      entry('other', MANUAL(), '- id: build\n  run: ./build'),
    );
    const h = await accepted(yaml, { maxConcurrentCommands: 1 });
    const run = await fire(h);
    expect(rowOf(h, run.id, 'look').status).toBe('running');
    const other = await fire(h, 'other');
    expect(rowOf(h, other.id, 'build').status).toBe('running');
  });

  it('is no stall: a restart between two of a round’s steps goes on', async () => {
    const h = await accepted(LOOP_ENTRY());
    const run = await fire(h);
    // As a crash between two lines leaves it: look done in round 1, fix not queued yet.
    h.store.update(run.id, {
      steps: stepsOf(h, run.id).map((step) =>
        step.id === 'look'
          ? {
              ...step,
              status: 'completed',
              outputs: { findings: 1 },
              finishedAt: h.now().toISOString(),
            }
          : step,
      ),
    });
    const again = await h.relaunch();
    expect(byId(again.store.get(run.id)!.steps, 'fix').status).toBe('running');
    expect(byId(again.store.get(run.id)!.steps, 'polish')).toMatchObject({
      status: 'running',
      round: 1,
    });
  });

  it('keeps nothing starting once its step has launched, so a stop ends the turn', async () => {
    const h = await accepted(LOOP_ENTRY());
    const run = await fire(h);
    const session = rowOf(h, run.id, 'look').sessionId!;
    h.service.stop(run.id);
    expect(h.world.stops).toEqual([{ sessionId: session, reason: 'you stopped it' }]);
  });

  it('a run failed mid-loop ends only what ran: the loop’s row is closed, with no error of its own', async () => {
    const h = await accepted(LOOP_ENTRY());
    const run = await fire(h);
    fs.rmSync(path.join(h.folder.runDir(WORKSPACE_ID, run.id), 'definition.json'));
    await h.service.syncWorkspaces();
    expect(h.store.get(run.id)?.status).toBe('failed');
    expect(rowOf(h, run.id, 'look')).toMatchObject({ status: 'failed', error: expect.any(String) });
    expect(rowOf(h, run.id, 'polish')).toMatchObject({ status: 'failed' });
    expect(rowOf(h, run.id, 'polish')).not.toHaveProperty('error');
  });
});
