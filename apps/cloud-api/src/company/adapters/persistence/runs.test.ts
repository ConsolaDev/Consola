import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FactoryStore, RunFilter, RunStore, TeamStore } from '../../application/ports.js';
import type { Factory } from '../../domain/factory.js';
import { checkRun, NO_STEP_DETAIL } from '../../domain/run.js';
import type { RunWrite, StepRecord } from '../../domain/run.js';
import type { Database } from './database.js';
import { createFactoryStore } from './factories.js';
import { createRunStore } from './runs.js';
import { runs as runTable } from './tables.js';
import { createTeamStore, openWorkspace } from './teams.js';
import { openTestDatabase } from './testDatabase.js';

let db: Database;
let close: () => Promise<void>;
let runs: RunStore;
let factories: FactoryStore;
let teams: TeamStore;

beforeEach(async () => {
  ({ db, close } = await openTestDatabase());
  runs = createRunStore(db);
  factories = createFactoryStore(db);
  teams = createTeamStore(db);
});

afterEach(async () => {
  await close();
});

/** Opens `workspaceId` as making it does, with a factory in its first team. */
async function workspaceWithFactory(workspaceId: string, name = 'Deploys'): Promise<Factory> {
  await db.transaction((tx) => openWorkspace(tx, { workspaceId, ownerId: 'person-dana' }));
  const [first] = await teams.list(workspaceId);
  if (!first) throw new Error(`${workspaceId} has no first team`);
  return madeFactory(workspaceId, name, first.id);
}

async function madeFactory(workspaceId: string, name: string, teamId: string) {
  const factory = await factories.create(workspaceId, { name, teamId, personId: 'person-dana' });
  if (typeof factory === 'string') throw new Error(`${name} was not made: ${factory}`);
  return factory;
}

/** A time `minutes` after a fixed start, as a runner writes one. */
const at = (minutes: number) => new Date(Date.UTC(2026, 10, 20, 10, minutes)).toISOString();

const step = (id: string, status: StepRecord['status'], kind: StepRecord['kind'] = 'agent') =>
  ({
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
  }) satisfies StepRecord;

let factoryId = '';

const automationRun = (id: string, overrides: Partial<RunWrite> = {}): RunWrite => ({
  id,
  factoryId,
  factoryVersion: 1,
  parent: null,
  automation: 'review-prs',
  status: 'running',
  waitingOn: null,
  trigger: 'cron',
  triggerDetail: '0 3 * * *',
  startedBy: null,
  item: null,
  runner: 'cloud',
  steps: [step('plan', 'completed'), step('review', 'running'), step('report', 'pending')],
  request: null,
  conversation: null,
  summary: null,
  error: null,
  costUsd: null,
  createdAt: at(0),
  startedAt: at(0),
  finishedAt: null,
  updatedAt: at(0),
  ...overrides,
});

const request = (id: string, overrides: Partial<RunWrite> = {}): RunWrite =>
  automationRun(id, {
    automation: null,
    trigger: 'manual',
    triggerDetail: null,
    startedBy: 'person-dana',
    steps: [step('orchestrator', 'waiting', 'orchestrator')],
    status: 'waiting',
    waitingOn: 'run',
    request: {
      text: `Do ${id}.`,
      budget: { usd: 20, runs: 8 },
      spent: { usd: 0.5, runs: 1 },
      question: null,
    },
    costUsd: 0.5,
    ...overrides,
  });

const childOf = (requestId: string, move: number, id: string, overrides: Partial<RunWrite> = {}) =>
  automationRun(id, {
    parent: { runId: requestId, move },
    trigger: 'manual',
    triggerDetail: null,
    ...overrides,
  });

/** Records `run` in `workspaceId` once it is checked, answering what the store said. */
async function record(run: RunWrite, workspaceId = 'acme') {
  const checked = checkRun(run);
  if (!checked.ok) throw new Error(`not a run: ${JSON.stringify(checked.problems)}`);
  return runs.record(workspaceId, checked.run);
}

const everything = (overrides: Partial<RunFilter> = {}): RunFilter => ({
  factoryIds: [factoryId],
  triggers: [],
  automation: null,
  startedBy: null,
  q: null,
  ...overrides,
});

const firstPage: Parameters<RunStore['list']>[2] = { phases: [], after: null, limit: 50 };

async function listedIds(filter: Partial<RunFilter> = {}, page = firstPage) {
  return (await runs.list('acme', everything(filter), page)).runs.map((run) => run.id);
}

describe('the run store', () => {
  beforeEach(async () => {
    factoryId = (await workspaceWithFactory('acme')).id;
  });

  it('records a run and reads it back, with its factory and its steps', async () => {
    expect(await record(automationRun('nightly', { costUsd: 0.25 }))).toBe('recorded');
    const found = await runs.get('acme', 'nightly');
    expect(found).toEqual({
      run: {
        id: 'nightly',
        kind: 'automation',
        title: 'review-prs',
        status: 'running',
        phase: 'active',
        waitingOn: null,
        factory: { id: factoryId, name: 'Deploys', version: 1 },
        teamId: expect.any(String),
        automation: 'review-prs',
        parentId: null,
        trigger: 'cron',
        triggerDetail: '0 3 * * *',
        startedBy: null,
        item: null,
        runner: 'cloud',
        progress: { total: 3, done: 1, current: 'review' },
        children: null,
        summary: null,
        error: null,
        costUsd: 0.25,
        createdAt: at(0),
        startedAt: at(0),
        finishedAt: null,
        updatedAt: at(0),
      },
      parent: null,
      steps: automationRun('nightly').steps,
      request: null,
      children: [],
      conversation: null,
    });
  });

  it("reads a request with its facts and its runs, in the order it started them, and a run's request", async () => {
    await record(request('ship', { createdAt: at(0) }));
    await record(childOf('ship', 2, 'second', { createdAt: at(1), status: 'completed' }));
    await record(childOf('ship', 1, 'first', { createdAt: at(2) }));
    const found = await runs.get('acme', 'ship');
    expect(found?.run.children).toEqual({ total: 2, active: 1, needsYou: 0, failed: 0 });
    expect(found?.run.progress).toBeNull();
    expect(found?.request).toEqual({
      text: 'Do ship.',
      budget: { usd: 20, runs: 8 },
      spent: { usd: 0.5, runs: 1 },
      question: null,
    });
    expect(found?.children.map((child) => [child.id, child.parentId])).toEqual([
      ['first', 'ship'],
      ['second', 'ship'],
    ]);
    expect((await runs.get('acme', 'first'))?.parent).toEqual({ id: 'ship', title: 'Do ship.' });
  });

  it('lists top-level runs only, newest first, a page at a time', async () => {
    for (let minute = 0; minute < 5; minute++) {
      await record(
        automationRun(`run-${minute}`, { createdAt: at(minute), updatedAt: at(minute) }),
      );
    }
    // Two at the same moment are ordered by id, and no page skips or repeats one.
    await record(automationRun('run-4b', { createdAt: at(4), updatedAt: at(4) }));
    await record(request('ship', { createdAt: at(9) }));
    await record(childOf('ship', 1, 'child', { createdAt: at(10) }));

    const first = await runs.list('acme', everything(), { phases: [], after: null, limit: 3 });
    expect(first.runs.map((run) => run.id)).toEqual(['ship', 'run-4b', 'run-4']);
    expect(first.next).toEqual({ createdAt: at(4), id: 'run-4' });
    const second = await runs.list('acme', everything(), {
      phases: [],
      after: first.next,
      limit: 3,
    });
    expect(second.runs.map((run) => run.id)).toEqual(['run-3', 'run-2', 'run-1']);
    const third = await runs.list('acme', everything(), {
      phases: [],
      after: second.next,
      limit: 3,
    });
    expect(third).toEqual({ runs: [expect.objectContaining({ id: 'run-0' })], next: null });
  });

  it('filters by phase, trigger, starter, automation and text, and counts each phase', async () => {
    await record(automationRun('cron-ok', { status: 'completed', automation: 'nightly-build' }));
    await record(automationRun('poll-failed', { status: 'failed', trigger: 'poll' }));
    await record(automationRun('mine', { trigger: 'manual', startedBy: 'person-fay' }));
    await record(request('ship', { startedBy: 'person-fay' }));
    await record(childOf('ship', 1, 'ship-deploy', { automation: 'deploy' }));
    await record(
      automationRun('event', {
        trigger: 'event',
        status: 'needs-approval',
        item: {
          url: 'https://github.com/acme/api/pull/7',
          title: '100% faster_builds',
          kind: 'pr',
          repo: 'acme/api',
          number: 7,
        },
      }),
    );

    // Made at one moment, so listed by id, the last first.
    expect(await listedIds({}, { ...firstPage, phases: ['failed', 'needs-you'] })).toEqual([
      'poll-failed',
      'event',
    ]);
    expect(await listedIds({ triggers: ['cron', 'poll'] })).toEqual(['poll-failed', 'cron-ok']);
    expect(await listedIds({ startedBy: 'person-fay' })).toEqual(['ship', 'mine']);
    // A request that started one counts as the automation's, and its run is not listed itself.
    expect(await listedIds({ automation: 'deploy' })).toEqual(['ship']);
    expect(await listedIds({ q: 'NIGHTLY' })).toEqual(['cron-ok']);
    expect(await listedIds({ q: '100%' })).toEqual(['event']);
    // `_` and `%` are themselves: unescaped, each would match '100% faster_builds'.
    expect(await listedIds({ q: '1_0' })).toEqual([]);
    expect(await listedIds({ q: '1%s' })).toEqual([]);
    expect(await listedIds({ q: 'do ship' })).toEqual(['ship']);

    expect(await runs.count('acme', everything())).toEqual({
      active: 2,
      'needs-you': 1,
      completed: 1,
      failed: 1,
      stopped: 0,
    });
    expect(await runs.count('acme', everything({ triggers: ['manual'] }))).toEqual({
      active: 2,
      'needs-you': 0,
      completed: 0,
      failed: 0,
      stopped: 0,
    });
  });

  it("reads only the factories it is given, and never another workspace's runs", async () => {
    const other = await madeFactory('acme', 'Docs', (await teams.list('acme'))[0]?.id ?? '');
    await record(automationRun('deploys-run'));
    await record({ ...automationRun('docs-run'), factoryId: other.id });
    expect(await listedIds({ factoryIds: [other.id] })).toEqual(['docs-run']);
    expect(await listedIds({ factoryIds: [] })).toEqual([]);

    const globex = await workspaceWithFactory('globex');
    await record({ ...automationRun('globex-run'), factoryId: globex.id }, 'globex');
    expect(await runs.get('acme', 'globex-run')).toBeNull();
    expect(await listedIds({ factoryIds: [globex.id] })).toEqual([]);
    // One name in two factories is offered for each, by the factories' ids.
    expect(await runs.automations('acme', [factoryId, other.id, globex.id])).toEqual(
      [factoryId, other.id].sort().map((id) => ({ factoryId: id, name: 'review-prs' })),
    );
  });

  it("names the automations a factory's runs ran, children's included, once each", async () => {
    await record(automationRun('a', { automation: 'nightly' }));
    await record(automationRun('b', { automation: 'nightly' }));
    await record(request('ship'));
    await record(childOf('ship', 1, 'c', { automation: 'deploy' }));
    expect(await runs.automations('acme', [factoryId])).toEqual([
      { factoryId, name: 'deploy' },
      { factoryId, name: 'nightly' },
    ]);
  });

  it('rolls a request at work up to needing someone while one of its runs does, and back', async () => {
    await record(request('ship'));
    const phase = async () => (await runs.get('acme', 'ship'))?.run.phase;
    expect(await phase()).toBe('active');

    await record(childOf('ship', 1, 'gate', { status: 'needs-approval', updatedAt: at(1) }));
    expect(await phase()).toBe('needs-you');
    // Recording the request again keeps the roll-up its runs say.
    await record(request('ship', { updatedAt: at(2) }));
    expect(await phase()).toBe('needs-you');

    await record(childOf('ship', 1, 'gate', { status: 'running', updatedAt: at(3) }));
    expect(await phase()).toBe('active');

    await record(childOf('ship', 1, 'gate', { status: 'needs-approval', updatedAt: at(4) }));
    await record(request('ship', { status: 'cancelled', waitingOn: null, updatedAt: at(5) }));
    expect(await phase()).toBe('stopped');
  });

  it('keeps a newer record of a run: an older one changes nothing', async () => {
    await record(automationRun('nightly', { status: 'completed', updatedAt: at(5) }));
    expect(await record(automationRun('nightly', { status: 'running', updatedAt: at(4) }))).toBe(
      'stale',
    );
    expect((await runs.get('acme', 'nightly'))?.run.status).toBe('completed');
    // The same moment again is the same record: it is taken.
    expect(await record(automationRun('nightly', { status: 'failed', updatedAt: at(5) }))).toBe(
      'recorded',
    );
    expect((await runs.get('acme', 'nightly'))?.run.status).toBe('failed');
  });

  it("never changes a run's factory, kind or parent", async () => {
    const other = await madeFactory('acme', 'Docs', (await teams.list('acme'))[0]?.id ?? '');
    await record(request('ship'));
    await record(childOf('ship', 1, 'child'));
    expect(await record({ ...automationRun('child', { updatedAt: at(1) }) })).toBe(
      'identity-changed',
    );
    expect(await record({ ...childOf('ship', 1, 'child'), factoryId: other.id })).toBe(
      'parent-not-found',
    );
    expect(await record(automationRun('ship', { updatedAt: at(1) }))).toBe('identity-changed');
  });

  it('refuses a parent that is not a request of the same factory, and a version not saved', async () => {
    const other = await madeFactory('acme', 'Docs', (await teams.list('acme'))[0]?.id ?? '');
    await record(request('ship'));
    await record(automationRun('nightly'));
    expect(await record(childOf('missing', 1, 'a'))).toBe('parent-not-found');
    expect(await record(childOf('nightly', 1, 'b'))).toBe('parent-not-found');
    expect(await record({ ...childOf('ship', 1, 'c'), factoryId: other.id })).toBe(
      'parent-not-found',
    );
    expect(await record(automationRun('d', { factoryVersion: 9 }))).toBe('factory-not-found');
    expect(await record({ ...automationRun('e'), factoryId: 'nope' })).toBe('factory-not-found');
    expect(await runs.get('acme', 'd')).toBeNull();
  });

  it('keeps what each step did, printed and produced, as recorded', async () => {
    const build: StepRecord = {
      ...step('build', 'failed', 'run'),
      attempt: 2,
      error: 'pnpm build exited with code 1.',
      artifacts: [{ name: 'output', bytes: 18_034 }],
      command: {
        exitCode: 1,
        signal: null,
        stdoutBytes: 17_002,
        stderrBytes: 1032,
        truncated: false,
      },
      previous: [
        {
          attempt: 1,
          status: 'failed',
          error: 'Timed out.',
          finishedAt: at(1),
          costUsd: null,
          turns: null,
        },
      ],
      output: { stdout: '✓ built in 41.27s\n', stderr: 'error TS2322\n', truncated: true },
    };
    const review: StepRecord = {
      ...step('review', 'completed'),
      outputs: { verdict: 'approve', findings: 3, blocking: false },
      artifacts: [{ name: 'review', bytes: 2140 }],
      turn: { turns: 7, maxTurns: 12, deniedTools: ['WebFetch'] },
      reminded: true,
    };
    await record(automationRun('detailed', { status: 'failed', steps: [review, build] }));
    expect((await runs.get('acme', 'detailed'))?.steps).toEqual([review, build]);
  });

  it('reads a step stored before its details existed as having none', async () => {
    await record(automationRun('older'));
    const { outputs, artifacts, turn, command, previous, reminded, output, ...bare } = step(
      'plan',
      'completed',
    );
    await db
      .update(runTable)
      .set({ steps: [bare as StepRecord] })
      .where(eq(runTable.runId, 'older'));
    expect((await runs.get('acme', 'older'))?.steps).toEqual([step('plan', 'completed')]);
  });

  it("keeps the first answer to a run's approval at a version, and changes nothing else", async () => {
    await record(automationRun('deploy', { status: 'needs-approval', startedAt: null }));
    expect(await runs.answerOf('acme', 'deploy', 1)).toBeNull();

    const first = await runs.answer('acme', 'deploy', {
      version: 1,
      decision: 'approved',
      personId: 'person-fay',
    });
    expect(first).toEqual({ decision: 'approved', by: 'person-fay', at: expect.any(String) });
    expect(
      await runs.answer('acme', 'deploy', {
        version: 1,
        decision: 'dismissed',
        personId: 'person-dana',
      }),
    ).toBe('already-answered');
    expect(await runs.answerOf('acme', 'deploy', 1)).toEqual(first);
    // Another version is another question.
    expect(await runs.answerOf('acme', 'deploy', 2)).toBeNull();
    // The run is the runner's: an answer changes none of it.
    expect((await runs.get('acme', 'deploy'))?.run.status).toBe('needs-approval');
  });

  it("answers no run the workspace does not hold, another workspace's included", async () => {
    const answer = { version: 1, decision: 'approved' as const, personId: 'person-fay' };
    expect(await runs.answer('acme', 'nothing', answer)).toBe('not-found');
    const globex = await workspaceWithFactory('globex');
    await record({ ...automationRun('theirs'), factoryId: globex.id }, 'globex');
    expect(await runs.answer('acme', 'theirs', answer)).toBe('not-found');
    expect(await runs.answerOf('acme', 'theirs', 1)).toBeNull();
  });

  it("refuses a row that breaks the domain's rules, should one get past checkRun", async () => {
    const checked = checkRun(automationRun('raw'));
    if (!checked.ok) throw new Error('not a run');
    await expect(
      db.insert(runTable).values({
        workspaceId: 'acme',
        runId: 'raw',
        factoryId,
        factoryVersion: 1,
        kind: 'automation',
        automation: 'review-prs',
        title: 'raw',
        status: 'waiting',
        phase: 'active',
        trigger: 'cron',
        runner: 'cloud',
        steps: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).rejects.toThrow();
  });
});
