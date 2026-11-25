// @effect-diagnostics nodeBuiltinImport:off globalDate:off - The tests read factory-spec's fixture, hash as the runner does, and give the ring a clock.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTOMATION_NAME_PATTERN } from '@consola/factory-spec';
import {
  type FactoryFile,
  type FactoryPick,
  type FactorySnapshot,
  type GitHubEventNotice,
  ITEM_KINDS,
  OUTPUT_TAIL_MAX,
  type PullRequestFacts,
  RUN_STATUSES,
  type RunRecord,
  readRunRecord,
  STEP_KINDS,
  STEP_STATUSES,
  WAITING_ON,
} from '@consola/runner-protocol';
import { describe, expect, it } from 'vite-plus/test';
import type {
  AgentStepRequest,
  AgentStepResult,
  AgentSteps,
  CommandStepRequest,
  CommandStepResult,
  CommandSteps,
} from '../steps/ports.ts';
import type { CellLink, RingPorts, TokenAnswer, TokenRequest } from './ports.ts';
import { createAutomationsRing, RUNNER_STOPPED } from './ring.ts';

/*
 * The ring over fakes of every port: a cell link that keeps what is said and answers from a
 * table, step ports that answer as each test scripts them, a clock that moves a millisecond each
 * read, and SHA-256. Every record said is read by the protocol's own `readRunRecord` and held to
 * the cell's `checkRun` vocabulary (`apps/cloud-region/src/domain/run.ts`), so a record the ring
 * sends is one the cell stores.
 */

const FIXTURE = fileURLToPath(
  new URL('../../../../factory-spec/src/fixtures/review-pull-requests', import.meta.url),
);

/** Every file under `folder`, by its path inside it. */
function filesIn(folder: string, prefix = ''): FactoryFile[] {
  return readdirSync(join(folder, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory()
      ? filesIn(folder, path)
      : [{ path, content: readFileSync(join(folder, path), 'utf8') }];
  });
}

/** The canonical Review pull requests files (factory-spec's fixture), as the cell stores them. */
const REVIEW_FILES = filesIn(FIXTURE);
const REVIEW_FACTORY: FactorySnapshot = {
  factoryId: 'factory-sprocket',
  version: 3,
  files: REVIEW_FILES,
};

const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

const opened = (fields: Partial<PullRequestFacts> = {}): PullRequestFacts => ({
  name: 'pull_request',
  action: 'opened',
  repository: 'sprocket/catalog-portal',
  number: 42,
  url: 'https://github.com/sprocket/catalog-portal/pull/42',
  title: 'Add a retry to the catalog sync',
  author: 'JaviDev',
  draft: false,
  headSha: HEAD,
  headRef: 'fix/catalog-retry',
  baseRef: 'main',
  fork: false,
  ...fields,
});

const eventOf = (deliveryId: string, event = opened()): GitHubEventNotice => ({
  type: 'github.event',
  deliveryId,
  event,
});

/** The cell's run id rule, its ISO time and its item address, as `checkRun` holds them. */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

/** What the cell's `checkRun` refuses in a record, as its problems would name them. */
function checkRunProblems(run: RunRecord): string[] {
  const problems: string[] = [];
  const has = (list: readonly string[], value: string | null) =>
    value === null || list.includes(value);
  if (!RUN_ID.test(run.id)) problems.push('id');
  if (!has(RUN_STATUSES, run.status)) problems.push('status');
  if ((run.status === 'waiting') !== (run.waitingOn !== null) || !has(WAITING_ON, run.waitingOn)) {
    problems.push('waitingOn');
  }
  if (
    run.request === null &&
    (run.automation === null || !AUTOMATION_NAME_PATTERN.test(run.automation))
  ) {
    problems.push('automation');
  }
  if (run.item !== null) {
    if (!run.item.url.startsWith('https://')) problems.push('item.url');
    if (!has(ITEM_KINDS, run.item.kind)) problems.push('item.kind');
  }
  for (const [i, step] of run.steps.entries()) {
    if (!has(STEP_KINDS, step.kind) || step.kind === 'orchestrator')
      problems.push(`steps[${i}].kind`);
    if (!has(STEP_STATUSES, step.status)) problems.push(`steps[${i}].status`);
    if (step.attempt < 1) problems.push(`steps[${i}].attempt`);
    for (const time of [step.startedAt, step.finishedAt]) {
      if (time !== null && !ISO_TIME.test(time)) problems.push(`steps[${i}] time`);
    }
    for (const stream of [step.output?.stdout, step.output?.stderr]) {
      if (stream !== undefined && utf8Bytes(stream) > OUTPUT_TAIL_MAX)
        problems.push(`steps[${i}].output`);
    }
  }
  for (const time of [run.createdAt, run.updatedAt, run.startedAt, run.finishedAt]) {
    if (time !== null && !ISO_TIME.test(time)) problems.push('time');
  }
  return problems;
}

type Said =
  | { type: 'run.record'; run: RunRecord }
  | { type: 'github.event.ack'; deliveryId: string };

/** A cell link that keeps what is said, answers factories from a table and tokens by a rule. */
class FakeLink implements CellLink {
  readonly said: Said[] = [];
  readonly asked: Array<FactoryPick | undefined> = [];
  readonly tokens: TokenRequest[] = [];
  up = true;
  readonly factoriesHeld: FactorySnapshot[];
  readonly answerToken: (request: TokenRequest) => TokenAnswer;
  constructor(
    factoriesHeld: FactorySnapshot[],
    answerToken: (request: TokenRequest) => TokenAnswer = (request) => ({
      ok: true,
      token: `ghs_${Object.keys(request.permissions).join('_')}_${request.stepId}_0123456789`,
    }),
  ) {
    this.factoriesHeld = factoriesHeld;
    this.answerToken = answerToken;
  }

  send(message: Said): boolean {
    if (message.type === 'run.record') {
      const read = readRunRecord(JSON.parse(JSON.stringify(message.run)));
      if (!read.ok) throw new Error(`the protocol refuses a record: ${read.reason}`);
      const problems = checkRunProblems(message.run);
      if (problems.length > 0)
        throw new Error(`the cell would refuse a record: ${problems.join(', ')}`);
    }
    if (!this.up) return false;
    this.said.push(message);
    return true;
  }

  async factories(only?: FactoryPick): Promise<readonly FactorySnapshot[]> {
    this.asked.push(only);
    return only === undefined
      ? this.factoriesHeld
      : this.factoriesHeld.filter(
          (factory) => factory.factoryId === only.factoryId && factory.version === only.version,
        );
  }

  async token(request: TokenRequest): Promise<TokenAnswer> {
    this.tokens.push(request);
    return this.answerToken(request);
  }

  records(id?: string): RunRecord[] {
    return this.said.flatMap((message) =>
      message.type === 'run.record' && (id === undefined || message.run.id === id)
        ? [message.run]
        : [],
    );
  }

  latest(id?: string): RunRecord {
    const records = this.records(id);
    const last = records[records.length - 1];
    if (last === undefined) throw new Error('no record said');
    return last;
  }

  acks(): string[] {
    return this.said.flatMap((message) =>
      message.type === 'github.event.ack' ? [message.deliveryId] : [],
    );
  }
}

const completedAgent = (fields: Partial<AgentStepResult> = {}): AgentStepResult => ({
  status: 'completed',
  error: null,
  outputs: {},
  artifacts: [],
  costUsd: null,
  turns: null,
  deniedTools: [],
  reminded: false,
  output: { stdout: 'Reviewed.', stderr: '', truncated: false },
  ...fields,
});

const exited = (fields: Partial<CommandStepResult> = {}): CommandStepResult => ({
  exitCode: 0,
  signal: null,
  error: null,
  stdoutBytes: 0,
  stderrBytes: 0,
  output: { stdout: '', stderr: '', truncated: false },
  outputs: {},
  ...fields,
});

/** Step ports that answer as the test says, keeping every request. */
class FakeSteps implements AgentSteps, CommandSteps {
  readonly agents: AgentStepRequest[] = [];
  readonly commands: CommandStepRequest[] = [];
  agent: (request: AgentStepRequest, signal: AbortSignal) => Promise<AgentStepResult> = async () =>
    completedAgent();
  command: (request: CommandStepRequest, signal: AbortSignal) => Promise<CommandStepResult> =
    async () => exited();

  run(request: AgentStepRequest, signal: AbortSignal): Promise<AgentStepResult>;
  run(request: CommandStepRequest, signal: AbortSignal): Promise<CommandStepResult>;
  run(request: AgentStepRequest | CommandStepRequest, signal: AbortSignal) {
    if ('prompt' in request) {
      this.agents.push(request);
      return this.agent(request, signal);
    }
    this.commands.push(request);
    return this.command(request, signal);
  }
}

/** A ring over fakes; `clock` moves a millisecond each read. */
function ringOver(link: FakeLink, steps = new FakeSteps()) {
  let ms = Date.parse('2026-11-25T10:00:00.000Z');
  const logged: string[] = [];
  const ports: RingPorts = {
    link,
    agentSteps: steps,
    commandSteps: steps,
    now: () => new Date(ms++).toISOString(),
    digest: (text) => createHash('sha256').update(text, 'utf8').digest('hex'),
    log: (line) => logged.push(line),
  };
  return { ring: createAutomationsRing(ports), steps, logged };
}

const answered = (run: RunRecord, decision: 'approved' | 'rejected' = 'approved') =>
  ({ type: 'run.answered', run, decision, personId: 'person-sprocket-1' }) as const;

/** The review the reviewer agent leaves: its verdict and its handover. */
const REVIEW = '# Review\n\nThe retry never backs off: `src/sync.ts:42` loops at once.\n';
const reviewed = completedAgent({
  outputs: { verdict: 'COMMENT' },
  artifacts: [{ name: 'handover', content: REVIEW }],
});

describe('a GitHub event', () => {
  it('records one run waiting for approval for each automation it matches, then acknowledges it', async () => {
    const link = new FakeLink([REVIEW_FACTORY]);
    const { ring } = ringOver(link);
    ring.receive(eventOf('d0c5-0001'));
    await ring.settled();

    expect(link.asked).toEqual([undefined]);
    expect(link.acks()).toEqual(['d0c5-0001']);
    const records = link.records();
    expect(records).toHaveLength(1);
    const run = link.latest();
    expect(run).toMatchObject({
      status: 'needs-approval',
      waitingOn: null,
      trigger: 'event',
      triggerDetail: 'pull_request.opened',
      runner: 'cloud',
      automation: 'review-pr',
      factoryId: 'factory-sprocket',
      factoryVersion: 3,
      parent: null,
      request: null,
      startedBy: null,
      item: {
        url: 'https://github.com/sprocket/catalog-portal/pull/42',
        title: 'Add a retry to the catalog sync',
        kind: 'pr',
        repo: 'sprocket/catalog-portal',
        number: 42,
        headSha: HEAD,
        baseRef: 'main',
      },
    });
    expect(run.id).toMatch(/^run-[0-9a-f]{32}$/);
    expect(
      run.steps.map(({ id, kind, status, attempt, agent }) => ({
        id,
        kind,
        status,
        attempt,
        agent,
      })),
    ).toEqual([
      { id: 'review', kind: 'agent', status: 'pending', attempt: 1, agent: 'reviewer' },
      { id: 'post', kind: 'run', status: 'pending', attempt: 1, agent: null },
    ]);
    // Nothing runs before a person approves it.
    expect(link.tokens).toEqual([]);
  });

  it('records one run for an event delivered twice, by the same id, even after a restart', async () => {
    const link = new FakeLink([REVIEW_FACTORY]);
    const { ring } = ringOver(link);
    ring.receive(eventOf('d0c5-0002'));
    await ring.settled();
    ring.receive(eventOf('d0c5-0002'));
    await ring.settled();
    expect(link.records()).toHaveLength(1);
    expect(link.acks()).toEqual(['d0c5-0002', 'd0c5-0002']);

    const restarted = new FakeLink([REVIEW_FACTORY]);
    const again = ringOver(restarted);
    again.ring.receive(eventOf('d0c5-0002'));
    await again.ring.settled();
    expect(restarted.latest().id).toBe(link.latest().id);
    // Another delivery is another run.
    again.ring.receive(eventOf('d0c5-0003'));
    await again.ring.settled();
    expect(new Set(restarted.records().map((run) => run.id)).size).toBe(2);
  });

  it('acknowledges an event no trigger names, recording nothing', async () => {
    const link = new FakeLink([REVIEW_FACTORY]);
    const { ring } = ringOver(link);
    ring.receive(eventOf('d0c5-0004', opened({ action: 'closed' })));
    ring.receive(eventOf('d0c5-0005', opened({ draft: true })));
    await ring.settled();
    expect(link.records()).toEqual([]);
    expect(link.acks()).toEqual(['d0c5-0004', 'd0c5-0005']);
  });

  it('acknowledges nothing when the cell sends no factories, so the cell sends the event again', async () => {
    const link = new FakeLink([REVIEW_FACTORY]);
    link.factories = async () => {
      throw new Error('The cell did not answer within 30 s.');
    };
    const { ring, logged } = ringOver(link);
    ring.receive(eventOf('d0c5-0006'));
    await ring.settled();
    expect(link.said).toEqual([]);
    expect(logged.join('\n')).toContain('not acknowledged');
  });
});

/** The run the ring recorded for an event, as the cell stores it and sends it back. */
async function recordedRun(
  files: FactoryFile[] = REVIEW_FILES,
  event = opened(),
): Promise<RunRecord> {
  const link = new FakeLink([{ ...REVIEW_FACTORY, files }]);
  const { ring } = ringOver(link);
  ring.receive(eventOf('d0c5-1000', event));
  await ring.settled();
  return link.latest();
}

describe('an approved run', () => {
  it('walks the review: the agent reviews, the command posts the handover with the step’s token, and the run completes', async () => {
    const stored = await recordedRun();
    // A runner that restarted since: it keeps nothing, so it rebuilds the run from the record.
    const link = new FakeLink([REVIEW_FACTORY]);
    const steps = new FakeSteps();
    steps.agent = async () => reviewed;
    steps.command = async () =>
      exited({ stdoutBytes: 12, output: { stdout: '{"id":7}\n', stderr: '', truncated: false } });
    const { ring } = ringOver(link, steps);
    ring.receive(answered(stored));
    await ring.settled();

    expect(link.asked).toEqual([{ factoryId: 'factory-sprocket', version: 3 }]);
    const [agent] = steps.agents;
    expect(agent).toMatchObject({
      runId: stored.id,
      stepId: 'review',
      attempt: 1,
      harness: 'claude',
      model: null,
      policy: 'read-only',
      maxTurns: null,
      outputs: { verdict: { type: 'enum', values: ['APPROVE', 'COMMENT', 'REQUEST_CHANGES'] } },
      requiredArtifacts: ['handover'],
      allowedArtifacts: ['handover'],
      readable: [],
      checkout: {
        repository: 'sprocket/catalog-portal',
        commit: HEAD,
        pullRequest: 42,
        baseRef: 'main',
      },
      cloneToken: 'ghs_contents_review_0123456789',
    });
    // The engine's prompt: the item's identity trusted, its title fenced, the changes listed, no tool it cannot call.
    expect(agent?.prompt).toContain(
      '[Consola] Step "review" (1 of 2) of the automation "review-pr" (run ',
    );
    expect(agent?.prompt).toContain(
      'for pull request #42 in sprocket/catalog-portal (https://github.com/sprocket/catalog-portal/pull/42)',
    );
    expect(agent?.prompt).toContain(
      'Your standing instructions (agents/reviewer.md):\nYou review pull requests.',
    );
    expect(agent?.prompt).toContain(
      '  - changes (the files pull request #42 changes, and its diff against main)',
    );
    expect(agent?.prompt).toContain('<untrusted-data>\ntitle: "Add a retry to the catalog sync"');
    expect(agent?.prompt).not.toContain('work_item_context');
    expect(agent?.reminder({ outputs: ['verdict'], artifacts: [] })).toBe(
      'You ended without: verdict (consola_set_outputs). Set it now; do nothing else.',
    );

    const [command] = steps.commands;
    expect(command).toMatchObject({
      runId: stored.id,
      stepId: 'post',
      attempt: 1,
      checkout: { repository: 'sprocket/catalog-portal', commit: HEAD, pullRequest: 42 },
      cloneToken: 'ghs_contents_post_0123456789',
      env: {
        REPO: 'sprocket/catalog-portal',
        NUMBER: '42',
        VERDICT: 'COMMENT',
        CONSOLA_RUN_ID: stored.id,
        CONSOLA_STEP: 'post',
        CONSOLA_CHECKOUT_HEAD: HEAD,
      },
      secretEnv: { GH_TOKEN: 'ghs_pull_requests_post_0123456789' },
      fileEnv: { BODY_FILE: 'documents/review/1/handover.md' },
      files: [{ path: 'documents/review/1/handover.md', content: REVIEW }],
    });
    expect(command?.command).toContain('gh api "repos/$REPO/pulls/$NUMBER/reviews"');
    expect(link.tokens.map(({ stepId, permissions }) => ({ stepId, permissions }))).toEqual([
      { stepId: 'review', permissions: { contents: 'read' } },
      { stepId: 'post', permissions: { contents: 'read' } },
      { stepId: 'post', permissions: { pull_requests: 'write' } },
    ]);

    const run = link.latest(stored.id);
    expect(run).toMatchObject({
      status: 'completed',
      summary: 'review → post (COMMENT)',
      error: null,
      waitingOn: null,
    });
    expect(run.startedAt).not.toBeNull();
    expect(run.finishedAt).not.toBeNull();
    const [review, post] = run.steps;
    expect(review).toMatchObject({
      status: 'completed',
      outputs: { verdict: 'COMMENT' },
      artifacts: [{ name: 'handover', bytes: utf8Bytes(REVIEW) }],
      output: { stdout: 'Reviewed.', stderr: '', truncated: false },
      turn: null,
    });
    expect(post).toMatchObject({
      status: 'completed',
      command: { exitCode: 0, signal: null, stdoutBytes: 12, stderrBytes: 0, truncated: false },
      output: { stdout: '{"id":7}\n', stderr: '', truncated: false },
    });
    // Every change was said: the run starting, each step starting and ending, the run ending.
    expect(link.records(stored.id).map((record) => record.status)).toEqual([
      'running',
      'running',
      'running',
      'running',
      'running',
      'completed',
    ]);
    // No token is in any record.
    expect(JSON.stringify(link.said)).not.toContain('ghs_');
  });

  it('fails as the engine fails it when its agent step fails: the steps after it never run', async () => {
    const stored = await recordedRun();
    const link = new FakeLink([REVIEW_FACTORY]);
    const steps = new FakeSteps();
    steps.agent = async () =>
      completedAgent({ status: 'failed', error: 'The step did not end within 1800 s.' });
    const { ring } = ringOver(link, steps);
    ring.receive(answered(stored));
    await ring.settled();
    expect(steps.commands).toEqual([]);
    const run = link.latest(stored.id);
    expect(run).toMatchObject({ status: 'failed', error: 'The step did not end within 1800 s.' });
    expect(run.steps.map(({ id, status, error }) => ({ id, status, error }))).toEqual([
      { id: 'review', status: 'failed', error: 'The step did not end within 1800 s.' },
      { id: 'post', status: 'not-run', error: null },
    ]);
  });

  it('fails an agent step that left a declared output or document unset, in the engine’s words', async () => {
    const stored = await recordedRun();
    const link = new FakeLink([REVIEW_FACTORY]);
    const steps = new FakeSteps();
    steps.agent = async () =>
      completedAgent({
        outputs: { verdict: 'MAYBE' },
        artifacts: [{ name: 'notes', content: 'x' }],
      });
    const { ring } = ringOver(link, steps);
    ring.receive(answered(stored));
    await ring.settled();
    const run = link.latest(stored.id);
    expect(run.status).toBe('failed');
    // Never trusted: the port's outputs are checked again against the declaration.
    expect(run.steps[0]?.error).toBe(
      "What it left was refused: `notes` is not a document it writes; verdict must be one of APPROVE, COMMENT, REQUEST_CHANGES (got 'MAYBE').",
    );

    const missing = new FakeLink([REVIEW_FACTORY]);
    const empty = new FakeSteps();
    const second = ringOver(missing, empty);
    second.ring.receive(answered(stored));
    await second.ring.settled();
    expect(missing.latest(stored.id).steps[0]?.error).toBe(
      'ended without setting verdict, and without writing handover',
    );
  });

  it('fails the command step on the cell’s refusal of its token, in the cell’s words', async () => {
    const stored = await recordedRun();
    const link = new FakeLink([REVIEW_FACTORY], (request) =>
      'pull_requests' in request.permissions
        ? {
            ok: false,
            reason: 'The GitHub App may not write pull requests on sprocket/catalog-portal.',
          }
        : { ok: true, token: 'ghs_contents_0123456789' },
    );
    const steps = new FakeSteps();
    steps.agent = async () => reviewed;
    const { ring } = ringOver(link, steps);
    ring.receive(answered(stored));
    await ring.settled();
    expect(steps.commands).toEqual([]);
    const run = link.latest(stored.id);
    expect(run.status).toBe('failed');
    expect(run.steps[1]).toMatchObject({
      status: 'failed',
      error:
        'The cell gave no token for its `permissions:`: The GitHub App may not write pull requests on sprocket/catalog-portal.',
    });
  });

  it('fails a command that exits non-zero with its last stderr line, masked of its token', async () => {
    const stored = await recordedRun();
    const link = new FakeLink([REVIEW_FACTORY]);
    const steps = new FakeSteps();
    steps.agent = async () => reviewed;
    steps.command = async (request) => {
      const stderr = `gh: HTTP 422 (token ${request.secretEnv.GH_TOKEN ?? ''})\n`;
      return exited({
        exitCode: 1,
        stderrBytes: utf8Bytes(stderr),
        output: { stdout: '', stderr, truncated: false },
      });
    };
    const { ring } = ringOver(link, steps);
    ring.receive(answered(stored));
    await ring.settled();
    const post = link.latest(stored.id).steps[1];
    expect(post?.error).toBe('exit 1: gh: HTTP 422 (token ***)');
    expect(post?.output?.stderr).toBe('gh: HTTP 422 (token ***)\n');
  });

  it('is rejected: recorded rejected, nothing run', async () => {
    const stored = await recordedRun();
    const link = new FakeLink([REVIEW_FACTORY]);
    const { ring, steps } = ringOver(link);
    ring.receive(answered(stored, 'rejected'));
    await ring.settled();
    expect(link.asked).toEqual([]);
    expect(steps.agents).toEqual([]);
    const run = link.latest(stored.id);
    expect(run.status).toBe('rejected');
    expect(run.steps.map((step) => step.status)).toEqual(['not-run', 'not-run']);
    expect(run.finishedAt).not.toBeNull();
  });

  it('fails in a sentence when its factory version is gone, or no longer holds its automation', async () => {
    const stored = await recordedRun();
    const gone = new FakeLink([]);
    const first = ringOver(gone);
    first.ring.receive(answered(stored));
    await first.ring.settled();
    expect(gone.latest(stored.id)).toMatchObject({
      status: 'failed',
      error: 'Version 3 of its factory is gone, so it cannot run.',
    });

    const renamed = REVIEW_FILES.map((file) =>
      file.path === 'automations/review-pr.yaml'
        ? { path: 'automations/review.yaml', content: file.content }
        : file,
    );
    const moved = new FakeLink([{ ...REVIEW_FACTORY, files: renamed }]);
    const second = ringOver(moved);
    second.ring.receive(answered(stored));
    await second.ring.settled();
    expect(moved.latest(stored.id)).toMatchObject({
      status: 'failed',
      error: 'Its automation `review-pr` is not in version 3 of its factory.',
    });
    expect(second.steps.agents).toEqual([]);
  });

  it('fails in a sentence when its record names no head commit', async () => {
    const stored = await recordedRun();
    const link = new FakeLink([REVIEW_FACTORY]);
    const { ring, steps } = ringOver(link);
    ring.receive(answered({ ...stored, item: stored.item && { ...stored.item, headSha: null } }));
    await ring.settled();
    expect(steps.agents).toEqual([]);
    expect(link.latest(stored.id).steps[0]?.error).toBe(
      "Its record does not name the pull request's head commit, so this runner has no commit to check out.",
    );
  });

  it('ignores an answer for a run it is already running', async () => {
    const stored = await recordedRun();
    const link = new FakeLink([REVIEW_FACTORY]);
    const steps = new FakeSteps();
    let release: (result: AgentStepResult) => void = () => {};
    steps.agent = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const { ring, logged } = ringOver(link, steps);
    ring.receive(answered(stored));
    await waitFor(() => steps.agents.length === 1);
    ring.receive(answered(stored));
    release(reviewed);
    await ring.settled();
    expect(steps.agents).toHaveLength(1);
    expect(logged.join('\n')).toContain('already running, ignored');
  });
});

/** Waits a few turns of the event loop for `done`. */
async function waitFor(done: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !done(); i++) await new Promise((resolve) => setImmediate(resolve));
  if (!done()) throw new Error('it did not happen');
}

/** A factory of one automation, with the reviewer agent beside it. */
function factoryWith(automation: string): FactoryFile[] {
  return [
    { path: 'factory.yml', content: 'version: 1\n' },
    { path: 'automations/flow.yaml', content: automation },
    ...REVIEW_FILES.filter((file) => file.path.startsWith('agents/')),
  ];
}

const FLOW = `on: { github: pull_request.opened }
steps:
  - id: triage
    agent: reviewer
    prompt: Say whether this pull request needs a full review.
    outputs:
      verdict: { enum: [small, large] }
  - id: deep
    if: steps.triage.verdict == 'large'
    agent: reviewer
    prompt: Review it in full.
  - id: note
    run: echo noted
    then: stop
  - id: after
    run: echo never
`;

describe('the engine’s routing', () => {
  it('skips a step whose `if:` is false and ends at `then: stop`, as the engine does', async () => {
    const files = factoryWith(FLOW);
    const stored = await recordedRun(files);
    const link = new FakeLink([{ ...REVIEW_FACTORY, files }]);
    const steps = new FakeSteps();
    steps.agent = async () =>
      completedAgent({
        outputs: { verdict: 'small' },
        artifacts: [{ name: 'handover', content: 'Small.' }],
      });
    const { ring } = ringOver(link, steps);
    ring.receive(answered(stored));
    await ring.settled();
    expect(steps.agents.map((request) => request.stepId)).toEqual(['triage']);
    expect(steps.commands.map((request) => request.stepId)).toEqual(['note']);
    const run = link.latest(stored.id);
    expect(run.status).toBe('completed');
    expect(run.summary).toBe('triage → note (small); deep skipped; stopped after note');
    expect(run.steps.map(({ id, status, skipped }) => ({ id, status, skipped }))).toEqual([
      { id: 'triage', status: 'completed', skipped: null },
      { id: 'deep', status: 'skipped', skipped: "if: steps.triage.verdict == 'large' is false" },
      { id: 'note', status: 'completed', skipped: null },
      { id: 'after', status: 'not-run', skipped: null },
    ]);
  });

  it('runs the step an `if:` lets in, handing it what it reads', async () => {
    const files = factoryWith(
      FLOW.replace(
        '    prompt: Review it in full.\n',
        '    prompt: Review it in full.\n    reads: [triage.handover]\n',
      ),
    );
    const stored = await recordedRun(files);
    const link = new FakeLink([{ ...REVIEW_FACTORY, files }]);
    const steps = new FakeSteps();
    steps.agent = async (request) =>
      request.stepId === 'triage'
        ? completedAgent({
            outputs: { verdict: 'large' },
            artifacts: [{ name: 'handover', content: 'Large.' }],
          })
        : completedAgent();
    const { ring } = ringOver(link, steps);
    ring.receive(answered(stored));
    await ring.settled();
    expect(steps.agents.map((request) => request.stepId)).toEqual(['triage', 'deep']);
    expect(steps.agents[1]?.readable).toEqual([{ name: 'triage.handover', content: 'Large.' }]);
    expect(steps.agents[1]?.prompt).toContain('  - triage.handover (from step "triage", 6 B)');
  });

  it('runs a loop’s rounds until its `until` holds, each round a new attempt, as the engine does', async () => {
    const files = factoryWith(`on: { github: pull_request.opened }
steps:
  - id: polish
    repeat: { max: 3, until: steps.look.findings == 0 }
    steps:
      - id: look
        agent: reviewer
        prompt: Count what is left to fix.
        outputs:
          findings: { type: integer }
      - id: fix
        if: steps.look.findings > 0
        run: ./fix
  - id: done
    run: echo done
`);
    const stored = await recordedRun(files);
    const link = new FakeLink([{ ...REVIEW_FACTORY, files }]);
    const steps = new FakeSteps();
    let left = 2;
    steps.agent = async () =>
      completedAgent({
        outputs: { findings: left-- },
        artifacts: [{ name: 'handover', content: 'Looked.' }],
      });
    const { ring } = ringOver(link, steps);
    ring.receive(answered(stored));
    await ring.settled();
    expect(steps.agents.map((request) => request.attempt)).toEqual([1, 2, 3]);
    expect(steps.commands.map((request) => `${request.stepId}#${request.attempt}`)).toEqual([
      'fix#1',
      'fix#2',
      'done#1',
    ]);
    const run = link.latest(stored.id);
    expect(run.status).toBe('completed');
    // A loop's own row has no step kind in the cell's vocabulary: its steps carry its rounds.
    expect(run.steps.map(({ id, status, attempt }) => ({ id, status, attempt }))).toEqual([
      { id: 'look', status: 'completed', attempt: 3 },
      { id: 'fix', status: 'skipped', attempt: 3 },
      { id: 'done', status: 'completed', attempt: 1 },
    ]);
    expect(run.steps[0]?.previous.map(({ attempt, status }) => ({ attempt, status }))).toEqual([
      { attempt: 1, status: 'completed' },
      { attempt: 2, status: 'completed' },
    ]);
  });

  it('fails at the boundary once the run spent its budget, as the engine does', async () => {
    const files = factoryWith(
      FLOW.replace(
        'on: { github: pull_request.opened }\n',
        'on: { github: pull_request.opened }\nbudget: { usd: 0.5 }\n',
      ),
    );
    const stored = await recordedRun(files);
    const link = new FakeLink([{ ...REVIEW_FACTORY, files }]);
    const steps = new FakeSteps();
    steps.agent = async () =>
      completedAgent({
        outputs: { verdict: 'large' },
        artifacts: [{ name: 'handover', content: 'Large.' }],
        costUsd: 0.75,
      });
    const { ring } = ringOver(link, steps);
    ring.receive(answered(stored));
    await ring.settled();
    expect(steps.agents.map((request) => request.stepId)).toEqual(['triage']);
    const run = link.latest(stored.id);
    expect(run).toMatchObject({
      status: 'failed',
      error: 'over its budget: $0.7500 spent of $0.5000',
      costUsd: 0.75,
    });
    expect(run.steps[0]?.costUsd).toBe(0.75);
  });

  it('parks at a gate, waiting on a person, saying the web cannot answer it yet', async () => {
    const files = factoryWith(`on: { github: pull_request.opened }
steps:
  - id: triage
    agent: reviewer
    prompt: Triage it.
  - id: confirm
    gate: { ask: Post the review? }
  - id: post
    run: echo posted
`);
    const stored = await recordedRun(files);
    const link = new FakeLink([{ ...REVIEW_FACTORY, files }]);
    const steps = new FakeSteps();
    steps.agent = async () =>
      completedAgent({ artifacts: [{ name: 'handover', content: 'Fine.' }] });
    const { ring } = ringOver(link, steps);
    ring.receive(answered(stored));
    await ring.settled();
    const run = link.latest(stored.id);
    expect(run).toMatchObject({
      status: 'waiting',
      waitingOn: 'person',
      error:
        'It waits at the gate `confirm` for a person. Answering a gate from the web is not built yet, so it waits here.',
    });
    // A gate has no step kind in the cell's vocabulary yet: its row is not in the record.
    expect(run.steps.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'triage', status: 'completed' },
      { id: 'post', status: 'pending' },
    ]);
    expect(steps.commands).toEqual([]);
  });

  it.each([
    [
      'harness: codex',
      'Its agent `reviewer` runs on `codex`; a cloud runner runs agent steps on claude for now.',
    ],
    [
      'harness: claude\nmcpServers:\n  - grafana',
      'Its agent `reviewer` names MCP servers, which a cloud runner does not grant yet.',
    ],
  ])('fails a step whose agent asks for %s, in one sentence', async (front, error) => {
    const files = REVIEW_FILES.map((file) =>
      file.path === 'agents/reviewer.md'
        ? {
            ...file,
            content: file.content.replace('tools: read-only', `tools: read-only\n${front}`),
          }
        : file,
    );
    const stored = await recordedRun(files);
    const link = new FakeLink([{ ...REVIEW_FACTORY, files }]);
    const { ring, steps } = ringOver(link);
    ring.receive(answered(stored));
    await ring.settled();
    expect(steps.agents).toEqual([]);
    expect(link.latest(stored.id).steps[0]?.error).toBe(error);
    expect(link.latest(stored.id).status).toBe('failed');
  });
});

describe('the runner stopping and the socket dropping', () => {
  it('fails the running step, saying so, records it, and ignores the port’s late answer', async () => {
    const stored = await recordedRun();
    const link = new FakeLink([REVIEW_FACTORY]);
    const steps = new FakeSteps();
    let aborted = false;
    let release: (result: AgentStepResult) => void = () => {};
    steps.agent = (_request, signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          aborted = true;
        });
        release = resolve;
      });
    const { ring } = ringOver(link, steps);
    ring.receive(answered(stored));
    await waitFor(() => steps.agents.length === 1);
    ring.stop();
    expect(aborted).toBe(true);
    const stopped = link.latest(stored.id);
    expect(stopped.status).toBe('failed');
    expect(stopped.steps.map(({ status, error }) => ({ status, error }))).toEqual([
      { status: 'failed', error: RUNNER_STOPPED },
      { status: 'not-run', error: null },
    ]);
    const said = link.said.length;
    release(reviewed);
    await ring.settled();
    expect(link.said).toHaveLength(said);
    expect(steps.commands).toEqual([]);
  });

  it('ends, saying why, an approved run it stopped before starting, and records no event while stopping', async () => {
    const stored = await recordedRun();
    const link = new FakeLink([REVIEW_FACTORY]);
    const { ring, steps } = ringOver(link);
    ring.stop();
    ring.receive(answered(stored));
    ring.receive(eventOf('d0c5-3000'));
    await ring.settled();
    expect(steps.agents).toEqual([]);
    expect(link.latest(stored.id)).toMatchObject({
      status: 'failed',
      error: 'The runner stopped before it could start this run.',
    });
    // Not acknowledged: the cell sends the event again, to a runner that runs.
    expect(link.acks()).toEqual([]);
  });

  it('says every run’s latest record again on a new socket, and starts no step again', async () => {
    const link = new FakeLink([REVIEW_FACTORY]);
    const { ring, steps } = ringOver(link);
    link.up = false;
    ring.receive(eventOf('d0c5-2000'));
    await ring.settled();
    // Said while the socket was down: nothing arrived.
    expect(link.said).toEqual([]);
    link.up = true;
    ring.connected();
    expect(link.records()).toHaveLength(1);
    expect(link.latest().status).toBe('needs-approval');
    ring.connected();
    expect(link.records()).toHaveLength(2);
    expect(steps.agents).toEqual([]);
  });
});
