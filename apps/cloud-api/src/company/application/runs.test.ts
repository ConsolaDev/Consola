import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../adapters/persistence/database.js';
import { createDrizzleStores } from '../adapters/persistence/stores.js';
import {
  makeTestWorkspace,
  openTestDatabase,
} from '../adapters/persistence/database.test-helpers.js';
import type { Caller } from '../domain/caller.js';
import type { Factory } from '../domain/factory.js';
import { NO_RUNS, NO_STEP_DETAIL } from '../domain/run.js';
import type { RunWrite, StepRecord } from '../domain/run.js';
import type { Team } from '../domain/team.js';
import type { FactoryStore, RunStore, TeamStore } from './ports.js';
import { answerRunApproval, listRuns, readRun, recordRun } from './runs.js';
import type { RunsQuery } from './runs.js';
import { callerAs as caller, fakeMembership } from './membership.test-helpers.js';
import type { FakeMembership } from './membership.test-helpers.js';

let db: Database;
let close: () => Promise<void>;
let teams: TeamStore;
let factories: FactoryStore;
let runs: RunStore;
let membership: FakeMembership;

beforeEach(async () => {
  ({ db, close } = await openTestDatabase());
  ({ teams, factories, runs } = createDrizzleStores(db));
  membership = fakeMembership();
});

afterEach(async () => {
  await close();
});

const dana = () => caller('person-dana', 'owner');
const eli = () => caller('person-eli', 'admin');
const fay = () => caller('person-fay', 'member');
const gus = () => caller('person-gus', 'member');

type Acme = { general: Team; platform: Team; site: Factory; infra: Factory };

/**
 * Acme: Dana (owner), Eli (admin), Fay and Gus (members), all in General; Platform holds only
 * Fay. General owns the Site factory, Platform the Infra factory.
 */
async function acme(): Promise<Acme> {
  await makeTestWorkspace(db, membership, 'acme', [
    ['person-dana', 'owner'],
    ['person-eli', 'admin'],
    ['person-fay', 'member'],
    ['person-gus', 'member'],
  ]);
  const platform = await teams.create('acme', 'Platform');
  if (platform === 'name-taken') throw new Error('Platform was taken');
  await teams.addMember('acme', platform.id, 'person-fay');
  const [general] = await teams.list('acme');
  if (!general) throw new Error('Acme has no first team');
  const site = await factories.create('acme', { name: 'Site', teamId: general.id, personId: 'p' });
  const infra = await factories.create('acme', {
    name: 'Infra',
    teamId: platform.id,
    personId: 'p',
  });
  if (typeof site === 'string' || typeof infra === 'string') throw new Error('not made');
  return { general, platform, site, infra };
}

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 20, 10, minutes)).toISOString();

const step = (id: string, kind: StepRecord['kind'] = 'agent'): StepRecord => ({
  id,
  kind,
  status: 'running',
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

const automationRun = (id: string, factoryId: string, overrides: Partial<RunWrite> = {}) =>
  ({
    id,
    factoryId,
    factoryVersion: 1,
    parent: null,
    automation: 'nightly',
    status: 'running',
    waitingOn: null,
    trigger: 'cron',
    triggerDetail: '0 3 * * *',
    startedBy: null,
    item: null,
    runner: 'cloud',
    steps: [step('build')],
    request: null,
    conversation: null,
    summary: null,
    error: null,
    costUsd: null,
    createdAt: at(0),
    startedAt: null,
    finishedAt: null,
    updatedAt: at(0),
    ...overrides,
  }) satisfies RunWrite;

const request = (id: string, factoryId: string, overrides: Partial<RunWrite> = {}) =>
  automationRun(id, factoryId, {
    automation: null,
    trigger: 'manual',
    triggerDetail: null,
    steps: [step('orchestrator', 'orchestrator')],
    request: { text: `Do ${id}.`, budget: null, spent: { usd: 0, runs: 0 }, question: null },
    ...overrides,
  });

async function recorded(workspaceId: string, run: RunWrite) {
  const answer = await recordRun(runs, workspaceId, run);
  if (answer.kind !== 'recorded') throw new Error(`${run.id} was not recorded: ${answer.kind}`);
}

const query = (overrides: Partial<RunsQuery> = {}): RunsQuery => ({
  phases: [],
  triggers: [],
  factoryId: null,
  teamId: null,
  automation: null,
  mine: false,
  q: null,
  cursor: null,
  limit: 50,
  ...overrides,
});

async function listedBy(who: Caller, overrides: Partial<RunsQuery> = {}) {
  const answer = await listRuns(teams, factories, runs, who, query(overrides));
  if (answer.kind !== 'listed') throw new Error(`not listed: ${answer.kind}`);
  return answer;
}

const idsListedBy = async (who: Caller, overrides: Partial<RunsQuery> = {}) =>
  (await listedBy(who, overrides)).runs.map((run) => run.id);

/** Acme with a run of each factory, Infra's a request with one run of its own, made by Fay. */
async function acmeWithRuns(): Promise<Acme> {
  const made = await acme();
  await recorded('acme', automationRun('site-nightly', made.site.id, { createdAt: at(1) }));
  await recorded(
    'acme',
    request('infra-ask', made.infra.id, { createdAt: at(2), startedBy: 'person-fay' }),
  );
  await recorded(
    'acme',
    automationRun('infra-child', made.infra.id, {
      parent: { runId: 'infra-ask', move: 1 },
      trigger: 'manual',
      triggerDetail: null,
      automation: 'migrate',
      status: 'needs-approval',
      createdAt: at(3),
    }),
  );
  return made;
}

describe('listRuns', () => {
  it("shows owners and admins every factory's runs, and a member their teams' only", async () => {
    await acmeWithRuns();
    expect(await idsListedBy(dana())).toEqual(['infra-ask', 'site-nightly']);
    expect(await idsListedBy(eli())).toEqual(['infra-ask', 'site-nightly']);
    expect(await idsListedBy(fay())).toEqual(['infra-ask', 'site-nightly']);
    expect(await idsListedBy(gus())).toEqual(['site-nightly']);
  });

  it('counts and offers only what the caller sees', async () => {
    const { general, platform, site, infra } = await acmeWithRuns();
    const forGus = await listedBy(gus());
    expect(forGus.counts).toEqual({ ...NO_RUNS, active: 1 });
    expect(forGus.facets).toEqual({
      factories: [{ id: site.id, name: 'Site', teamId: general.id, latestVersion: 1 }],
      teams: [{ id: general.id, name: general.name }],
      automations: [{ factoryId: site.id, name: 'nightly' }],
    });
    const forDana = await listedBy(dana());
    // The request rolls its run's approval up: it needs someone.
    expect(forDana.counts).toEqual({ ...NO_RUNS, active: 1, 'needs-you': 1 });
    expect(forDana.facets.teams.map((team) => team.id)).toEqual([general.id, platform.id]);
    expect(forDana.facets.automations).toEqual([
      { factoryId: infra.id, name: 'migrate' },
      { factoryId: site.id, name: 'nightly' },
    ]);
  });

  it('narrows to a factory or team, and to nothing for one the caller does not see', async () => {
    const { platform, site, infra } = await acmeWithRuns();
    expect(await idsListedBy(dana(), { factoryId: site.id })).toEqual(['site-nightly']);
    expect(await idsListedBy(dana(), { teamId: platform.id })).toEqual(['infra-ask']);
    const hidden = await listedBy(gus(), { factoryId: infra.id });
    expect(hidden.runs).toEqual([]);
    expect(hidden.counts).toEqual(NO_RUNS);
    expect(await idsListedBy(gus(), { teamId: platform.id })).toEqual([]);
    expect(await idsListedBy(dana(), { factoryId: 'no-such-factory' })).toEqual([]);
  });

  it("lists the caller's own runs for `mine`, and filters by phase and text", async () => {
    await acmeWithRuns();
    expect(await idsListedBy(fay(), { mine: true })).toEqual(['infra-ask']);
    expect(await idsListedBy(dana(), { mine: true })).toEqual([]);
    expect(await idsListedBy(dana(), { phases: ['needs-you'] })).toEqual(['infra-ask']);
    expect(await idsListedBy(dana(), { q: '  NIGHT ' })).toEqual(['site-nightly']);
    expect(await idsListedBy(dana(), { automation: 'migrate' })).toEqual(['infra-ask']);
  });

  it('pages with a cursor it handed out, and refuses one it did not', async () => {
    await acmeWithRuns();
    const first = await listedBy(dana(), { limit: 1 });
    expect(first.runs.map((run) => run.id)).toEqual(['infra-ask']);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await listedBy(dana(), { limit: 1, cursor: first.nextCursor });
    expect(second.runs.map((run) => run.id)).toEqual(['site-nightly']);
    expect(second.nextCursor).toBeNull();
    expect(await listRuns(teams, factories, runs, dana(), query({ cursor: 'nope!' }))).toEqual({
      kind: 'invalid-cursor',
    });
  });

  it("is empty, with no facets, for a workspace that holds no factory, another's runs aside", async () => {
    await acmeWithRuns();
    await makeTestWorkspace(db, membership, 'sprocket', [['person-dana', 'owner']]);
    expect(await listedBy(caller('person-dana', 'owner', 'sprocket'))).toEqual({
      kind: 'listed',
      runs: [],
      nextCursor: null,
      counts: NO_RUNS,
      facets: {
        factories: [],
        teams: [expect.objectContaining({ id: expect.any(String) })],
        automations: [],
      },
    });
  });
});

describe('readRun', () => {
  it('reads a run the caller sees, with its request or its runs', async () => {
    await acmeWithRuns();
    const ask = await readRun(teams, factories, runs, fay(), 'infra-ask');
    expect(ask.kind === 'found' && ask.children.map((run) => run.id)).toEqual(['infra-child']);
    const child = await readRun(teams, factories, runs, dana(), 'infra-child');
    expect(child.kind === 'found' && child.parent).toEqual({
      id: 'infra-ask',
      title: 'Do infra-ask.',
    });
  });

  it("finds no run of a factory the caller does not see, nor another workspace's", async () => {
    await acmeWithRuns();
    expect(await readRun(teams, factories, runs, gus(), 'infra-ask')).toEqual({
      kind: 'not-found',
    });
    expect(await readRun(teams, factories, runs, gus(), 'infra-child')).toEqual({
      kind: 'not-found',
    });
    expect(await readRun(teams, factories, runs, gus(), 'site-nightly')).toEqual(
      expect.objectContaining({ kind: 'found' }),
    );

    await makeTestWorkspace(db, membership, 'sprocket', [['person-dana', 'owner']]);
    const [sprocketTeam] = await teams.list('sprocket');
    const sprocketFactory = await factories.create('sprocket', {
      name: 'Sprocket',
      teamId: sprocketTeam?.id ?? '',
      personId: 'p',
    });
    if (typeof sprocketFactory === 'string') throw new Error('not made');
    await recorded('sprocket', automationRun('sprocket-run', sprocketFactory.id));
    expect(await readRun(teams, factories, runs, dana(), 'sprocket-run')).toEqual({
      kind: 'not-found',
    });
    expect(
      await readRun(
        teams,
        factories,
        runs,
        caller('person-dana', 'owner', 'sprocket'),
        'sprocket-run',
      ),
    ).toEqual(expect.objectContaining({ kind: 'found' }));
  });
});

describe('recordRun', () => {
  it('records a run only once checkRun finds nothing wrong with it', async () => {
    const { site } = await acme();
    expect(
      await recordRun(runs, 'acme', automationRun('bad', site.id, { status: 'waiting' })),
    ).toEqual({
      kind: 'invalid',
      problems: [{ field: 'waitingOn', message: expect.any(String) }],
    });
    expect(await recordRun(runs, 'acme', automationRun('good', site.id))).toEqual({
      kind: 'recorded',
    });
    expect(await recordRun(runs, 'acme', automationRun('good', 'nope'))).toEqual({
      kind: 'identity-changed',
    });
  });
});

describe("readRun's steps", () => {
  const NIGHTLY = `on: { cron: "0 3 * * *" }
scope: storefront
steps:
  - id: build
    run: pnpm build
    timeout: 10m
  - id: report
    prompt: Summarise the build.
    max_turns: 4
`;

  /** Acme, with the Site factory's version 2 defining `nightly` in a file of its own. */
  async function acmeWithNightly() {
    const made = await acme();
    const saved = await factories.save('acme', made.site.id, {
      baseVersion: 1,
      files: [
        { path: 'factory.yml', content: 'version: 1\n' },
        { path: 'automations/nightly.yaml', content: NIGHTLY },
      ],
      personId: 'person-dana',
    });
    if (saved.kind !== 'saved') throw new Error(`not saved: ${saved.kind}`);
    return made;
  }

  const definitionsOf = async (runId: string) => {
    const read = await readRun(teams, factories, runs, dana(), runId);
    if (read.kind !== 'found') throw new Error(`not found: ${read.kind}`);
    return Object.fromEntries(read.steps.map((s) => [s.id, s.definition]));
  };

  it('say what each step was asked, from the factory version the run executed', async () => {
    const { site } = await acmeWithNightly();
    await recorded(
      'acme',
      automationRun('nightly-v2', site.id, {
        factoryVersion: 2,
        steps: [step('build', 'run'), step('report'), step('gone')],
      }),
    );
    expect(await definitionsOf('nightly-v2')).toEqual({
      build: {
        kind: 'run',
        prompt: null,
        action: null,
        agent: null,
        run: 'pnpm build',
        env: [],
        if: null,
        outputs: [],
        artifacts: [],
        maxTurns: null,
        timeoutMs: 600_000,
        file: 'automations/nightly.yaml',
        version: 2,
        range: { start: 4, end: 6 },
      },
      report: expect.objectContaining({
        kind: 'agent',
        prompt: 'Summarise the build.',
        maxTurns: 4,
        range: { start: 7, end: 9 },
      }),
      // A step the version does not define has no definition.
      gone: null,
    });
  });

  it('have none on a version without the automation, nor for a request', async () => {
    const { site } = await acmeWithNightly();
    await recorded('acme', automationRun('nightly-v1', site.id, { factoryVersion: 1 }));
    await recorded(
      'acme',
      automationRun('other-v2', site.id, { factoryVersion: 2, automation: 'other' }),
    );
    await recorded('acme', request('ask', site.id, { factoryVersion: 2 }));
    expect(await definitionsOf('nightly-v1')).toEqual({ build: null });
    expect(await definitionsOf('other-v2')).toEqual({ build: null });
    expect(await definitionsOf('ask')).toEqual({ orchestrator: null });
  });
});

describe('approvals', () => {
  const DEPLOY = `on: { manual: {} }
scope: storefront
mode: confirm
steps:
  - id: build
    run: pnpm build
  - id: check
    prompt: Check the build.
`;
  const NIGHTLY = `on: { cron: "0 3 * * *" }
scope: storefront
mode: auto
steps:
  - id: build
    run: pnpm build
`;

  async function save(factoryId: string, path: string, content: string) {
    const saved = await factories.save('acme', factoryId, {
      baseVersion: 1,
      files: [
        { path: 'factory.yml', content: 'version: 1\n' },
        { path, content },
      ],
      personId: 'person-dana',
    });
    if (saved.kind !== 'saved') throw new Error(`not saved: ${saved.kind}`);
  }

  /**
   * Acme with Infra's `deploy` (confirm mode, Platform's: only Fay is on it) and Site's `nightly`
   * (auto mode, General's: everyone is on it), each with a run waiting for approval at v2.
   */
  async function acmeWaiting() {
    const made = await acme();
    await save(made.infra.id, 'automations/deploy.yaml', DEPLOY);
    await save(made.site.id, 'automations/nightly.yaml', NIGHTLY);
    const waiting = {
      status: 'needs-approval' as const,
      factoryVersion: 2,
      trigger: 'manual' as const,
    };
    await recorded(
      'acme',
      automationRun('deploy-run', made.infra.id, {
        ...waiting,
        automation: 'deploy',
        startedBy: 'person-fay',
        triggerDetail: null,
        steps: [step('build', 'run'), step('check')].map((s) => ({
          ...s,
          status: 'pending' as const,
        })),
      }),
    );
    await recorded(
      'acme',
      automationRun('nightly-run', made.site.id, { ...waiting, trigger: 'cron', steps: [] }),
    );
    return made;
  }

  const answer = (who: Caller, runId: string, decision: 'approve' | 'dismiss', version = 2) =>
    answerRunApproval(teams, factories, runs, who, runId, { decision, version });

  const approvalSeenBy = async (who: Caller, runId: string) => {
    const read = await readRun(teams, factories, runs, who, runId);
    if (read.kind !== 'found') throw new Error(`not found: ${read.kind}`);
    return read.approval;
  };

  it('ask while a run waits, saying why, what will run and who may answer', async () => {
    const { platform, general } = await acmeWaiting();
    expect(await approvalSeenBy(fay(), 'deploy-run')).toEqual({
      version: 2,
      reason: 'deploy asks before every run.',
      team: { id: platform.id, name: 'Platform' },
      mayAnswer: true,
      will: {
        commands: [{ step: 'build', command: 'pnpm build' }],
        agents: [{ step: 'check', agent: null, prompt: 'Check the build.' }],
      },
      answer: null,
    });
    // An owner sees it, and is not on Platform.
    expect((await approvalSeenBy(dana(), 'deploy-run'))?.mayAnswer).toBe(false);
    expect(await approvalSeenBy(gus(), 'nightly-run')).toMatchObject({
      reason: "Version 2 of nightly hasn't been approved to run on its own yet.",
      team: { id: general.id, name: general.name },
      mayAnswer: true,
    });
  });

  it('take an answer from anyone on the team, and leave the run as it is', async () => {
    await acmeWaiting();
    const approved = await answer(fay(), 'deploy-run', 'approve');
    expect(approved).toMatchObject({
      kind: 'answered',
      approval: {
        mayAnswer: true,
        answer: { decision: 'approved', by: 'person-fay', at: expect.any(String) },
      },
    });
    const read = await readRun(teams, factories, runs, dana(), 'deploy-run');
    expect(read.kind === 'found' && read.run.status).toBe('needs-approval');
    expect(read.kind === 'found' && read.approval?.answer?.by).toBe('person-fay');
  });

  it('record a dismissal as one', async () => {
    await acmeWaiting();
    expect(await answer(gus(), 'nightly-run', 'dismiss')).toMatchObject({
      kind: 'answered',
      approval: { answer: { decision: 'dismissed', by: 'person-gus' } },
    });
  });

  it('are not found by a member of another team, and refused to one who sees the run but is not on its team', async () => {
    await acmeWaiting();
    expect(await answer(gus(), 'deploy-run', 'approve')).toEqual({ kind: 'not-found' });
    expect(await answer(dana(), 'deploy-run', 'approve')).toEqual({ kind: 'not-allowed' });
    expect(await answer(eli(), 'deploy-run', 'approve')).toEqual({ kind: 'not-allowed' });
    expect(await answer(fay(), 'no-such-run', 'approve')).toEqual({ kind: 'not-found' });
  });

  it('keep the first answer, and refuse a run that does not wait or a version that moved', async () => {
    const { site } = await acmeWaiting();
    expect((await answer(fay(), 'nightly-run', 'approve')).kind).toBe('answered');
    expect(await answer(gus(), 'nightly-run', 'dismiss')).toEqual({ kind: 'already-answered' });
    expect(await answer(fay(), 'deploy-run', 'approve', 1)).toEqual({ kind: 'version-moved' });
    await recorded(
      'acme',
      automationRun('nightly-done', site.id, { status: 'completed', factoryVersion: 2 }),
    );
    expect(await answer(gus(), 'nightly-done', 'approve')).toEqual({ kind: 'not-waiting' });
    // A run that never asked shows no approval.
    expect(await approvalSeenBy(gus(), 'nightly-done')).toBeNull();
  });

  it('show the file behind an automation run, and none for a request', async () => {
    const { infra } = await acmeWaiting();
    const read = await readRun(teams, factories, runs, fay(), 'deploy-run');
    expect(read.kind === 'found' && read.source).toEqual({
      path: 'automations/deploy.yaml',
      version: 2,
      latestVersion: 2,
      text: DEPLOY,
      range: { start: 1, end: 8 },
      trigger: { kind: 'manual', detail: null },
      mode: 'confirm',
      appliesTo: [],
    });
    await recorded(
      'acme',
      request('ask', infra.id, { status: 'needs-approval', factoryVersion: 2 }),
    );
    const ask = await readRun(teams, factories, runs, fay(), 'ask');
    expect(ask.kind === 'found' && ask.source).toBeNull();
    expect(ask.kind === 'found' && ask.approval).toMatchObject({
      reason: "This factory's orchestrator hasn't been approved at this version yet.",
      will: { commands: [], agents: [] },
    });
  });
});
