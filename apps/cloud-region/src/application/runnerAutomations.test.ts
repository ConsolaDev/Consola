import { type GitHubTokenRequest, readGitHubTokenRequest } from '@consola/cloud-contract';
import {
  type GitHubStepTokenRequest,
  RUN_PROBLEM_TEXT_MAX,
  RUN_PROBLEMS_MAX,
  readCellMessage,
} from '@consola/runner-protocol';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Database, migrateDatabase, openDatabase } from '../adapters/persistence/database.js';
import { createDrizzleStores } from '../adapters/persistence/stores.js';
import { gitHubEvents as eventTable } from '../adapters/persistence/tables.js';
import type { Factory } from '../domain/factory.js';
import { HELD_EVENTS_MAX, HELD_EVENTS_WINDOW_SECONDS, handOverOf } from '../domain/gitHubEvent.js';
import { NO_STEP_DETAIL, type RunWrite, type StepRecord } from '../domain/run.js';
import { MINT_REFUSALS } from '../domain/stepToken.js';
import type {
  AutomationPorts,
  FactoryStore,
  GitHubEventStore,
  GitHubTokenMint,
  RunStore,
  TeamStore,
  WorkspaceCopies,
} from './ports.js';
import {
  ANSWERS_ON_HELLO_MAX,
  acknowledgeEvent,
  answerFactoriesRequest,
  issueStepToken,
  pendingForHello,
  recordRunnerRun,
} from './runnerAutomations.js';

let db: Database;
let close: () => Promise<void>;
let copies: WorkspaceCopies;
let teams: TeamStore;
let factories: FactoryStore;
let runs: RunStore;
let gitHubEvents: GitHubEventStore;

beforeEach(async () => {
  ({ db, close } = openDatabase('pglite:memory'));
  await migrateDatabase(db);
  ({ workspaceCopies: copies, teams, factories, runs, gitHubEvents } = createDrizzleStores(db));
});

afterEach(async () => {
  await close();
});

const NOW = 1_800_000_000;
const T = new Date(NOW * 1000).toISOString();
const HEAD = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00';
/** A stand-in for an installation token, never a real one. */
const TOKEN = 'ghs_sprocketStandInToken0123456789abcdef';

const REVIEW = `on: { github: pull_request.opened }
steps:
  - id: review
    prompt: Review it.
    outputs: { verdict: { enum: [APPROVE, COMMENT] } }
  - id: post
    run: gh api "repos/$REPO/pulls/$NUMBER/reviews" -f event=COMMENT
    env: { REPO: "{{item.repo}}", NUMBER: "{{item.number}}" }
    permissions: { pull_requests: write }
  - id: label
    run: gh issue edit "$NUMBER" --add-label reviewed
    env: { NUMBER: "{{item.number}}" }
    permissions: { issues: write }
`;

const FILES = [
  { path: 'factory.yml', content: 'version: 1\n' },
  { path: 'automations/review-pr.yaml', content: REVIEW },
];

/** Opens `workspaceId` in the copy, with a factory whose version 2 holds the review files. */
async function workspaceWithFactory(workspaceId: string, name = 'Reviews'): Promise<Factory> {
  await copies.applyAfter({
    workspaceId,
    sequence: 1,
    after: null,
    change: { kind: 'open-workspace' },
  });
  const [first] = await teams.list(workspaceId);
  if (!first) throw new Error('no first team');
  const factory = await factories.create(workspaceId, { name, teamId: first.id, personId: 'p' });
  if (typeof factory === 'string') throw new Error(factory);
  const saved = await factories.save(workspaceId, factory.id, {
    baseVersion: 1,
    files: FILES,
    personId: 'person-dana',
  });
  if (saved.kind !== 'saved') throw new Error(saved.kind);
  return factory;
}

const step = (id: string, status: StepRecord['status'], kind: StepRecord['kind']): StepRecord => ({
  id,
  kind,
  status,
  attempt: 1,
  agent: null,
  model: null,
  startedAt: null,
  finishedAt: null,
  costUsd: null,
  error: null,
  skipped: null,
  ...NO_STEP_DETAIL,
});

const run = (factoryId: string, over: Partial<RunWrite> = {}): RunWrite => ({
  id: 'run-1',
  factoryId,
  factoryVersion: 2,
  parent: null,
  automation: 'review-pr',
  status: 'running',
  waitingOn: null,
  trigger: 'event',
  triggerDetail: 'pull_request.opened',
  startedBy: null,
  item: {
    url: 'https://github.com/sprocket/catalog-portal/pull/7',
    title: 'Price the catalog in euros',
    kind: 'pr',
    repo: 'sprocket/catalog-portal',
    number: 7,
    headSha: HEAD,
    baseRef: 'main',
  },
  runner: 'cloud',
  steps: [step('review', 'completed', 'agent'), step('post', 'running', 'run')],
  request: null,
  summary: null,
  error: null,
  costUsd: null,
  createdAt: T,
  startedAt: T,
  finishedAt: null,
  updatedAt: T,
  ...over,
});

/** A pull request event GitHub sent through installation 41, recorded held for the runner. */
async function recordEvent(
  deliveryId: string,
  over: { workspaceId?: string; installationId?: number; repositoryId?: number } = {},
) {
  const payload = {
    action: 'opened',
    pull_request: {
      number: 7,
      html_url: 'https://github.com/sprocket/catalog-portal/pull/7',
      title: 'Price the catalog in euros',
      user: { login: 'dana-sprocket' },
      draft: false,
      head: { sha: HEAD, ref: 'euro-prices', repo: { id: over.repositoryId ?? 410 } },
      base: { ref: 'main', repo: { id: over.repositoryId ?? 410 } },
    },
    repository: { id: over.repositoryId ?? 410, full_name: 'sprocket/catalog-portal' },
    installation: { id: over.installationId ?? 41 },
  };
  const recorded = await gitHubEvents.record(
    {
      workspaceId: over.workspaceId ?? 'sprocket',
      region: 'eu',
      deliveryId,
      event: 'pull_request',
      installationId: over.installationId ?? 41,
      payload,
    },
    {
      handOver: handOverOf('pull_request', payload),
      repository: { id: over.repositoryId ?? 410, fullName: 'sprocket/catalog-portal' },
    },
  );
  expect(recorded).toBe('recorded');
}

/** Sets when an event was received, in seconds since the epoch. */
const receivedAt = (deliveryId: string, seconds: number) =>
  db
    .update(eventTable)
    .set({ receivedAt: new Date(seconds * 1000) })
    .where(eq(eventTable.deliveryId, deliveryId));

describe('recordRunnerRun', () => {
  it("records a run for the socket's workspace, and answers nothing", async () => {
    const factory = await workspaceWithFactory('sprocket');
    expect(await recordRunnerRun(runs, 'sprocket', run(factory.id))).toBeNull();
    expect(await runs.recordOf('sprocket', 'run-1')).toEqual(run(factory.id));
  });

  it('answers nothing for a record older than the one held, and changes nothing', async () => {
    const factory = await workspaceWithFactory('sprocket');
    const later = new Date((NOW + 60) * 1000).toISOString();
    await recordRunnerRun(runs, 'sprocket', run(factory.id, { updatedAt: later }));
    expect(
      await recordRunnerRun(runs, 'sprocket', run(factory.id, { status: 'failed' })),
    ).toBeNull();
    expect((await runs.recordOf('sprocket', 'run-1'))?.status).toBe('running');
  });

  it('refuses a first record of a run that moved on, newer or not: a run never moves backwards', async () => {
    const factory = await workspaceWithFactory('sprocket');
    await recordRunnerRun(
      runs,
      'sprocket',
      run(factory.id, { status: 'completed', finishedAt: T }),
    );
    // A runner that restarted records the event the cell handed it again, as new.
    const afresh = run(factory.id, {
      status: 'needs-approval',
      startedAt: null,
      updatedAt: new Date((NOW + 60) * 1000).toISOString(),
    });
    const refusal = await recordRunnerRun(runs, 'sprocket', afresh);
    expect(refusal).toEqual({
      type: 'run.refused',
      runId: 'run-1',
      problems: [
        {
          field: 'status',
          message:
            'The workspace holds this run past waiting for approval, and a run never moves backwards: the record is kept as it was.',
        },
      ],
    });
    expect(readCellMessage(JSON.parse(JSON.stringify(refusal))).ok).toBe(true);
    expect((await runs.recordOf('sprocket', 'run-1'))?.status).toBe('completed');
  });

  it("never records a run in another workspace than the socket's: its factory is no factory there", async () => {
    await workspaceWithFactory('sprocket');
    const theirs = await workspaceWithFactory('globex', 'Theirs');
    expect(await recordRunnerRun(runs, 'sprocket', run(theirs.id))).toEqual({
      type: 'run.refused',
      runId: 'run-1',
      problems: [
        {
          field: 'factoryVersion',
          message: 'The workspace has no such factory, or the factory no such version.',
        },
      ],
    });
    expect(await runs.recordOf('sprocket', 'run-1')).toBeNull();
    expect(await runs.recordOf('globex', 'run-1')).toBeNull();
  });

  it('answers run.refused with every problem checkRun found, within the bounds', async () => {
    const factory = await workspaceWithFactory('sprocket');
    const broken = run(factory.id, {
      automation: `x ${'y'.repeat(3000)}`,
      steps: Array.from({ length: RUN_PROBLEMS_MAX + 6 }, (_, i) => ({
        ...step(`s${i}`, 'pending', 'run'),
        attempt: 0,
      })),
    });
    const refusal = await recordRunnerRun(runs, 'sprocket', broken);
    expect(refusal?.problems).toHaveLength(RUN_PROBLEMS_MAX);
    for (const problem of refusal?.problems ?? []) {
      expect(problem.message.length).toBeLessThanOrEqual(RUN_PROBLEM_TEXT_MAX);
    }
    expect(readCellMessage(JSON.parse(JSON.stringify(refusal))).ok).toBe(true);
    expect(await runs.recordOf('sprocket', 'run-1')).toBeNull();
  });

  it('refuses a parent it does not hold, and a run whose identity changed', async () => {
    const factory = await workspaceWithFactory('sprocket');
    const child = run(factory.id, {
      id: 'child',
      parent: { runId: 'no-request', move: 1 },
      trigger: 'manual',
    });
    expect((await recordRunnerRun(runs, 'sprocket', child))?.problems[0]?.field).toBe(
      'parent.runId',
    );
    await recordRunnerRun(runs, 'sprocket', run(factory.id));
    const other = await factories.create('sprocket', {
      name: 'Other',
      teamId: (await teams.list('sprocket'))[0]?.id ?? '',
      personId: 'p',
    });
    if (typeof other === 'string') throw new Error(other);
    const moved = run(other.id, {
      factoryVersion: 1,
      updatedAt: new Date((NOW + 1) * 1000).toISOString(),
    });
    expect((await recordRunnerRun(runs, 'sprocket', moved))?.problems[0]?.field).toBe('id');
  });
});

describe('acknowledgeEvent', () => {
  it('marks a held event acknowledged, once, in its own workspace alone', async () => {
    await workspaceWithFactory('sprocket');
    await workspaceWithFactory('globex');
    await recordEvent('d-1');
    expect(await acknowledgeEvent(gitHubEvents, 'globex', 'd-1')).toBe('not-held');
    expect(await acknowledgeEvent(gitHubEvents, 'sprocket', 'd-1')).toBe('acknowledged');
    expect(await acknowledgeEvent(gitHubEvents, 'sprocket', 'd-1')).toBe('not-held');
    expect(await acknowledgeEvent(gitHubEvents, 'sprocket', 'unknown')).toBe('not-held');
  });
});

describe('answerFactoriesRequest', () => {
  it("answers every factory of the socket's workspace at its latest version, with its files", async () => {
    const factory = await workspaceWithFactory('sprocket');
    await workspaceWithFactory('globex', 'Theirs');
    const { answer, left } = await answerFactoriesRequest(factories, 'sprocket', {
      type: 'factories.request',
      requestId: 'req-1',
    });
    expect(answer).toEqual({
      type: 'factories',
      requestId: 'req-1',
      factories: [{ factoryId: factory.id, version: 2, files: expect.arrayContaining(FILES) }],
    });
    expect(left).toEqual([]);
  });

  it('answers the one factory and version `only` names, and none for one it does not hold', async () => {
    const factory = await workspaceWithFactory('sprocket');
    const theirs = await workspaceWithFactory('globex', 'Theirs');
    const ask = (only: { factoryId: string; version: number }) =>
      answerFactoriesRequest(factories, 'sprocket', {
        type: 'factories.request',
        requestId: 'req-1',
        only,
      });
    expect((await ask({ factoryId: factory.id, version: 1 })).answer.factories).toEqual([
      { factoryId: factory.id, version: 1, files: [] },
    ]);
    expect((await ask({ factoryId: factory.id, version: 9 })).answer.factories).toEqual([]);
    expect((await ask({ factoryId: theirs.id, version: 2 })).answer.factories).toEqual([]);
  });

  it('leaves out a factory that does not fit one frame, and says so', async () => {
    await workspaceWithFactory('sprocket');
    const { answer, left } = await answerFactoriesRequest(
      factories,
      'sprocket',
      { type: 'factories.request', requestId: 'req-1' },
      200,
    );
    expect(answer.factories).toEqual([]);
    expect(left).toEqual([expect.objectContaining({ version: 2, reason: 'too-large' })]);
  });
});

describe('pendingForHello', () => {
  const ports = () => ({ gitHubEvents, runs, clock: { nowSeconds: () => NOW } });

  it('sends again every held event of the last day, oldest first, and not one acknowledged', async () => {
    await workspaceWithFactory('sprocket');
    await recordEvent('d-old');
    await recordEvent('d-1');
    await recordEvent('d-2');
    await recordEvent('d-acked');
    await receivedAt('d-old', NOW - HELD_EVENTS_WINDOW_SECONDS - 1);
    await receivedAt('d-1', NOW - 60);
    await receivedAt('d-2', NOW - 30);
    await receivedAt('d-acked', NOW - 10);
    await acknowledgeEvent(gitHubEvents, 'sprocket', 'd-acked');

    const { events } = await pendingForHello(ports(), 'sprocket');
    expect(events.events.map((each) => each.deliveryId)).toEqual(['d-1', 'd-2']);
    expect(events.events[0]?.facts).toMatchObject({ name: 'pull_request', headSha: HEAD });
    // The one older than a day is left held, and counted.
    expect(events.left).toBe(1);
    expect(await pendingForHello(ports(), 'globex')).toEqual({
      events: { events: [], unreadable: [], left: 0 },
      answers: [],
    });
  });

  it(`sends at most the newest ${HELD_EVENTS_MAX}, counting the rest`, async () => {
    await workspaceWithFactory('sprocket');
    for (let i = 0; i < HELD_EVENTS_MAX + 3; i += 1) {
      const id = `d-${String(i).padStart(4, '0')}`;
      await recordEvent(id);
      await receivedAt(id, NOW - 1000 + i);
    }
    const { events } = await pendingForHello(ports(), 'sprocket');
    expect(events.events).toHaveLength(HELD_EVENTS_MAX);
    expect(events.events[0]?.deliveryId).toBe('d-0003');
    expect(events.left).toBe(3);
  });

  it('tells every run that still waits with an answer for its version, as the runner hears it', async () => {
    const factory = await workspaceWithFactory('sprocket');
    const waiting = run(factory.id, { status: 'needs-approval', startedAt: null });
    await recordRunnerRun(runs, 'sprocket', waiting);
    await recordRunnerRun(runs, 'sprocket', { ...waiting, id: 'run-2' });
    await runs.answer('sprocket', 'run-1', {
      version: 2,
      decision: 'dismissed',
      personId: 'person-fay',
    });
    const { answers } = await pendingForHello(ports(), 'sprocket');
    expect(answers).toEqual([{ run: waiting, decision: 'rejected', personId: 'person-fay' }]);
    expect(ANSWERS_ON_HELLO_MAX).toBeGreaterThan(0);
  });
});

describe('issueStepToken', () => {
  /** What the cell asked cloud-global for, and what cloud-global answers. */
  let signed: GitHubTokenRequest[];
  let mint: GitHubTokenMint;

  const minted = (over: Partial<Extract<GitHubTokenMint, { kind: 'minted' }>> = {}) => ({
    kind: 'minted' as const,
    token: TOKEN,
    expiresAt: NOW + 3600,
    repositories: [{ id: 410, fullName: 'sprocket/catalog-portal' }],
    permissions: { contents: 'read', pull_requests: 'write', metadata: 'read' },
    ...over,
  });

  const ports = (over: Partial<AutomationPorts> = {}): AutomationPorts => ({
    gitHubEvents,
    runs,
    factories,
    clock: { nowSeconds: () => NOW },
    gitHubTokens: {
      signer: {
        sign: async (request) => {
          signed.push(request);
          return 'signed.request.jws';
        },
      },
      minter: { mint: async () => mint },
    },
    ...over,
  });

  const ask = (over: Partial<GitHubStepTokenRequest> = {}): GitHubStepTokenRequest => ({
    type: 'github.token.request',
    requestId: 'req-1',
    runId: 'run-1',
    stepId: 'post',
    repository: 'sprocket/catalog-portal',
    permissions: { pull_requests: 'write' },
    ...over,
  });

  beforeEach(async () => {
    signed = [];
    mint = minted();
    const factory = await workspaceWithFactory('sprocket');
    await recordRunnerRun(runs, 'sprocket', run(factory.id));
    await recordEvent('d-1');
  });

  const reasonOf = async (request = ask(), over: Partial<AutomationPorts> = {}) => {
    const answer = await issueStepToken(ports(over), 'sprocket', request);
    if (answer.type !== 'github.token.refused') throw new Error('a token was given');
    expect(JSON.stringify(answer)).not.toContain(TOKEN);
    expect(readCellMessage(JSON.parse(JSON.stringify(answer))).ok).toBe(true);
    return answer.reason;
  };

  it("gives a running run's step a token for what it declares, asked as review-run for the event's installation and repository", async () => {
    const answer = await issueStepToken(ports(), 'sprocket', ask());
    expect(answer).toEqual({
      type: 'github.token',
      requestId: 'req-1',
      token: TOKEN,
      expiresAt: new Date((NOW + 3600) * 1000).toISOString(),
    });
    expect(readCellMessage(JSON.parse(JSON.stringify(answer))).ok).toBe(true);
    expect(signed).toEqual([
      {
        aud: 'consola-global',
        workspaceId: 'sprocket',
        installationId: 41,
        purpose: 'review-run',
        repositoryIds: [410],
        iat: NOW,
        exp: NOW + 60,
      },
    ]);
    expect(readGitHubTokenRequest(signed[0], NOW).ok).toBe(true);
  });

  it('gives any step of a running run its checkout, contents read, as run-read', async () => {
    mint = minted({ permissions: { contents: 'read', metadata: 'read' } });
    const answer = await issueStepToken(
      ports(),
      'sprocket',
      ask({ stepId: 'review', permissions: { contents: 'read', metadata: 'read' } }),
    );
    expect(answer.type).toBe('github.token');
    expect(signed[0]?.purpose).toBe('run-read');
  });

  it("asks with the installation and repository of the newest event from the repository, never the runner's", async () => {
    await recordEvent('d-2', { installationId: 52, repositoryId: 411 });
    await receivedAt('d-1', NOW - 100);
    await receivedAt('d-2', NOW - 10);
    mint = minted({ repositories: [{ id: 411, fullName: 'sprocket/catalog-portal' }] });
    await issueStepToken(ports(), 'sprocket', ask({ repository: 'Sprocket/Catalog-Portal' }));
    expect(signed[0]).toMatchObject({ installationId: 52, repositoryIds: [411] });
  });

  it('refuses, in order, a run it does not hold or that does not run', async () => {
    expect(await reasonOf(ask({ runId: 'no-run' }))).toBe(
      'The workspace holds no run with this id.',
    );
    // Another workspace's run is no run of this one's.
    expect(await issueStepToken(ports(), 'globex', ask())).toMatchObject({
      type: 'github.token.refused',
      reason: 'The workspace holds no run with this id.',
    });
    const factory = (await factories.list('sprocket'))[0];
    await recordRunnerRun(
      runs,
      'sprocket',
      run(factory?.id ?? '', {
        status: 'completed',
        finishedAt: T,
        updatedAt: new Date((NOW + 5) * 1000).toISOString(),
      }),
    );
    expect(await reasonOf()).toBe('The run is completed: only a running run gets a GitHub token.');
    expect(signed).toEqual([]);
  });

  it("refuses a repository other than the run's item's", async () => {
    expect(await reasonOf(ask({ repository: 'sprocket/other' }))).toBe(
      "A run's GitHub token is only for its item's repository.",
    );
  });

  it('refuses more than the checkout for a step that is no run: step, or that declares none of it', async () => {
    expect(await reasonOf(ask({ stepId: 'review' }))).toBe(
      'Only a `run:` step gets a GitHub token beyond its checkout.',
    );
    expect(await reasonOf(ask({ stepId: 'deploy' }))).toBe(
      "The run's automation has no step with this id.",
    );
    expect(await reasonOf(ask({ stepId: 'label' }))).toBe(
      'The step does not declare pull_requests: write in its permissions, so its run gets no token for it.',
    );
    expect(signed).toEqual([]);
  });

  it('refuses what the step declares when no purpose grants exactly it', async () => {
    expect(await reasonOf(ask({ stepId: 'label', permissions: { issues: 'write' } }))).toMatch(
      /^No GitHub token a run can have grants exactly issues: write/,
    );
    expect(signed).toEqual([]);
  });

  it('refuses a repository the workspace recorded no event from, and a cell with no key', async () => {
    await db.delete(eventTable);
    expect(await reasonOf()).toBe(
      'The cell has recorded no GitHub event from this repository, so it does not know its installation.',
    );
    await recordEvent('d-1');
    expect(await reasonOf(ask(), { gitHubTokens: null })).toBe(
      'This cell is not set up to ask for GitHub tokens.',
    );
  });

  it("says cloud-global's refusal and failure in words", async () => {
    mint = { kind: 'refused', refusal: 'repository-not-covered' };
    expect(await reasonOf()).toBe(MINT_REFUSALS['repository-not-covered']);
    mint = { kind: 'unavailable' };
    expect(await reasonOf()).toBe(MINT_REFUSALS.unavailable);
  });

  it('keeps a token wider, narrower or on other repositories than asked, and says so without it', async () => {
    for (const other of [
      minted({ permissions: { contents: 'write', pull_requests: 'write' } }),
      minted({ permissions: { contents: 'read' } }),
      minted({ repositories: [{ id: 999, fullName: 'sprocket/other' }] }),
      minted({ repositories: [] }),
    ]) {
      mint = other;
      expect(await reasonOf()).toBe(
        'cloud-global gave a token other than the one asked for, so the cell kept it.',
      );
    }
  });
});
