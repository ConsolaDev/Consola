import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  automationVersion,
  leafSteps,
  parseFactorySpec,
  stableStringify,
  type RunRecord,
  type StepRun,
} from '@consola/factory-spec';
import { OPEN_STATUSES, runAttention } from './AutomationService';
import { inboxItem } from './inboxItems.test-helpers';
import {
  checkoutPathFor,
  stepsHarness,
  WORKSPACE_ID,
  type StepsHarness,
} from './steps/steps.test-helpers';
import { MAX_ARTIFACT_BYTES } from './steps/definition';

/** One `- name:` entry: its head lines as given, then `steps:` with each item's lines. */
function entry(name: string, head: string, ...steps: string[]): string {
  const items = steps.map((step) => `      ${step.replace(/\n/g, '\n      ')}`).join('\n');
  return `  - name: ${name}\n${head}    steps:\n${items}\n`;
}
const file = (...entries: string[]) => `version: 1\nautomations:\n${entries.join('')}`;

const MANUAL = (mode = 'auto') => `    on: manual\n    scope: catalog-portal\n    mode: ${mode}\n`;
const ON_REVIEW = '    on: { github: pull_request.review_requested }\n    mode: auto\n';
const ASK = 'The reviewer would approve this pull request. Post the review as an approval?';

const FRESH = '- id: fresh\n  run: git fetch --prune\n  dry_run: run';
const REVIEW =
  '- id: review\n  prompt: Review what changed and write the review as your handover.\n  outputs:\n    verdict: { enum: [approve, comment, request-changes] }';
const DECIDE = `- id: decide\n  gate:\n    ask: ${ASK}\n    show: [review.handover]\n    choices: [approve, comment]`;
const PUBLISH =
  "- id: publish-decided\n  if: steps.decide.decision == 'approve'\n  run: echo posted";
const GATED_BODY = [FRESH, REVIEW, DECIDE, PUBLISH] as const;
const GATED_ENTRY = file(entry('gated', MANUAL(), ...GATED_BODY));

/** Accept every entry in `yaml` at its version, as a person approving each once would. */
function acceptEvery(h: StepsHarness, yaml: string): void {
  for (const automation of parseFactorySpec(yaml).automations) {
    const bodies: Record<string, string> = {};
    for (const step of leafSteps(automation.steps ?? [])) {
      if (step.kind === 'agent' && step.action)
        bodies[step.id] = h.world.workspace.actions.find(
          (action) => action.name === step.action,
        )!.prompt;
    }
    const body = Object.keys(bodies).length > 0 ? stableStringify(bodies) : undefined;
    h.store.accept(`${WORKSPACE_ID} ${automation.name}`, automationVersion(automation, body));
  }
}

const byId = (steps: StepRun[] | undefined, id: string) =>
  (steps ?? []).find((step) => step.id === id)!;
const stepsOf = (h: StepsHarness, runId: string) => h.store.get(runId)!.steps!;

/** Fire `name` by hand; a new `auto` entry asks first, so its first run is approved as a person would. */
async function fire(h: StepsHarness, name = 'gated'): Promise<RunRecord> {
  const asked = (await h.service.trigger(WORKSPACE_ID, name))!;
  if (asked.status === 'needs-approval') await h.service.approve(asked.id);
  await h.flush();
  return h.store.get(asked.id)!;
}

/** The running agent step of a run ends: its outputs set, its handover written. */
async function endAgent(
  h: StepsHarness,
  runId: string,
  stepId: string,
  outputs: Record<string, unknown> = {},
  handover = 'Two retries are unbounded.',
): Promise<void> {
  const sessionId = byId(stepsOf(h, runId), stepId).sessionId!;
  if (Object.keys(outputs).length > 0) h.world.setOutputs(sessionId, outputs);
  h.world.writeArtifact(sessionId, 'handover', handover);
  await h.world.endTurn(sessionId);
}

/** GATED fired and run up to its gate: fresh ends, then review with `verdict`. */
async function reachDecide(h: StepsHarness, verdict = 'approve'): Promise<RunRecord> {
  const run = await fire(h);
  await h.world.commands.at(-1)!.end();
  await endAgent(h, run.id, 'review', { verdict });
  return h.store.get(run.id)!;
}

const gateNotices = (h: StepsHarness, name = 'gated') =>
  h.notices.filter((notice) => notice.title === `${name} is waiting for you`);

describe('a run parks at a gate', () => {
  it('parks: waiting run and step on one line, before the notification', async () => {
    const h = await stepsHarness({ yaml: GATED_ENTRY });
    const run = await reachDecide(h);
    // Every history line carries the whole record, so the last line would pass a build that wrote the step and
    // the run on two lines, or notified first: assert on the first line that shows the gate waiting (review S5).
    const lines = h.history.appends.filter((line) => line.run.id === run.id);
    const parked = lines.findIndex((line) =>
      line.run.steps?.some((step) => step.id === 'decide' && step.status === 'waiting'),
    );
    expect(parked).toBeGreaterThan(0);
    expect(lines[parked].run).toMatchObject({
      status: 'waiting',
      steps: expect.arrayContaining([
        expect.objectContaining({ id: 'decide', gate: { askedAt: h.now().toISOString() } }),
      ]),
    });
    // The line before it is the run still running: no line has the run waiting with no row at its gate.
    expect(lines[parked - 1].run.status).toBe('running');
    const notice = h.notices.findIndex((n) => n.title === 'gated is waiting for you');
    expect(h.notices[notice]).toEqual({
      title: 'gated is waiting for you',
      body: ASK,
      runId: run.id,
      workspaceId: WORKSPACE_ID,
      needsApproval: false,
    });
    // The line was on disk first.
    expect(h.noticeAppends[notice]).toBeGreaterThan(h.history.appends.indexOf(lines[parked]));
    // Nothing started for the gate, and nothing after it.
    expect(h.world.launches).toHaveLength(1);
    expect(h.world.commands).toHaveLength(1);
    expect(h.store.get(run.id)).toMatchObject({
      status: 'waiting',
      steps: [
        { id: 'fresh', status: 'completed' },
        { id: 'review', status: 'completed', outputs: { verdict: 'approve' } },
        { id: 'decide', kind: 'gate', status: 'waiting' },
        { id: 'publish-decided', status: 'pending' },
      ],
    });
    expect(h.store.get(run.id)).not.toHaveProperty('finishedAt');
  });

  it('holds no slot while parked (review S5)', async () => {
    const yaml = file(
      entry('gated', MANUAL(), ...GATED_BODY),
      entry('other', MANUAL(), '- id: look\n  prompt: Look at what changed.'),
    );
    const h = await stepsHarness({ yaml, maxConcurrentAgents: 1 });
    const gated = await reachDecide(h);
    expect(h.store.get(gated.id)?.status).toBe('waiting');
    const other = await fire(h, 'other');
    expect(h.world.launches).toHaveLength(2);
    expect(byId(stepsOf(h, other.id), 'look')).toMatchObject({ status: 'running' });
  });

  it('a run let in for its gate gives back that slot as it parks, so what runs after the answer waits in line', async () => {
    // A gate first: the run is let in on the command lane, as for a first command; its command after the
    // answer must wait for a slot like any, not overtake on a claim it no longer holds.
    const yaml = file(
      entry(
        'gate-first',
        MANUAL(),
        '- id: decide\n  gate: { ask: Go on? }',
        '- id: after\n  run: pwd',
      ),
      entry('busy', MANUAL(), '- id: slow\n  run: sleep 60'),
    );
    const h = await stepsHarness({ yaml, maxConcurrentCommands: 1 });
    const gated = await fire(h, 'gate-first');
    expect(h.store.get(gated.id)?.status).toBe('waiting');
    await fire(h, 'busy');
    expect(h.world.commands).toHaveLength(1);
    h.service.answerGate(gated.id, 'decide', 'approve');
    await h.flush();
    expect(h.world.commands).toHaveLength(1);
    expect(byId(stepsOf(h, gated.id), 'after').status).toBe('queued');
    await h.world.commands[0].end();
    expect(h.world.commands).toHaveLength(2);
    expect(h.world.commands[1].spec.env.CONSOLA_RUN_ID).toBe(gated.id);
  });

  it('approving a run answers none of its gates (review S5; spec: two acts)', async () => {
    const h = await stepsHarness({ yaml: GATED_ENTRY });
    const run = await reachDecide(h);
    expect(h.store.get(run.id)?.approvedAt).toBeDefined();
    expect(byId(stepsOf(h, run.id), 'decide')).toEqual({
      id: 'decide',
      kind: 'gate',
      status: 'waiting',
      attempt: 1,
      gate: { askedAt: expect.any(String) },
    });

    const confirm = await stepsHarness({
      yaml: file(entry('gated', MANUAL('confirm'), ...GATED_BODY)),
    });
    const asked = (await confirm.service.trigger(WORKSPACE_ID, 'gated'))!;
    expect(asked.status).toBe('needs-approval');
    await confirm.service.approve(asked.id);
    await confirm.flush();
    await confirm.world.commands[0].end();
    await endAgent(confirm, asked.id, 'review', { verdict: 'approve' });
    expect(confirm.store.get(asked.id)?.status).toBe('waiting');
    expect(byId(stepsOf(confirm, asked.id), 'decide').gate).toEqual({
      askedAt: expect.any(String),
    });
  });
});

describe('a person answers a gate', () => {
  it('approve completes the gate with its decision, and the run goes on', async () => {
    const h = await stepsHarness({ yaml: GATED_ENTRY });
    const run = await reachDecide(h);
    h.advance(60_000);
    const answered = h.service.answerGate(run.id, 'decide', 'approve');
    const at = h.now().toISOString();
    expect(byId(answered.steps, 'decide')).toMatchObject({
      status: 'completed',
      outputs: { decision: 'approve' },
      gate: { decision: 'approve', by: 'person', at },
      finishedAt: at,
    });
    await h.flush();
    // The answer and the run going on are one line: never `running` with the gate still waiting.
    const lines = h.history.appends.filter((line) => line.run.id === run.id);
    const after = lines.findIndex(
      (line) => line.run.status === 'running' && line.run.updatedAt === at,
    );
    expect(byId(lines[after].run.steps, 'decide').status).toBe('completed');
    expect(
      lines.filter(
        (line) =>
          line.run.status === 'waiting' && byId(line.run.steps, 'decide').status !== 'waiting',
      ),
    ).toEqual([]);
    expect(h.world.commands).toHaveLength(2);
    expect(h.world.commands[1].spec.command).toBe('echo posted');
    await h.world.commands[1].end();
    expect(h.store.get(run.id)).toMatchObject({
      status: 'completed',
      summary: 'fresh → review → decide → publish-decided (approve, approve)',
    });
  });

  it('a choice completes the gate with its decision, and what reads it follows', async () => {
    const h = await stepsHarness({ yaml: GATED_ENTRY });
    const run = await reachDecide(h);
    h.service.answerGate(run.id, 'decide', 'comment');
    await h.flush();
    expect(h.store.get(run.id)).toMatchObject({
      status: 'completed',
      steps: [
        { id: 'fresh', status: 'completed' },
        { id: 'review', status: 'completed' },
        {
          id: 'decide',
          status: 'completed',
          outputs: { decision: 'comment' },
          gate: { decision: 'comment', by: 'person' },
        },
        { id: 'publish-decided', status: 'skipped' },
      ],
    });
    expect(h.world.commands).toHaveLength(1);
  });

  it('reject ends the run rejected, later steps not-run, nothing posted', async () => {
    const h = await stepsHarness({ yaml: GATED_ENTRY });
    const run = await reachDecide(h);
    const notices = h.notices.length;
    const rejected = h.service.answerGate(run.id, 'decide', 'reject');
    await h.flush();
    expect(rejected).toMatchObject({ status: 'rejected', summary: 'rejected at decide' });
    expect(h.store.get(run.id)).toMatchObject({
      status: 'rejected',
      summary: 'rejected at decide',
      finishedAt: h.now().toISOString(),
      steps: [
        { id: 'fresh', status: 'completed' },
        { id: 'review', status: 'completed' },
        { id: 'decide', status: 'completed', gate: { decision: 'reject', by: 'person' } },
        { id: 'publish-decided', status: 'not-run' },
      ],
    });
    expect(byId(stepsOf(h, run.id), 'decide')).not.toHaveProperty('outputs');
    expect(h.world.commands).toHaveLength(1);
    // One line ends it: the answer and the end together, never a waiting run with nothing waiting.
    const lines = h.history.appends.filter((line) => line.run.id === run.id);
    const answered = lines.findIndex(
      (line) => byId(line.run.steps, 'decide').gate?.decision === 'reject',
    );
    expect(lines[answered].run.status).toBe('rejected');
    // The person made it: no one is told.
    expect(h.notices).toHaveLength(notices);
  });

  it('answering accepts nothing (contract 10)', async () => {
    const h = await stepsHarness({ yaml: GATED_ENTRY });
    const asked = (await h.service.trigger(WORKSPACE_ID, 'gated', { sessionId: 's-9' }))!;
    expect(asked).toMatchObject({ status: 'needs-approval', trigger: { by: 'agent' } });
    await h.service.approve(asked.id);
    await h.flush();
    await h.world.commands[0].end();
    await endAgent(h, asked.id, 'review', { verdict: 'approve' });
    expect(h.store.get(asked.id)?.status).toBe('waiting');
    const approvedAt = h.store.get(asked.id)!.approvedAt;
    expect(approvedAt).toBeDefined();
    h.advance(60_000);
    h.service.answerGate(asked.id, 'decide', 'approve');
    await h.flush();
    expect(h.store.acceptedVersion(`${WORKSPACE_ID} gated`)).toBeUndefined();
    expect(h.store.get(asked.id)?.approvedAt).toBe(approvedAt);
  });

  it('refuses a second answer (Review Focus 4)', async () => {
    const h = await stepsHarness({ yaml: GATED_ENTRY });
    const run = await reachDecide(h);
    h.service.answerGate(run.id, 'decide', 'comment');
    await h.flush();
    const before = JSON.stringify(h.store.get(run.id));
    const lines = h.history.appends.length;
    expect(() => h.service.answerGate(run.id, 'decide', 'approve')).toThrow(
      '`decide` is not waiting for you; reload the run.',
    );
    expect(() => h.service.answerGate(run.id, 'decide', 'reject')).toThrow(
      '`decide` is not waiting for you; reload the run.',
    );
    expect(JSON.stringify(h.store.get(run.id))).toBe(before);
    expect(h.history.appends).toHaveLength(lines);
  });

  it('refuses what is not a choice, and a run or a step that is not there', async () => {
    const h = await stepsHarness({ yaml: GATED_ENTRY });
    const run = await reachDecide(h);
    expect(() => h.service.answerGate(run.id, 'decide', 'request-changes')).toThrow(
      "`request-changes` is not one of `decide`'s choices (approve, comment, or reject).",
    );
    expect(() => h.service.answerGate(run.id, 'review', 'approve')).toThrow(
      '`review` is not waiting for you; reload the run.',
    );
    expect(() => h.service.answerGate('run-404', 'decide', 'approve')).toThrow(
      '`decide` is not waiting for you; reload the run.',
    );
    expect(h.store.get(run.id)?.status).toBe('waiting');
  });

  it("keeps the snapshot's question and choices when the file changes (Review Focus 6)", async () => {
    const h = await stepsHarness({ yaml: GATED_ENTRY });
    const run = await reachDecide(h);
    const edited = GATED_ENTRY.replace(ASK, 'Ship it now?').replace(
      'choices: [approve, comment]',
      'choices: [approve, comment, hold]',
    );
    await h.setYaml(edited);
    expect(h.service.gateOf(run.id, 'decide')).toMatchObject({
      ask: ASK,
      choices: ['approve', 'comment'],
    });
    expect(() => h.service.answerGate(run.id, 'decide', 'hold')).toThrow(
      "`hold` is not one of `decide`'s choices (approve, comment, or reject).",
    );
  });
});

describe('a parked run, as everything else sees it', () => {
  it('is open, live and needs the person; a restart keeps it and raises its notice again', async () => {
    const h = await stepsHarness({ yaml: GATED_ENTRY });
    const run = await reachDecide(h);
    expect(OPEN_STATUSES).toContain('waiting');
    expect(runAttention(h.store.get(run.id)!)).toBe('needs-attention');
    // Live: the snapshot keeps it whatever else ended.
    expect(h.service.snapshot(WORKSPACE_ID).runs.map((entry) => entry.id)).toContain(run.id);
    h.notices.length = 0;
    const again = await h.relaunch();
    expect(again.store.get(run.id)?.status).toBe('waiting');
    expect(byId(again.store.get(run.id)!.steps, 'decide').status).toBe('waiting');
    expect(gateNotices(again)).toEqual([
      {
        title: 'gated is waiting for you',
        body: ASK,
        runId: run.id,
        workspaceId: WORKSPACE_ID,
        needsApproval: false,
      },
    ]);
    // And it goes on from there.
    again.service.answerGate(run.id, 'decide', 'approve');
    await again.flush();
    expect(again.world.commands.at(-1)?.spec.command).toBe('echo posted');
  });

  it('a restart raises no notice for a run that waits at nothing a person answers', async () => {
    const h = await stepsHarness({ yaml: GATED_ENTRY });
    const run = await reachDecide(h);
    h.store.update(run.id, {
      steps: stepsOf(h, run.id).map((step) =>
        step.id === 'decide' ? { ...step, status: 'pending', gate: undefined } : step,
      ),
    });
    h.notices.length = 0;
    const again = await h.relaunch();
    expect(gateNotices(again)).toEqual([]);
  });

  it('wants the person only while it waits at a gate', () => {
    const steps = (status: StepRun['status'], fields: Partial<StepRun> = {}): StepRun[] => [
      { id: 'decide', kind: 'gate', status, attempt: 1, ...fields },
    ];
    expect(
      runAttention({ status: 'waiting', steps: steps('waiting', { gate: { askedAt: 'x' } }) }),
    ).toBe('needs-attention');
    expect(
      runAttention({ status: 'waiting', steps: steps('waiting', { retryAt: 'x' }) }),
    ).toBeNull();
    expect(runAttention({ status: 'running', steps: steps('pending') })).toBeNull();
    expect(runAttention({ status: 'needs-approval' })).toBe('needs-attention');
  });

  it('the list row names the gate', async () => {
    const h = await stepsHarness({ yaml: GATED_ENTRY });
    const run = await reachDecide(h);
    const [listed] = h.service.listRuns(WORKSPACE_ID, { limit: 10 }).runs;
    expect(listed.id).toBe(run.id);
    expect(listed.step).toEqual({
      id: 'decide',
      status: 'waiting',
      index: 3,
      count: 4,
      kind: 'gate',
      gate: true,
    });
    h.service.answerGate(run.id, 'decide', 'reject');
    expect(h.service.listRuns(WORKSPACE_ID, { limit: 10 }).runs[0].step).toEqual({
      id: 'decide',
      status: 'completed',
      index: 3,
      count: 4,
      kind: 'gate',
      gate: true,
    });
  });

  it('a failed run inside a loop names its failed step, not the loop (review S10)', async () => {
    const h = await stepsHarness({ yaml: GATED_ENTRY });
    const run = await reachDecide(h);
    // A record as a run failed in round 2 leaves it: the loop's row failed with its inner step.
    const at = h.now().toISOString();
    h.store.add({
      ...h.store.get(run.id)!,
      id: 'run-loop',
      status: 'failed',
      createdAt: at,
      result: {
        kind: 'steps-run',
        steps: [
          { id: 'polish', kind: 'repeat' },
          { id: 'review', kind: 'agent', loop: 'polish' },
          { id: 'address', kind: 'run', loop: 'polish' },
          { id: 'pr', kind: 'run' },
        ],
      },
      steps: [
        { id: 'polish', kind: 'repeat', status: 'failed', attempt: 1, round: 2, max: 3 },
        { id: 'review', kind: 'agent', status: 'completed', attempt: 2, round: 2 },
        { id: 'address', kind: 'run', status: 'failed', attempt: 2, round: 2, error: 'exit 1' },
        { id: 'pr', kind: 'run', status: 'not-run', attempt: 1 },
      ],
    });
    const listed = h.service
      .listRuns(WORKSPACE_ID, { limit: 10 })
      .runs.find((r) => r.id === 'run-loop');
    expect(listed?.step).toEqual({
      id: 'address',
      status: 'failed',
      index: 3,
      count: 4,
      kind: 'run',
      round: 2,
      max: 3,
      loop: 'polish',
    });
    // A loop that failed on its own (out of rounds) is named by its own row.
    h.store.update('run-loop', {
      steps: [
        {
          id: 'polish',
          kind: 'repeat',
          status: 'failed',
          attempt: 1,
          round: 3,
          max: 3,
          error: 'polish: not clean after 3 rounds',
        },
        { id: 'review', kind: 'agent', status: 'completed', attempt: 3, round: 3 },
        { id: 'address', kind: 'run', status: 'completed', attempt: 3, round: 3 },
        { id: 'pr', kind: 'run', status: 'not-run', attempt: 1 },
      ],
    });
    expect(
      h.service.listRuns(WORKSPACE_ID, { limit: 10 }).runs.find((r) => r.id === 'run-loop')?.step,
    ).toEqual({
      id: 'polish',
      status: 'failed',
      index: 1,
      count: 4,
      kind: 'repeat',
      round: 3,
      max: 3,
    });
  });

  it("a run rejected at a loop's exhaustion gate names the loop's row, not the last step that ran", async () => {
    const h = await stepsHarness({ yaml: GATED_ENTRY });
    const run = await reachDecide(h);
    const at = h.now().toISOString();
    h.store.add({
      ...h.store.get(run.id)!,
      id: 'run-rejected',
      status: 'rejected',
      createdAt: at,
      result: {
        kind: 'steps-run',
        steps: [
          { id: 'polish', kind: 'repeat' },
          { id: 'review', kind: 'agent', loop: 'polish' },
          { id: 'pr', kind: 'run' },
        ],
      },
      steps: [
        {
          id: 'polish',
          kind: 'repeat',
          status: 'completed',
          attempt: 1,
          round: 3,
          max: 3,
          gate: { askedAt: at, decision: 'reject', by: 'person', at },
        },
        { id: 'review', kind: 'agent', status: 'completed', attempt: 3, round: 3 },
        { id: 'pr', kind: 'run', status: 'not-run', attempt: 1 },
      ],
    });
    expect(
      h.service.listRuns(WORKSPACE_ID, { limit: 10 }).runs.find((r) => r.id === 'run-rejected')
        ?.step,
    ).toEqual({
      id: 'polish',
      status: 'completed',
      index: 1,
      count: 3,
      kind: 'repeat',
      round: 3,
      max: 3,
      gate: true,
    });
  });

  it('a fire while the automation waits at a gate returns the parked run and adds none (review B3)', async () => {
    const h = await stepsHarness({ yaml: GATED_ENTRY });
    const run = await reachDecide(h);
    const again = (await h.service.trigger(WORKSPACE_ID, 'gated'))!;
    expect(again.id).toBe(run.id);
    expect(h.store.runs().filter((candidate) => candidate.automationId === 'gated')).toHaveLength(
      1,
    );
    expect(gateNotices(h)).toHaveLength(1);
  });
});

describe('a stop', () => {
  it('a stop while waiting fails the gate, quietly', async () => {
    const h = await stepsHarness({ yaml: GATED_ENTRY });
    const run = await reachDecide(h);
    const notices = h.notices.length;
    h.service.stop(run.id);
    expect(h.store.get(run.id)).toMatchObject({
      status: 'failed',
      error: 'Stopped while it waited for you.',
      finishedAt: h.now().toISOString(),
      steps: [
        { id: 'fresh', status: 'completed' },
        { id: 'review', status: 'completed' },
        { id: 'decide', status: 'failed', error: 'Stopped while it waited for you.' },
        { id: 'publish-decided', status: 'not-run' },
      ],
    });
    expect(h.notices).toHaveLength(notices);
    expect(() => h.service.answerGate(run.id, 'decide', 'approve')).toThrow(
      '`decide` is not waiting for you; reload the run.',
    );
  });

  it("a stop while a step waits out its retry keeps that step's own failure (review S9)", async () => {
    const h = await stepsHarness({ yaml: GATED_ENTRY });
    const run = await reachDecide(h);
    // As a declared retry's wait leaves it (Task 14 makes it; the record is enough here).
    h.store.update(run.id, {
      status: 'waiting',
      steps: stepsOf(h, run.id).map((step) =>
        step.id === 'review'
          ? {
              ...step,
              status: 'waiting',
              error: 'It stopped before finishing (exit 1).',
              retryAt: 'later',
              retries: 1,
            }
          : step.id === 'decide'
            ? { id: 'decide', kind: 'gate', status: 'pending', attempt: 1 }
            : step,
      ),
    });
    h.service.stop(run.id);
    const review = byId(stepsOf(h, run.id), 'review');
    expect(h.store.get(run.id)).toMatchObject({
      status: 'failed',
      error: 'Stopped before its retry.',
    });
    expect(review).toMatchObject({
      status: 'failed',
      error: 'It stopped before finishing (exit 1).',
      retries: 1,
    });
    expect(review).not.toHaveProperty('retryAt');
    expect(byId(stepsOf(h, run.id), 'decide').status).toBe('not-run');
  });

  it('a stop while the run waits out its own retry leaves its rows as they are (review S9)', async () => {
    const h = await stepsHarness({ yaml: GATED_ENTRY });
    const run = await reachDecide(h);
    const rows: StepRun[] = [
      { id: 'fresh', kind: 'run', status: 'pending', attempt: 1 },
      { id: 'review', kind: 'agent', status: 'pending', attempt: 1 },
      { id: 'decide', kind: 'gate', status: 'pending', attempt: 1 },
      { id: 'publish-decided', kind: 'run', status: 'pending', attempt: 1 },
    ];
    h.store.update(run.id, {
      status: 'waiting',
      retryAt: 'later',
      error: 'Could not fetch.',
      steps: rows,
    });
    h.service.stop(run.id);
    expect(h.store.get(run.id)).toMatchObject({
      status: 'failed',
      error: 'Stopped before its retry.',
      steps: rows.map((row) => ({ ...row, status: 'not-run' })),
    });
  });

  it('a stop that lands between steps, the next move a gate, fails the gate and never parks (review S8)', async () => {
    const h = await stepsHarness({ yaml: GATED_ENTRY });
    const run = await fire(h);
    await h.world.commands[0].end();
    // A gate the run has not reached has no card yet.
    expect(h.service.gateOf(run.id, 'decide')).toBeNull();
    // As a crash between two lines leaves it: review done, nothing after it looked at yet.
    const done = {
      status: 'completed' as const,
      outputs: { verdict: 'approve' },
      finishedAt: h.now().toISOString(),
    };
    h.store.update(run.id, {
      steps: stepsOf(h, run.id).map((step) => (step.id === 'review' ? { ...step, ...done } : step)),
    });
    const notices = h.notices.length;
    h.service.stop(run.id);
    expect(h.store.get(run.id)).toMatchObject({
      status: 'failed',
      error: 'Stopped before decide started.',
      steps: [
        { id: 'fresh', status: 'completed' },
        { id: 'review', status: 'completed' },
        { id: 'decide', status: 'failed', error: 'Stopped before decide started.' },
        { id: 'publish-decided', status: 'not-run' },
      ],
    });
    expect(
      h.history.appends.filter((line) => line.run.id === run.id && line.run.status === 'waiting'),
    ).toEqual([]);
    expect(gateNotices(h)).toEqual([]);
    expect(h.notices).toHaveLength(notices);
  });
});

describe('a stop deferred while a gate-first run prepares its checkout', () => {
  it('fails the gate once the preparation ends, and never parks (review S8)', async () => {
    const PR51 = inboxItem({ repo: 'sprocket/catalog-portal', number: 51 });
    const yaml = file(
      entry(
        'gate-first',
        ON_REVIEW,
        '- id: decide\n  gate: { ask: Look at it? }',
        '- id: look\n  prompt: Look at {{item.url}}.',
      ),
    );
    const h = await stepsHarness({ yaml });
    await h.poll([]);
    acceptEvery(h, yaml);
    let release!: () => void;
    h.world.checkouts.gate = new Promise<void>((resolve) => (release = resolve));
    await h.poll([PR51]);
    const [run] = h.store.runs();
    expect(h.store.get(run.id)?.status).toBe('running');
    expect(h.world.checkouts.prepared).toHaveLength(1);
    h.service.stop(run.id);
    expect(h.store.get(run.id)?.status).toBe('running');
    h.world.checkouts.gate = undefined;
    release();
    await h.flush();
    expect(h.store.get(run.id)).toMatchObject({
      status: 'failed',
      error: 'Stopped before decide started.',
      steps: [
        { id: 'decide', status: 'failed', error: 'Stopped before decide started.' },
        { id: 'look', status: 'not-run' },
      ],
    });
    expect(
      h.history.appends.filter((line) => line.run.id === run.id && line.run.status === 'waiting'),
    ).toEqual([]);
    expect(gateNotices(h, 'gate-first')).toEqual([]);
  });
});

describe('then: stop', () => {
  const TRIAGE = file(
    entry(
      'triage',
      MANUAL(),
      '- id: triage\n  prompt: Triage what changed.\n  outputs:\n    kind: { enum: [bug, feature] }',
      "- id: not-ours\n  if: steps.triage.kind == 'feature'\n  run: echo not ours\n  then: stop",
      '- id: fix\n  prompt: Fix the bug.',
    ),
  );

  it('then: stop completes the run and says after which step', async () => {
    const h = await stepsHarness({ yaml: TRIAGE });
    const run = await fire(h, 'triage');
    await endAgent(h, run.id, 'triage', { kind: 'feature' });
    await h.world.commands[0].end();
    expect(h.store.get(run.id)).toMatchObject({
      status: 'completed',
      summary: 'triage → not-ours (feature); stopped after not-ours',
      steps: [
        { id: 'triage', status: 'completed' },
        { id: 'not-ours', status: 'completed' },
        { id: 'fix', status: 'not-run', note: 'the run stopped after `not-ours`' },
      ],
    });
    expect(h.world.launches).toHaveLength(1);
  });

  it('a skipped stop step stops nothing', async () => {
    const h = await stepsHarness({ yaml: TRIAGE });
    const run = await fire(h, 'triage');
    await endAgent(h, run.id, 'triage', { kind: 'bug' });
    expect(byId(stepsOf(h, run.id), 'not-ours').status).toBe('skipped');
    expect(byId(stepsOf(h, run.id), 'fix').status).toBe('running');
  });
});

describe('a gate as the run’s first move takes the checkout as a first step does (review B2)', () => {
  it('a scope: entry whose first step is a gate runs its next command in the scope folder after Approve', async () => {
    const h = await stepsHarness({
      yaml: file(
        entry(
          'gate-first',
          MANUAL(),
          '- id: decide\n  gate: { ask: Go on? }',
          '- id: after\n  run: pwd',
        ),
      ),
    });
    const run = await fire(h, 'gate-first');
    expect(h.store.get(run.id)).toMatchObject({
      status: 'waiting',
      checkout: { cwd: '/code/catalog-portal', scopeId: 'scope-catalog-portal' },
    });
    h.service.answerGate(run.id, 'decide', 'approve');
    await h.flush();
    expect(h.world.commands).toHaveLength(1);
    expect(h.world.commands[0].spec.cwd).toBe('/code/catalog-portal');
    await h.world.commands[0].end();
    expect(h.store.get(run.id)?.status).toBe('completed');
  });

  it("an item run whose first step is a gate waits for the item's checkout like any start, and parks holding it", async () => {
    const PR51 = inboxItem({ repo: 'sprocket/catalog-portal', number: 51 });
    const yaml = file(
      entry('review-it', ON_REVIEW, '- id: look\n  prompt: Look at {{item.url}}.'),
      entry(
        'gate-first',
        ON_REVIEW,
        '- id: decide\n  gate: { ask: Look at it? }',
        '- id: look\n  prompt: Look at {{item.url}}.',
      ),
    );
    const h = await stepsHarness({ yaml });
    await h.poll([]);
    acceptEvery(h, yaml);
    await h.poll([PR51]);
    const review = h.store.runs().find((run) => run.automationId === 'review-it')!;
    const gated = h.store.runs().find((run) => run.automationId === 'gate-first')!;
    expect(byId(stepsOf(h, review.id), 'look').status).toBe('running');
    expect(h.store.get(gated.id)).toMatchObject({
      status: 'queued',
      summary: "waiting for this item's checkout",
    });
    expect(h.world.checkouts.prepared).toHaveLength(1);

    await h.world.endTurn(byId(stepsOf(h, review.id), 'look').sessionId!);
    expect(h.store.get(review.id)?.status).toBe('completed');
    expect(h.world.checkouts.prepared).toHaveLength(2);
    const dir = checkoutPathFor(PR51.workItem);
    expect(h.store.get(gated.id)).toMatchObject({
      status: 'waiting',
      checkout: { cwd: dir, head: h.world.checkouts.head },
    });
    // Run on… the same item while it waits: the parked run is its open run, so it comes back and none is added.
    const target = {
      workItem: { repo: 'sprocket/catalog-portal', number: 51, type: 'pr' as const },
    };
    expect((await h.service.trigger(WORKSPACE_ID, 'gate-first', {}, target))?.id).toBe(gated.id);
    expect(h.store.runs().filter((run) => run.automationId === 'gate-first')).toHaveLength(1);
    h.service.answerGate(gated.id, 'decide', 'approve');
    await h.flush();
    expect(h.world.launches.at(-1)?.step).toMatchObject({ id: 'look', cwd: dir });
    expect(h.world.checkouts.prepared).toHaveLength(2);
  });
});

describe('what a gate shows', () => {
  it('a gate shows what it names, as material', async () => {
    const h = await stepsHarness({ yaml: GATED_ENTRY });
    const run = await reachDecide(h);
    expect(h.service.gateOf(run.id, 'decide')).toEqual({
      runId: run.id,
      stepId: 'decide',
      ask: ASK,
      material: [
        {
          step: 'review',
          name: 'handover',
          label: 'review.handover',
          text: 'Two retries are unbounded.',
          truncated: false,
        },
      ],
      choices: ['approve', 'comment'],
    });
    h.advance(60_000);
    h.service.answerGate(run.id, 'decide', 'comment');
    expect(h.service.gateOf(run.id, 'decide')?.answered).toEqual({
      decision: 'comment',
      by: 'person',
      at: h.now().toISOString(),
    });
  });

  it('shows the end of a document larger than any step may write, saying it was cut', async () => {
    const h = await stepsHarness({ yaml: GATED_ENTRY });
    const run = await reachDecide(h);
    const handover = h.folder.artifactPath(WORKSPACE_ID, run.id, 'review', 1, 'handover');
    fs.mkdirSync(path.dirname(handover), { recursive: true });
    fs.writeFileSync(handover, `${'a'.repeat(10)}${'b'.repeat(MAX_ARTIFACT_BYTES)}`);
    const [material] = h.service.gateOf(run.id, 'decide')!.material;
    expect(material).toMatchObject({ truncated: true });
    expect(material.text).toBe('b'.repeat(MAX_ARTIFACT_BYTES));
  });

  it('shows nothing for a document that is not there, and no gate for a step that asks nothing', async () => {
    const h = await stepsHarness({ yaml: GATED_ENTRY });
    const run = await reachDecide(h);
    fs.rmSync(h.folder.artifactPath(WORKSPACE_ID, run.id, 'review', 1, 'handover'));
    expect(h.service.gateOf(run.id, 'decide')?.material).toEqual([]);
    expect(h.service.gateOf(run.id, 'review')).toBeNull();
    expect(h.service.gateOf(run.id, 'publish-decided')).toBeNull();
    expect(h.service.gateOf('run-404', 'decide')).toBeNull();
  });
});

describe('a parked run holds its item and its checkout (Review Focus 3)', () => {
  const PR51 = inboxItem({ repo: 'sprocket/catalog-portal', number: 51 });
  const DIR = checkoutPathFor(PR51.workItem);
  const PR_51_KEY = 'github:sprocket/catalog-portal:pr:51';
  const ON_DEMAND = '    on: manual\n    applies_to: [pr]\n    mode: auto\n';
  const YAML = file(
    entry(
      'review-gated',
      ON_REVIEW,
      '- id: look\n  prompt: Look at {{item.url}}.',
      '- id: decide\n  gate: { ask: Post it? }',
      '- id: after\n  run: echo posted',
    ),
    entry('second', ON_DEMAND, '- id: again\n  prompt: Look again at {{item.url}}.'),
  );
  const TARGET = { workItem: { repo: 'sprocket/catalog-portal', number: 51, type: 'pr' as const } };

  async function watching(): Promise<StepsHarness> {
    const h = await stepsHarness({ yaml: YAML });
    await h.poll([]);
    acceptEvery(h, YAML);
    await h.poll([PR51]);
    return h;
  }
  const gatedRun = (h: StepsHarness) =>
    h.store.runs().find((run) => run.automationId === 'review-gated')!;
  const secondRun = (h: StepsHarness) =>
    h.store.runs().find((run) => run.automationId === 'second')!;
  const lookEnds = async (h: StepsHarness) => {
    const run = gatedRun(h);
    await h.world.endTurn(byId(stepsOf(h, run.id), 'look').sessionId!);
  };

  it("a run parked at a gate on #51 keeps a second automation's run on #51 waiting, saying what for", async () => {
    const h = await watching();
    await lookEnds(h);
    const gated = gatedRun(h);
    expect(h.store.get(gated.id)?.status).toBe('waiting');
    expect(h.service.checkoutHeld(DIR, PR_51_KEY)).toBe(true);
    expect(h.service.checkoutHeld(DIR)).toBe(true);
    await h.service.trigger(WORKSPACE_ID, 'second', {}, TARGET);
    await h.flush();
    const second = secondRun(h);
    expect(h.store.get(second.id)).toMatchObject({
      status: 'queued',
      summary: "waiting for this item's checkout",
      waitingFor: { gate: { automation: 'review-gated', run: gated.id, step: 'decide' } },
    });
    // Never reset under the parked run.
    expect(h.world.checkouts.prepared).toHaveLength(1);
    expect(h.world.launches).toHaveLength(1);

    h.service.answerGate(gated.id, 'decide', 'approve');
    await h.flush();
    await h.world.commands[0].end();
    expect(h.store.get(gated.id)?.status).toBe('completed');
    // It started, and says no more what it waited for.
    expect(h.store.get(second.id)).toMatchObject({ status: 'running' });
    expect(h.store.get(second.id)?.waitingFor).toBeUndefined();
    expect(h.store.get(second.id)?.summary).not.toBe("waiting for this item's checkout");
    expect(h.world.checkouts.prepared).toHaveLength(2);
  });

  it('starts the moment the parked run ends, saying no more what it waited for', async () => {
    const h = await watching();
    await lookEnds(h);
    const gated = gatedRun(h);
    await h.service.trigger(WORKSPACE_ID, 'second', {}, TARGET);
    await h.flush();
    const second = secondRun(h);
    expect(h.store.get(second.id)?.waitingFor).toBeDefined();
    // A reject ends it at once: the next look is the second run's start.
    h.service.answerGate(gated.id, 'decide', 'reject');
    await h.flush();
    expect(h.store.get(second.id)?.status).toBe('running');
    expect(h.store.get(second.id)?.waitingFor).toBeUndefined();
    expect(
      h.history.appends.some(
        (line) => line.run.id === second.id && line.run.status === 'running' && line.run.waitingFor,
      ),
    ).toBe(false);
  });

  it('says what it waits for once the holder parks, and stops saying it once the gate is answered (review S3)', async () => {
    const h = await watching();
    const gated = gatedRun(h);
    await h.service.trigger(WORKSPACE_ID, 'second', {}, TARGET);
    await h.flush();
    const second = secondRun(h);
    expect(h.store.get(second.id)).toMatchObject({
      status: 'queued',
      summary: "waiting for this item's checkout",
    });
    expect(h.store.get(second.id)?.waitingFor).toBeUndefined();
    const placed = h.store.get(second.id)!.updatedAt;

    await lookEnds(h);
    expect(h.store.get(gated.id)?.status).toBe('waiting');
    expect(h.store.get(second.id)?.waitingFor).toEqual({
      gate: { automation: 'review-gated', run: gated.id, step: 'decide' },
    });
    const linesOf = () => h.history.appends.filter((line) => line.run.id === second.id).length;
    const parked = linesOf();
    // Every later look that finds the same writes nothing.
    await h.tick();
    expect(linesOf()).toBe(parked);

    h.service.answerGate(gated.id, 'decide', 'approve');
    await h.flush();
    await h.tick();
    expect(h.store.get(gated.id)?.status).toBe('running');
    expect(h.store.get(second.id)).toMatchObject({
      status: 'queued',
      summary: "waiting for this item's checkout",
    });
    expect(h.store.get(second.id)?.waitingFor).toBeUndefined();
    // One more line, not one per look.
    expect(linesOf()).toBe(parked + 1);
    // Its place in line is not moved by what it says.
    expect(h.store.get(second.id)?.updatedAt).toBe(placed);
  });

  it('a run waiting out a declared retry holds the checkout too, and names no gate', async () => {
    const h = await watching();
    const gated = gatedRun(h);
    // As a declared retry's wait leaves it (Task 14 makes it; the record is enough here).
    h.store.update(gated.id, {
      status: 'waiting',
      steps: stepsOf(h, gated.id).map((step) =>
        step.id === 'look'
          ? { ...step, status: 'waiting', retryAt: 'later', retries: 1, error: 'x' }
          : step,
      ),
    });
    expect(h.service.checkoutHeld(DIR, PR_51_KEY)).toBe(true);
    await h.service.trigger(WORKSPACE_ID, 'second', {}, TARGET);
    await h.flush();
    expect(h.store.get(secondRun(h).id)).toMatchObject({
      status: 'queued',
      summary: "waiting for this item's checkout",
    });
    expect(h.store.get(secondRun(h).id)?.waitingFor).toBeUndefined();
    // So does the entry's own wait.
    h.store.update(gated.id, {
      steps: stepsOf(h, gated.id).map((step) =>
        step.id === 'look' ? { ...step, status: 'failed', retryAt: undefined } : step,
      ),
      retryAt: 'later',
    });
    expect(h.service.checkoutHeld(DIR, PR_51_KEY)).toBe(true);
    // A run that ended holds nothing.
    h.store.update(gated.id, { status: 'failed', retryAt: undefined });
    expect(h.service.checkoutHeld(DIR, PR_51_KEY)).toBe(false);
  });
});

describe("the cards' flow lines (Call 13)", () => {
  it("puts them on a steps entry's view, and never in its run's definition", async () => {
    const h = await stepsHarness({ yaml: GATED_ENTRY });
    expect(h.service.list(WORKSPACE_ID)[0].flow).toEqual([
      'Stops for you at `decide`.',
      'Nothing retries by itself.',
      'No budget.',
    ]);
    const run = await fire(h);
    expect(h.service.getRunDefinition(run.id)).not.toHaveProperty('flow');
  });
});
