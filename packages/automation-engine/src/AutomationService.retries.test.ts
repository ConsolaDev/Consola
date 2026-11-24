import { describe, expect, it } from 'vitest';
import { automationVersion, leafSteps, parseFactorySpec } from '@consola/factory-spec';
import type { RunRecord, StepRun } from '@consola/factory-spec';
import { inboxItem } from './inboxItems.test-helpers';
import {
  checkoutPathFor,
  stepsHarness,
  turnReport,
  WORKSPACE_ID,
} from './steps/steps.test-helpers';
import type { StepsHarness, StepsHarnessOptions } from './steps/steps.test-helpers';

/** One `- name:` entry: its head lines as given, then `steps:` with each item's lines. */
function entry(name: string, head: string, ...steps: string[]): string {
  const items = steps.map((step) => `      ${step.replace(/\n/g, '\n      ')}`).join('\n');
  return `  - name: ${name}\n${head}    steps:\n${items}\n`;
}
const file = (...entries: string[]) => `version: 1\nautomations:\n${entries.join('')}`;

const MANUAL = '    on: manual\n    scope: catalog-portal\n    mode: auto\n';
const ON_REVIEW = '    on: { github: pull_request.review_requested }\n    mode: auto\n';
const ENTRY_RETRY = (n = 1) => `    on_failure: { retry: ${n} }\n`;
const LOOK = (retry?: number) =>
  `- id: look\n  prompt: Look for what is left to fix.${retry === undefined ? '' : `\n  on_failure: { retry: ${retry} }`}`;
const FAILED_TURN = { exitCode: 1, lastLine: 'Rate limited.' };
const LOOK_ERROR = 'It stopped before finishing (exit 1): Rate limited.';
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
const plus = (at: Date, ms: number) => new Date(at.getTime() + ms).toISOString();

/** Fire `name` by hand; a first run that asks (an agent's file is in its version) is approved as a person would. */
async function fire(h: StepsHarness, name: string): Promise<RunRecord> {
  const run = (await h.service.trigger(WORKSPACE_ID, name))!;
  if (run.status === 'needs-approval') await h.service.approve(run.id);
  await h.flush();
  return h.store.get(run.id)!;
}

/** The running agent step `stepId` of a run ends as `outcome` says (exit 0 by default). */
async function endStep(
  h: StepsHarness,
  runId: string,
  stepId: string,
  outcome?: Parameters<StepsHarness['world']['endTurn']>[1],
): Promise<void> {
  await h.world.endTurn(rowOf(h, runId, stepId).sessionId!, outcome);
}

/** The run's running command `step` ends as `how` says, exit 0 by default. */
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

describe("a step's declared retry", () => {
  it('a read-only agent step retries by itself after 1 minute, as its next attempt', async () => {
    const h = await accepted(file(entry('retries', MANUAL, LOOK(2))));
    const run = await fire(h, 'retries');
    const failedAt = h.now();
    await endStep(h, run.id, 'look', FAILED_TURN);
    expect(rowOf(h, run.id, 'look')).toMatchObject({
      status: 'waiting',
      retries: 1,
      retryAt: plus(failedAt, MINUTE),
      error: LOOK_ERROR,
    });
    expect(h.store.get(run.id)).toMatchObject({ status: 'waiting' });
    expect(h.store.get(run.id)).not.toHaveProperty('finishedAt');
    // The failure and the wait are one line: never failed, then waiting.
    expect(
      h.history.appends.some(
        (line) => line.run.id === run.id && byId(line.run.steps, 'look').status === 'failed',
      ),
    ).toBe(false);
    // Nobody is told about a wait: it may yet come good.
    expect(h.notices.filter((notice) => notice.runId === run.id)).toEqual([]);
    h.advance(59_000);
    await h.tick();
    expect(h.world.launches).toHaveLength(1);
    h.advance(1_000);
    await h.tick();
    expect(rowOf(h, run.id, 'look')).toMatchObject({
      status: 'running',
      attempt: 2,
      retries: 1,
      previous: [{ attempt: 1, status: 'failed', error: LOOK_ERROR }],
    });
    expect(rowOf(h, run.id, 'look')).not.toHaveProperty('retryAt');
    expect(h.store.get(run.id)?.status).toBe('running');
    expect(h.world.launches).toHaveLength(2);
    // Its second failure waits 5 minutes.
    const again = h.now();
    await endStep(h, run.id, 'look', FAILED_TURN);
    expect(rowOf(h, run.id, 'look')).toMatchObject({
      status: 'waiting',
      retries: 2,
      retryAt: plus(again, 5 * MINUTE),
    });
  });

  it('spent retries fail the run, saying how many times', async () => {
    const h = await accepted(file(entry('retries', MANUAL, LOOK(1))));
    const run = await fire(h, 'retries');
    await endStep(h, run.id, 'look', FAILED_TURN);
    h.advance(MINUTE);
    await h.tick();
    await endStep(h, run.id, 'look', FAILED_TURN);
    const error = `${LOOK_ERROR} (tried 2 times)`;
    expect(h.store.get(run.id)).toMatchObject({ status: 'failed', error });
    expect(rowOf(h, run.id, 'look')).toMatchObject({ status: 'failed', error, retries: 1 });
    expect(h.notices.at(-1)).toMatchObject({ title: 'retries did not finish', body: error });
  });

  it('never after the person closed its session', async () => {
    const h = await accepted(file(entry('retries', MANUAL, LOOK(2))));
    const run = await fire(h, 'retries');
    const session = rowOf(h, run.id, 'look').sessionId!;
    h.world.workspace.sessions = h.world.workspace.sessions.filter((one) => one.id !== session);
    await h.service.syncWorkspaces();
    expect(h.store.get(run.id)).toMatchObject({
      status: 'failed',
      error: 'Its session was closed before it finished.',
    });
    expect(rowOf(h, run.id, 'look')).not.toHaveProperty('retryAt');
  });

  it("a person's Retry after a stop forgets the stop: its next failure of its own waits", async () => {
    const h = await accepted(file(entry('retries', MANUAL, LOOK(2))));
    const run = await fire(h, 'retries');
    h.service.stop(run.id);
    await endStep(h, run.id, 'look', { exitCode: 143, stopped: 'you stopped it' });
    expect(h.store.get(run.id)?.status).toBe('failed');
    await h.service.retry(run.id, 'look');
    await h.flush();
    expect(rowOf(h, run.id, 'look')).toMatchObject({ status: 'running', attempt: 2 });
    await endStep(h, run.id, 'look', FAILED_TURN);
    expect(rowOf(h, run.id, 'look')).toMatchObject({ status: 'waiting', retries: 1 });
  });

  it('a stop after its retries were spent says only that it was stopped', async () => {
    const h = await accepted(file(entry('retries', MANUAL, LOOK(1))));
    const run = await fire(h, 'retries');
    await endStep(h, run.id, 'look', FAILED_TURN);
    h.advance(MINUTE);
    await h.tick();
    h.service.stop(run.id);
    await endStep(h, run.id, 'look', { exitCode: 143, stopped: 'you stopped it' });
    expect(h.store.get(run.id)).toMatchObject({
      status: 'failed',
      error: 'It stopped before finishing: you stopped it.',
    });
  });

  it('a step that declares none fails as before, its words unchanged', async () => {
    const h = await accepted(file(entry('retries', MANUAL, LOOK())));
    const run = await fire(h, 'retries');
    await endStep(h, run.id, 'look', FAILED_TURN);
    expect(h.store.get(run.id)).toMatchObject({ status: 'failed', error: LOOK_ERROR });
    expect(rowOf(h, run.id, 'look')).not.toHaveProperty('retries');
  });

  it('a dry_run: run command that exited retries; one with intent and no result never does', async () => {
    const yaml = file(
      entry(
        'retries',
        MANUAL,
        '- id: check\n  run: ./check\n  dry_run: run\n  on_failure: { retry: 1 }',
      ),
    );
    const h = await accepted(yaml);
    const run = await fire(h, 'retries');
    await endCommand(h, run.id, 'check', { result: { exitCode: 1 } });
    expect(rowOf(h, run.id, 'check')).toMatchObject({ status: 'waiting', retries: 1 });
    h.advance(MINUTE);
    await h.tick();
    expect(rowOf(h, run.id, 'check')).toMatchObject({ status: 'running', attempt: 2 });
    expect(h.world.commands).toHaveLength(2);
    // Consola quits while it runs: it may have done its work, so it never runs again by itself.
    const again = await h.relaunch();
    expect(again.store.get(run.id)).toMatchObject({ status: 'failed' });
    expect(byId(again.store.get(run.id)!.steps, 'check')).toMatchObject({ status: 'failed' });
    expect(byId(again.store.get(run.id)!.steps, 'check')).not.toHaveProperty('retryAt');
    again.advance(10 * MINUTE);
    await again.tick();
    expect(again.world.commands).toHaveLength(2);
  });

  it('never after a person stopped it', async () => {
    const h = await accepted(file(entry('retries', MANUAL, LOOK(2))));
    const run = await fire(h, 'retries');
    h.service.stop(run.id);
    await endStep(h, run.id, 'look', { exitCode: 143, stopped: 'you stopped it' });
    expect(h.store.get(run.id)).toMatchObject({
      status: 'failed',
      error: 'It stopped before finishing: you stopped it.',
    });
    expect(rowOf(h, run.id, 'look')).not.toHaveProperty('retryAt');
    // And a later run's failure, the stop forgotten with the run, waits again.
    const next = await fire(h, 'retries');
    await endStep(h, next.id, 'look', FAILED_TURN);
    expect(rowOf(h, next.id, 'look').status).toBe('waiting');
  });

  it('a wait whose time passed while Consola was closed goes on at start (Review Focus 2)', async () => {
    const h = await accepted(file(entry('retries', MANUAL, LOOK(2))));
    const run = await fire(h, 'retries');
    await endStep(h, run.id, 'look', FAILED_TURN);
    h.advance(2 * MINUTE);
    const again = await h.relaunch();
    expect(byId(again.store.get(run.id)!.steps, 'look')).toMatchObject({
      status: 'running',
      attempt: 2,
    });
  });

  it('a wait whose time has not come stays across a restart', async () => {
    const h = await accepted(file(entry('retries', MANUAL, LOOK(2))));
    const run = await fire(h, 'retries');
    await endStep(h, run.id, 'look', FAILED_TURN);
    h.advance(30_000);
    const again = await h.relaunch();
    expect(again.store.get(run.id)?.status).toBe('waiting');
    expect(again.world.launches).toHaveLength(1);
  });

  it('a step inside a loop retries in its round', async () => {
    const yaml = file(
      entry(
        'retries',
        MANUAL,
        '- id: polish\n  repeat: { max: 2, until: steps.look.findings == 0 }\n  steps:\n    - id: look\n      prompt: Look again.\n      outputs:\n        findings: { type: integer }\n      on_failure: { retry: 1 }',
      ),
    );
    const h = await accepted(yaml);
    const run = await fire(h, 'retries');
    h.world.setOutputs(rowOf(h, run.id, 'look').sessionId!, { findings: 1 });
    await endStep(h, run.id, 'look');
    await endStep(h, run.id, 'look', FAILED_TURN);
    expect(rowOf(h, run.id, 'look')).toMatchObject({ status: 'waiting', round: 2, retries: 1 });
    expect(rowOf(h, run.id, 'polish')).toMatchObject({ status: 'running', round: 2 });
    h.advance(MINUTE);
    await h.tick();
    expect(rowOf(h, run.id, 'look')).toMatchObject({ status: 'running', round: 2, attempt: 3 });
  });

  it('a step waiting out its retry holds no slot claim: resumed, it waits in line', async () => {
    // Its folder is gone as it is about to launch: it fails before it took its slot.
    const yaml = file(
      entry('retries', MANUAL, LOOK(1)),
      entry('other', MANUAL, '- id: other\n  prompt: Look elsewhere.'),
    );
    const h = await accepted(yaml, { maxConcurrentAgents: 1 });
    h.world.goneFolders.add('/code/catalog-portal');
    const run = await fire(h, 'retries');
    expect(rowOf(h, run.id, 'look')).toMatchObject({ status: 'waiting', retries: 1 });
    h.world.goneFolders.clear();
    await fire(h, 'other');
    expect(h.world.launches).toHaveLength(1);
    h.advance(MINUTE);
    await h.tick();
    expect(rowOf(h, run.id, 'look')).toMatchObject({ status: 'queued', attempt: 2 });
    expect(h.world.launches).toHaveLength(1);
  });

  it('the host shortens the wait (Call 7)', async () => {
    const h = await accepted(file(entry('retries', MANUAL, LOOK(2))), { retryBackoffMs: 500 });
    const run = await fire(h, 'retries');
    const failedAt = h.now();
    await endStep(h, run.id, 'look', FAILED_TURN);
    expect(rowOf(h, run.id, 'look').retryAt).toBe(plus(failedAt, 500));
  });
});

describe("the entry's declared retry", () => {
  const PR51 = inboxItem({ repo: 'sprocket/catalog-portal', number: 51 });
  const DIR = checkoutPathFor(PR51.workItem);
  const ON_51 = (...steps: string[]) =>
    file(entry('again', `${ON_REVIEW}${ENTRY_RETRY()}`, ...steps));

  async function onPr51(yaml: string, options: StepsHarnessOptions = {}): Promise<StepsHarness> {
    const h = await stepsHarness({ yaml, ...options });
    await h.poll([]);
    acceptEvery(h, yaml);
    await h.poll([PR51]);
    return h;
  }

  it('the entry starts again from its first step when nothing acted', async () => {
    const h = await stepsHarness({
      yaml: ON_51('- id: fresh\n  run: ./fresh\n  dry_run: run', LOOK()),
    });
    await h.poll([]);
    acceptEvery(h, ON_51('- id: fresh\n  run: ./fresh\n  dry_run: run', LOOK()));
    h.world.checkouts.fails = new Error('Could not fetch the pull request.');
    const failedAt = h.now();
    await h.poll([PR51]);
    const [run] = h.store.runs();
    expect(h.store.get(run.id)).toMatchObject({
      status: 'waiting',
      retryAt: plus(failedAt, MINUTE),
      error: 'Could not fetch the pull request.',
    });
    expect(h.store.get(run.id)).not.toHaveProperty('finishedAt');
    expect(h.notices.filter((notice) => notice.runId === run.id)).toEqual([]);
    // Waiting, it holds its item: a second fire on it waits.
    expect(h.service.checkoutHeld(DIR)).toBe(true);
    h.world.checkouts.fails = undefined;
    // Not before its time.
    h.advance(MINUTE / 2);
    await h.tick();
    expect(h.store.get(run.id)?.status).toBe('waiting');
    expect(h.world.checkouts.prepared).toHaveLength(1);
    h.advance(MINUTE / 2);
    await h.tick();
    expect(h.store.get(run.id)).toMatchObject({ status: 'running', retried: 1 });
    expect(h.store.get(run.id)?.error).toBeUndefined();
    expect(h.store.get(run.id)?.retryAt).toBeUndefined();
    expect(h.world.checkouts.prepared).toHaveLength(2);
    expect(h.store.get(run.id)?.checkout).toMatchObject({ cwd: DIR, head: h.world.checkouts.head });
    expect(rowOf(h, run.id, 'fresh')).toMatchObject({ status: 'running', attempt: 1 });
    await endCommand(h, run.id, 'fresh');
    await endStep(h, run.id, 'look');
    expect(h.store.get(run.id)?.status).toBe('completed');
  });

  it('a failed step the entry starts again from: every row its next attempt', async () => {
    const h = await onPr51(ON_51('- id: fresh\n  run: ./fresh\n  dry_run: run', LOOK()));
    const [run] = h.store.runs();
    await endCommand(h, run.id, 'fresh');
    await endStep(h, run.id, 'look', FAILED_TURN);
    expect(h.store.get(run.id)).toMatchObject({ status: 'waiting', error: LOOK_ERROR });
    expect(rowOf(h, run.id, 'look')).toMatchObject({ status: 'failed', error: LOOK_ERROR });
    // It starts again at the item's head as it is then: its checkout is prepared again.
    h.world.checkouts.head = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2';
    h.advance(MINUTE);
    await h.tick();
    expect(h.store.get(run.id)).toMatchObject({ status: 'running', retried: 1 });
    expect(h.world.checkouts.prepared).toHaveLength(2);
    expect(h.store.get(run.id)?.checkout).toMatchObject({
      cwd: DIR,
      head: 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2',
    });
    expect(rowOf(h, run.id, 'fresh')).toMatchObject({
      status: 'running',
      attempt: 2,
      previous: [{ attempt: 1, status: 'completed' }],
    });
    expect(rowOf(h, run.id, 'look')).toMatchObject({
      status: 'pending',
      attempt: 2,
      previous: [{ attempt: 1, status: 'failed', error: LOOK_ERROR }],
    });
    // A second failure has no retry left: the run fails, its count on the record.
    await endCommand(h, run.id, 'fresh');
    await endStep(h, run.id, 'look', FAILED_TURN);
    expect(h.store.get(run.id)).toMatchObject({ status: 'failed', error: LOOK_ERROR, retried: 1 });
    expect(h.store.get(run.id)?.retryAt).toBeUndefined();
  });

  it('the entry waits while a session runs in the checkout it would prepare again', async () => {
    const h = await stepsHarness({ yaml: ON_51(LOOK()) });
    await h.poll([]);
    acceptEvery(h, ON_51(LOOK()));
    h.world.checkouts.fails = new Error('Could not fetch the pull request.');
    await h.poll([PR51]);
    const [run] = h.store.runs();
    h.world.checkouts.fails = undefined;
    h.world.busyFolders.add(DIR);
    h.advance(MINUTE);
    await h.tick();
    expect(h.store.get(run.id)).toMatchObject({ status: 'waiting' });
    expect(h.world.checkouts.prepared).toHaveLength(1);
    h.world.busyFolders.delete(DIR);
    await h.tick();
    expect(h.store.get(run.id)).toMatchObject({ status: 'running', retried: 1 });
    expect(h.world.checkouts.prepared).toHaveLength(2);
    expect(rowOf(h, run.id, 'look').status).toBe('running');
  });

  it('a run waiting out its retry holds no slot claim: started again, its step waits in line', async () => {
    // Its command's environment cannot be borrowed: it fails before it took its slot, and nothing acted.
    const yaml = file(
      entry('again', `${MANUAL}${ENTRY_RETRY()}`, '- id: fresh\n  run: ./fresh'),
      entry('busy', MANUAL, '- id: slow\n  run: ./slow'),
    );
    const h = await accepted(yaml, { maxConcurrentCommands: 1 });
    h.world.commandEnvThrows = new Error('The token could not be borrowed.');
    const run = await fire(h, 'again');
    expect(h.store.get(run.id)).toMatchObject({ status: 'waiting', retryAt: expect.any(String) });
    h.world.commandEnvThrows = undefined;
    await fire(h, 'busy');
    expect(h.world.commands).toHaveLength(1);
    h.advance(MINUTE);
    await h.tick();
    expect(h.store.get(run.id)).toMatchObject({ status: 'running', retried: 1 });
    expect(rowOf(h, run.id, 'fresh').status).toBe('queued');
    expect(h.world.commands).toHaveLength(1);
  });

  it('a scope: entry starts again in its scope folder, nothing prepared', async () => {
    const h = await accepted(file(entry('again', `${MANUAL}${ENTRY_RETRY()}`, LOOK())));
    const run = await fire(h, 'again');
    await endStep(h, run.id, 'look', FAILED_TURN);
    expect(h.store.get(run.id)?.status).toBe('waiting');
    h.advance(MINUTE);
    await h.tick();
    expect(h.store.get(run.id)).toMatchObject({
      status: 'running',
      retried: 1,
      checkout: { cwd: '/code/catalog-portal' },
    });
    expect(h.world.launches.at(-1)?.step).toMatchObject({
      id: 'look',
      attempt: 2,
      cwd: '/code/catalog-portal',
    });
  });

  describe('a stopped wait leaves no time behind (review B2)', () => {
    const GATED = file(
      entry(
        'again',
        `${MANUAL}${ENTRY_RETRY()}`,
        LOOK(),
        '- id: post\n  run: ./post',
        '- id: decide\n  gate: { ask: Go on? }',
      ),
    );
    const posts = (h: StepsHarness) =>
      h.world.commands.filter((command) => command.spec.env.CONSOLA_STEP === 'post').length;
    /** `again` in its entry's wait after `look` failed: then the person stops it. */
    async function stoppedInItsWait(h: StepsHarness): Promise<RunRecord> {
      const run = await fire(h, 'again');
      await endStep(h, run.id, 'look', FAILED_TURN);
      expect(h.store.get(run.id)).toMatchObject({ status: 'waiting', retryAt: expect.any(String) });
      h.service.stop(run.id);
      await h.flush();
      return h.store.get(run.id)!;
    }

    it("a person's Stop, then Retry, then a gate: the tick never starts the run again by itself", async () => {
      const h = await accepted(GATED);
      const stopped = await stoppedInItsWait(h);
      expect(stopped).toMatchObject({ status: 'failed', error: 'Stopped before its retry.' });
      expect(stopped.retryAt).toBeUndefined();
      await h.service.retry(stopped.id);
      await h.flush();
      expect(h.store.get(stopped.id)?.retryAt).toBeUndefined();
      await endStep(h, stopped.id, 'look');
      await endCommand(h, stopped.id, 'post');
      await h.flush();
      expect(h.store.get(stopped.id)?.status).toBe('waiting');
      expect(rowOf(h, stopped.id, 'decide').status).toBe('waiting');
      // Past the time the stopped wait had: the person's question stays, and `post` never runs again.
      h.advance(2 * MINUTE);
      await h.tick();
      await h.flush();
      expect(h.store.get(stopped.id)).toMatchObject({ status: 'waiting' });
      expect(h.store.get(stopped.id)?.retried ?? 0).toBe(0);
      expect(rowOf(h, stopped.id, 'decide')).toMatchObject({ status: 'waiting', attempt: 1 });
      expect(rowOf(h, stopped.id, 'post')).toMatchObject({ status: 'completed', attempt: 1 });
      expect(posts(h)).toBe(1);
    });

    it('a Retry of a run an earlier build left with its wait time drops it', async () => {
      const h = await accepted(GATED);
      const stopped = await stoppedInItsWait(h);
      // As a build before this fix left a stopped wait: failed, its time still on it.
      h.store.update(stopped.id, { retryAt: plus(h.now(), MINUTE) });
      await h.service.retry(stopped.id);
      await h.flush();
      expect(h.store.get(stopped.id)).toMatchObject({ status: 'running' });
      expect(h.store.get(stopped.id)?.retryAt).toBeUndefined();
    });

    it('the tick never starts again a run that waits at one of its rows, whatever time the run carries', async () => {
      const h = await accepted(GATED);
      const run = await fire(h, 'again');
      await endStep(h, run.id, 'look');
      await endCommand(h, run.id, 'post');
      await h.flush();
      expect(rowOf(h, run.id, 'decide').status).toBe('waiting');
      // As an earlier build's stopped and retried wait leaves it: a time on the run that no wait of its own set.
      h.store.update(run.id, { retryAt: plus(h.now(), MINUTE) });
      h.advance(2 * MINUTE);
      await h.tick();
      await h.flush();
      expect(h.store.get(run.id)).toMatchObject({ status: 'waiting' });
      expect(h.store.get(run.id)?.retried ?? 0).toBe(0);
      expect(h.store.get(run.id)?.retryAt).toBeUndefined();
      expect(rowOf(h, run.id, 'decide')).toMatchObject({ status: 'waiting', attempt: 1 });
      expect(posts(h)).toBe(1);
      // The person's answer goes on as ever.
      h.service.answerGate(run.id, 'decide', 'approve');
      await h.flush();
      expect(h.store.get(run.id)?.status).toBe('completed');
    });

    it("a step's own retry is resumed at its time, not held back by a later time on the run", async () => {
      const yaml = file(entry('again', `${MANUAL}${ENTRY_RETRY()}`, LOOK(1)));
      const h = await accepted(yaml);
      const run = await fire(h, 'again');
      await endStep(h, run.id, 'look', FAILED_TURN);
      expect(rowOf(h, run.id, 'look')).toMatchObject({
        status: 'waiting',
        retryAt: expect.any(String),
      });
      h.store.update(run.id, { retryAt: plus(h.now(), 60 * MINUTE) });
      h.advance(MINUTE);
      await h.tick();
      await h.flush();
      expect(rowOf(h, run.id, 'look')).toMatchObject({ status: 'running', attempt: 2 });
      expect(h.store.get(run.id)?.retried ?? 0).toBe(0);
    });
  });

  it.each([
    [
      "a command's intent",
      ['- id: post\n  run: ./post', LOOK()],
      async (h: StepsHarness, run: RunRecord) => {
        await endCommand(h, run.id, 'post');
      },
    ],
    [
      'an answered gate',
      ['- id: decide\n  gate: { ask: Go on? }', LOOK()],
      async (h: StepsHarness, run: RunRecord) => {
        h.service.answerGate(run.id, 'decide', 'approve');
        await h.flush();
      },
    ],
  ] as Array<[string, string[], (h: StepsHarness, run: RunRecord) => Promise<void>]>)(
    'the entry does not start again after %s',
    async (_name, steps, before) => {
      const h = await accepted(file(entry('again', `${MANUAL}${ENTRY_RETRY()}`, ...steps)));
      const run = await fire(h, 'again');
      await before(h, run);
      await endStep(h, run.id, 'look', FAILED_TURN);
      expect(h.store.get(run.id)).toMatchObject({ status: 'failed', error: LOOK_ERROR });
      expect(h.store.get(run.id)?.retryAt).toBeUndefined();
    },
  );

  it('the entry does not start again after an agent naming a server started', async () => {
    const yaml = file(
      entry('again', `${MANUAL}${ENTRY_RETRY()}`, '- id: post\n  agent: poster', LOOK()),
    );
    const h = await accepted(yaml, {
      files: {
        'agents/poster.md':
          '---\nharness: claude-work\nmcpServers:\n  - claude.ai Slack\n---\nPost what you found.\n',
      },
      agentHarnesses: { 'claude-work': { name: 'Claude work', problem: null } },
    });
    expect(h.service.list(WORKSPACE_ID)[0].problem).toBeUndefined();
    const run = await fire(h, 'again');
    // Its turn loads the server it names, and ends: an agent that may have posted ran.
    const report = turnReport({});
    await endStep(h, run.id, 'post', {
      exitCode: 0,
      report: { ...report, init: { servers: [{ name: 'claude.ai Slack', status: 'connected' }] } },
    });
    expect(rowOf(h, run.id, 'post').status).toBe('completed');
    await endStep(h, run.id, 'look', FAILED_TURN);
    expect(h.store.get(run.id)).toMatchObject({ status: 'failed', error: LOOK_ERROR });
  });

  it('the entry does not start again once a command ran in an earlier round (review S6)', async () => {
    const yaml = file(
      entry(
        'again',
        `${MANUAL}${ENTRY_RETRY()}`,
        '- id: polish\n  repeat: { max: 2, until: steps.look.findings == 0 }\n  steps:\n    - id: look\n      prompt: Look again.\n      outputs:\n        findings: { type: integer }\n    - id: notify\n      if: steps.look.findings > 0\n      run: ./notify',
      ),
    );
    const h = await accepted(yaml);
    const run = await fire(h, 'again');
    h.world.setOutputs(rowOf(h, run.id, 'look').sessionId!, { findings: 1 });
    await endStep(h, run.id, 'look');
    await endCommand(h, run.id, 'notify');
    await endStep(h, run.id, 'look', FAILED_TURN);
    expect(h.store.get(run.id)).toMatchObject({ status: 'failed' });
    expect(h.store.get(run.id)?.retryAt).toBeUndefined();
    h.advance(10 * MINUTE);
    await h.tick();
    expect(
      h.world.commands.filter((command) => command.spec.env.CONSOLA_STEP === 'notify'),
    ).toHaveLength(1);
  });

  it('a retry of an agent step after an answered gate is refused when the pull request moved', async () => {
    const h = await onPr51(
      file(
        entry(
          'gated',
          ON_REVIEW,
          '- id: look\n  prompt: Look at {{item.url}}.',
          '- id: decide\n  gate: { ask: Post it? }',
          '- id: summary\n  prompt: Sum up {{item.url}}.',
        ),
      ),
    );
    const [run] = h.store.runs();
    await endStep(h, run.id, 'look');
    h.service.answerGate(run.id, 'decide', 'approve');
    await h.flush();
    await endStep(h, run.id, 'summary', FAILED_TURN);
    expect(h.store.get(run.id)?.status).toBe('failed');
    h.world.checkouts.head = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2';
    await expect(h.service.retry(run.id)).rejects.toThrow(
      'This pull request has new commits since you answered `decide`; run it again to review them.',
    );
    // The claim let go, and the run as it was.
    expect(h.service.checkoutHeld(DIR)).toBe(false);
    expect(h.store.get(run.id)?.status).toBe('failed');
    expect(h.store.get(run.id)?.checkout?.head).not.toBe(
      'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2',
    );
  });

  it('a retry with no answered gate goes on at the moved head, as before', async () => {
    const h = await onPr51(
      file(entry('plain', ON_REVIEW, '- id: summary\n  prompt: Sum up {{item.url}}.')),
    );
    const [run] = h.store.runs();
    await endStep(h, run.id, 'summary', FAILED_TURN);
    h.world.checkouts.head = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2';
    await h.service.retry(run.id);
    await h.flush();
    expect(h.store.get(run.id)?.checkout?.head).toBe('b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2');
    expect(rowOf(h, run.id, 'summary')).toMatchObject({ status: 'running', attempt: 2 });
  });

  it('a retry after an answered gate goes on when the pull request did not move', async () => {
    const h = await onPr51(
      file(
        entry(
          'gated',
          ON_REVIEW,
          '- id: look\n  prompt: Look at {{item.url}}.',
          '- id: decide\n  gate: { ask: Post it? }',
          '- id: summary\n  prompt: Sum up {{item.url}}.',
        ),
      ),
    );
    const [run] = h.store.runs();
    await endStep(h, run.id, 'look');
    h.service.answerGate(run.id, 'decide', 'approve');
    await h.flush();
    await endStep(h, run.id, 'summary', FAILED_TURN);
    await h.service.retry(run.id);
    await h.flush();
    expect(rowOf(h, run.id, 'summary')).toMatchObject({ status: 'running', attempt: 2 });
  });

  it('an item that is no pull request is said to have changed', async () => {
    const yaml = file(
      entry(
        'gated',
        '    on: manual\n    applies_to: [issue]\n    mode: auto\n',
        '- id: decide\n  gate: { ask: Look at it? }',
        '- id: summary\n  prompt: Sum up {{item.url}}.',
      ),
    );
    const h = await accepted(yaml);
    const target = {
      workItem: { repo: 'sprocket/catalog-portal', number: 60, type: 'issue' as const },
    };
    const run = (await h.service.trigger(WORKSPACE_ID, 'gated', {}, target))!;
    await h.flush();
    expect(h.store.get(run.id)?.status).toBe('waiting');
    h.service.answerGate(run.id, 'decide', 'approve');
    await h.flush();
    await endStep(h, run.id, 'summary', FAILED_TURN);
    h.world.checkouts.head = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2';
    await expect(h.service.retry(run.id)).rejects.toThrow(
      'This item has changed since you answered `decide`; run it again.',
    );
  });
});
