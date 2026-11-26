import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../adapters/persistence/database.js';
import { createDrizzleStores } from '../adapters/persistence/stores.js';
import { runs as runTable } from '../adapters/persistence/tables.js';
import { makeTestWorkspace, openTestDatabase } from '../adapters/persistence/testDatabase.js';
import type { Caller } from '../domain/caller.js';
import { checkFactoryFiles } from '../domain/factory.js';
import { OUTPUT_TAIL_MAX, PHASES, RUN_STATUSES } from '../domain/run.js';
import type { StepRecord } from '../domain/run.js';
import type { CloudSessionStore, FactoryStore, RunStore, TeamStore } from './ports.js';
import { listRuns, readRun } from './runs.js';
import type { RunsQuery } from './runs.js';
import { DEMO_FACTORY_FILES, seedDemoRuns, seedEveryWorkspace } from './seedDemoRuns.js';
import { callerAs as caller, fakeMembership } from './testMembership.js';
import type { FakeMembership } from './testMembership.js';

let db: Database;
let close: () => Promise<void>;
let teams: TeamStore;
let factories: FactoryStore;
let runs: RunStore;
let sessions: CloudSessionStore;
let membership: FakeMembership;
/** What `seedDemoRuns` is handed. */
let ports: {
  teams: TeamStore;
  factories: FactoryStore;
  runs: RunStore;
  membership: FakeMembership;
};

beforeEach(async () => {
  ({ db, close } = await openTestDatabase());
  ({ teams, factories, runs, cloudSessions: sessions } = createDrizzleStores(db));
  membership = fakeMembership();
  ports = { teams, factories, runs, membership };
});

afterEach(async () => {
  await close();
});

const MEMBERS = [
  ['person-dana', 'owner'],
  ['person-eli', 'admin'],
  ['person-fay', 'member'],
  ['person-gus', 'member'],
] as const;

/** Acme with four members in General, and a Platform team only Fay is in. */
async function acme() {
  await makeTestWorkspace(db, membership, 'acme', MEMBERS);
  const platform = await teams.create('acme', 'Platform');
  if (platform === 'name-taken') throw new Error('Platform was taken');
  await teams.addMember('acme', platform.id, 'person-fay');
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
  limit: 100,
  ...overrides,
});

async function listed(who: Caller, overrides: Partial<RunsQuery> = {}) {
  const answer = await listRuns(teams, factories, runs, who, query(overrides));
  if (answer.kind !== 'listed') throw new Error(`not listed: ${answer.kind}`);
  return answer;
}

const NOW = Date.UTC(2026, 10, 23, 12, 0);

describe('seedDemoRuns', () => {
  it('saves demo files that keep the factory schema', () => {
    expect(checkFactoryFiles(DEMO_FACTORY_FILES)).toEqual({ ok: true, notices: [] });
  });

  it('seeds nothing for a workspace with no team', async () => {
    expect(await seedDemoRuns(ports, 'acme', NOW)).toEqual({ factories: [], runs: 0 });
  });

  it('gives every team a demo factory, and runs in every phase and status', async () => {
    await acme();
    const seeded = await seedDemoRuns(ports, 'acme', NOW);
    expect(seeded).toEqual({
      factories: ['Demo · General', 'Demo · Platform'],
      runs: expect.any(Number),
    });
    for (const factory of await factories.list('acme')) expect(factory.latestVersion).toBe(2);

    const dana = caller('person-dana', 'owner');
    const all = await listed(dana);
    for (const phase of PHASES) expect([phase, all.counts[phase]]).not.toEqual([phase, 0]);
    const rows = await db.select({ status: runTable.status }).from(runTable);
    expect(new Set(rows.map((row) => row.status))).toEqual(new Set(RUN_STATUSES));
    // More top-level runs than a page of 50 holds.
    expect((await listed(dana, { limit: 50 })).nextCursor).not.toBeNull();
    // Background runs, each kind of trigger.
    for (const trigger of ['cron', 'event', 'poll', 'manual'] as const) {
      expect((await listed(dana, { triggers: [trigger] })).runs.length).toBeGreaterThan(0);
    }
  });

  it('nests several runs under a request, and rolls a run that needs someone up to it', async () => {
    await acme();
    await seedDemoRuns(ports, 'acme', NOW);
    const dana = caller('person-dana', 'owner');
    const requests = (await listed(dana, { q: 'euro price toggle' })).runs;
    expect(requests).toHaveLength(1);
    const [euro] = requests;
    expect(euro?.children).toEqual({ total: 3, active: 2, needsYou: 0, failed: 0 });
    const read = await readRun(teams, factories, runs, dana, euro?.id ?? '');
    expect(read.kind === 'found' && read.children.map((run) => run.status)).toEqual([
      'completed',
      'running',
      'queued',
    ]);
    const gate = (await listed(dana, { q: 'spring sale banner' })).runs[0];
    expect([gate?.status, gate?.phase]).toEqual(['waiting', 'needs-you']);
  });

  it('gives every member runs of their own, and a member outside a team fewer', async () => {
    await acme();
    await seedDemoRuns(ports, 'acme', NOW);
    for (const [personId, role] of MEMBERS) {
      const mine = await listed(caller(personId, role), { mine: true });
      expect([personId, mine.runs.length > 0]).toEqual([personId, true]);
    }
    const fay = await listed(caller('person-fay', 'member'));
    const gus = await listed(caller('person-gus', 'member'));
    expect(gus.facets.factories.map((factory) => factory.name)).toEqual(['Demo · General']);
    expect(Object.values(gus.counts).reduce((a, b) => a + b)).toBeLessThan(
      Object.values(fay.counts).reduce((a, b) => a + b),
    );
  });

  it('starts no run for someone a team still lists who has left the workspace', async () => {
    await acme();
    membership.remove('acme', 'person-gus');
    await seedDemoRuns(ports, 'acme', NOW);
    const rows = await db.select({ startedBy: runTable.startedBy }).from(runTable);
    const starters = new Set(rows.map((row) => row.startedBy));
    expect(starters.has('person-fay')).toBe(true);
    expect(starters.has('person-gus')).toBe(false);
  });

  it('refreshes the same runs when it seeds again', async () => {
    await acme();
    const first = await seedDemoRuns(ports, 'acme', NOW);
    const count = async () => (await db.select({ id: runTable.runId }).from(runTable)).length;
    const before = await count();
    const second = await seedDemoRuns(ports, 'acme', NOW + 60 * 60_000);
    expect(second).toEqual(first);
    expect(await count()).toBe(before);
    expect((await factories.list('acme')).map((factory) => factory.latestVersion)).toEqual([2, 2]);
  });
});

describe("seedDemoRuns' steps", () => {
  /** Every step the seed recorded, with its run's id. */
  async function seededSteps() {
    await acme();
    await seedDemoRuns(ports, 'acme', NOW);
    const rows = await db.select({ id: runTable.runId, steps: runTable.steps }).from(runTable);
    return rows.flatMap((row) => row.steps.map((step: StepRecord) => ({ run: row.id, ...step })));
  }

  it('print, exit and count bytes as commands do, a running one cut mid-line', async () => {
    const steps = await seededSteps();
    const commands = steps.filter((step) => step.command !== null);
    expect(
      commands.some((step) => step.command?.exitCode === 0 && step.status === 'completed'),
    ).toBe(true);
    expect(commands.some((step) => step.command?.exitCode === 1 && step.status === 'failed')).toBe(
      true,
    );
    for (const step of commands) {
      expect(step.output).not.toBeNull();
      const bytes = new TextEncoder().encode(step.output?.stdout ?? '').length;
      expect(bytes).toBeLessThanOrEqual(OUTPUT_TAIL_MAX);
      expect(step.command?.stdoutBytes ?? 0).toBeGreaterThanOrEqual(bytes);
    }
    expect(commands.some((step) => step.output?.truncated)).toBe(true);
    const live = commands.find((step) => step.status === 'running');
    expect(live?.command?.exitCode).toBeNull();
    expect(live?.output?.stdout.endsWith('\n')).toBe(false);
  });

  it('take turns against a cap, produce outputs and documents, and are refused or reminded', async () => {
    const steps = await seededSteps();
    const agents = steps.filter((step) => step.turn !== null);
    expect(agents.every((step) => (step.turn?.turns ?? 0) <= (step.turn?.maxTurns ?? 0))).toBe(
      true,
    );
    expect(
      agents.some((step) => step.outputs?.verdict === 'approve' && step.outputs.findings === 3),
    ).toBe(true);
    expect(
      agents.some((step) => step.artifacts.some((a) => a.name === 'review' && a.bytes > 1500)),
    ).toBe(true);
    expect(agents.some((step) => (step.turn?.deniedTools.length ?? 0) > 0)).toBe(true);
    expect(steps.some((step) => step.reminded)).toBe(true);
    const retried = steps.find((step) => step.attempt === 2);
    expect(retried?.previous).toEqual([expect.objectContaining({ attempt: 1, status: 'failed' })]);
    expect(steps.some((step) => step.status === 'skipped' && step.skipped !== null)).toBe(true);
  });

  it('are defined by the files the demo factory holds, but on the version before them', async () => {
    await acme();
    await seedDemoRuns(ports, 'acme', NOW);
    const dana = caller('person-dana', 'owner');
    const builds = (await listed(dana, { q: 'nightly-build', limit: 100 })).runs;
    const newest = builds.find((run) => run.factory.version === 2);
    const oldest = builds.find((run) => run.factory.version === 1);
    const read = async (id: string) => {
      const answer = await readRun(teams, factories, runs, dana, id);
      if (answer.kind !== 'found') throw new Error(`not found: ${answer.kind}`);
      return answer.steps.map((step) => step.definition?.file ?? null);
    };
    expect(await read(newest?.id ?? '')).toEqual([
      'automations/nightly-build.yaml',
      'automations/nightly-build.yaml',
    ]);
    expect(await read(oldest?.id ?? '')).toEqual([null, null]);
  });

  it('give a factory seeded with other files the demo files as its next version', async () => {
    await acme();
    const [general] = await teams.list('acme');
    const made = await factories.create('acme', {
      name: `Demo · ${general?.name}`,
      teamId: general?.id ?? '',
      personId: 'person-dana',
    });
    if (typeof made === 'string') throw new Error('not made');
    await factories.save('acme', made.id, {
      baseVersion: 1,
      files: [{ path: 'factory.yml', content: 'version: 1\n' }],
      personId: 'person-dana',
    });
    await seedDemoRuns(ports, 'acme', NOW);
    expect((await factories.get('acme', made.id))?.latestVersion).toBe(3);
  });
});

describe("seedDemoRuns' approvals", () => {
  it('leaves every run waiting for approval unanswered, asking for both reasons', async () => {
    await acme();
    await seedDemoRuns(ports, 'acme', NOW);
    const dana = caller('person-dana', 'owner');
    const waiting = (await listed(dana, { phases: ['needs-you'], limit: 100 })).runs.filter(
      (run) => run.status === 'needs-approval',
    );
    const reasons = new Set<string>();
    for (const run of waiting) {
      const read = await readRun(teams, factories, runs, dana, run.id);
      if (read.kind !== 'found') throw new Error(`not found: ${read.kind}`);
      expect([run.id, read.approval?.answer]).toEqual([run.id, null]);
      if (read.approval) reasons.add(read.approval.reason);
    }
    expect([...reasons]).toEqual(
      expect.arrayContaining([
        'review-prs asks before every run.',
        "Version 2 of nightly-build hasn't been approved to run on its own yet.",
      ]),
    );
  });
});

describe('seedEveryWorkspace', () => {
  it('seeds every workspace accounts lists, each with its demo runs, the template and its agent run', async () => {
    await acme();
    await makeTestWorkspace(db, membership, 'sprocket', [['person-ida', 'owner']]);
    const all = { ...ports, sessions };

    const seeded = await seedEveryWorkspace(all, NOW);
    expect(seeded).toEqual([
      {
        workspaceId: 'acme',
        runs: { factories: ['Demo · General', 'Demo · Platform'], runs: expect.any(Number) },
        template: { kind: 'created', factoryId: expect.any(String), version: 2 },
        agentRun: 'created',
      },
      {
        workspaceId: 'sprocket',
        runs: { factories: ['Demo · General'], runs: expect.any(Number) },
        template: { kind: 'created', factoryId: expect.any(String), version: 2 },
        agentRun: 'created',
      },
    ]);
    expect((await runs.get('sprocket', 'demo-agent-run-sprocket'))?.run.kind).toBe('request');

    const again = await seedEveryWorkspace(all, NOW + 60_000);
    expect(again.map(({ template, agentRun }) => [template.kind, agentRun])).toEqual([
      ['unchanged', 'unchanged'],
      ['unchanged', 'unchanged'],
    ]);
  });
});
