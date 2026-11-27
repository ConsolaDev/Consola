import { CODE_REVIEW_TEAM_FILES } from '@consola/factory-spec';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../adapters/persistence/database.js';
import { createDrizzleStores } from '../adapters/persistence/stores.js';
import {
  makeTestWorkspace,
  openTestDatabase,
} from '../adapters/persistence/database.test-helpers.js';
import type { FactoryStore, TeamStore } from './ports.js';
import { seedCodeReviewTeam, seedDemoAgentRun } from './seedTemplates.js';
import { fakeMembership } from './membership.test-helpers.js';
import type { FakeMembership } from './membership.test-helpers.js';

let db: Database;
let close: () => Promise<void>;
let teams: TeamStore;
let factories: FactoryStore;
let membership: FakeMembership;

beforeEach(async () => {
  ({ db, close } = await openTestDatabase());
  ({ teams, factories } = createDrizzleStores(db));
  membership = fakeMembership();
});
afterEach(async () => {
  await close();
});

/** Acme, with Dana its owner and Fay a member. */
async function acme() {
  await makeTestWorkspace(db, membership, 'acme', [
    ['person-dana', 'owner'],
    ['person-fay', 'member'],
  ]);
}

const sorted = (files: ReadonlyArray<{ path: string; content: string }>) =>
  [...files].sort((a, b) => (a.path < b.path ? -1 : 1));

describe('seedCodeReviewTeam', () => {
  it('installs the code review team on the first team, and saves again only when its files differ', async () => {
    await acme();
    const ports = { teams, factories, membership };

    const made = await seedCodeReviewTeam(ports, 'acme');
    expect(made).toMatchObject({ kind: 'created', version: 2 });
    const [first] = await teams.list('acme');
    const [factory] = await factories.list('acme');
    expect(factory).toMatchObject({
      name: 'Code review team',
      teamId: first?.id,
      latestVersion: 2,
    });
    const version = await factories.version('acme', factory?.id ?? '', 2);
    expect(sorted(version?.files ?? [])).toEqual(sorted(CODE_REVIEW_TEAM_FILES));
    // Saved by the workspace's first member, its owner.
    expect(version?.savedBy).toBe('person-dana');

    expect(await seedCodeReviewTeam(ports, 'acme')).toMatchObject({
      kind: 'unchanged',
      version: 2,
    });

    // Someone changed the files: the next seed brings the template back as a new version.
    await factories.save('acme', factory?.id ?? '', {
      baseVersion: 2,
      files: CODE_REVIEW_TEAM_FILES.slice(1),
      personId: 'person-dana',
    });
    expect(await seedCodeReviewTeam(ports, 'acme')).toMatchObject({ kind: 'updated', version: 4 });
    expect(await factories.list('acme')).toHaveLength(1);
  });

  it('leaves alone a factory of its name that another team owns', async () => {
    await acme();
    const platform = await teams.create('acme', 'Platform');
    if (platform === 'name-taken') throw new Error('Platform was taken');
    const theirs = await factories.create('acme', {
      name: 'Code review team',
      teamId: platform.id,
      personId: 'person-fay',
    });
    if (typeof theirs === 'string') throw new Error(theirs);
    expect(await seedCodeReviewTeam({ teams, factories, membership }, 'acme')).toEqual({
      kind: 'taken',
      factoryId: theirs.id,
    });
    expect((await factories.get('acme', theirs.id))?.latestVersion).toBe(1);
  });

  it('refuses a workspace with no first team, which no workspace made whole is', async () => {
    await expect(seedCodeReviewTeam({ teams, factories, membership }, 'globex')).rejects.toThrow(
      /no first team/,
    );
  });
});

describe('seedDemoAgentRun', () => {
  it('records a finished agent run in Runs, its session its conversation, once', async () => {
    await acme();
    const stores = createDrizzleStores(db);
    const team = await seedCodeReviewTeam({ teams, factories, membership }, 'acme');
    if (team.kind === 'taken') throw new Error('no team');
    const factory = { id: team.factoryId, name: 'Code review team', version: team.version };
    const seed = () =>
      seedDemoAgentRun(
        { sessions: stores.cloudSessions, runs: stores.runs },
        'acme',
        factory,
        Date.UTC(2026, 10, 26, 12),
      );

    expect(await seed()).toBe('created');
    const found = await stores.runs.get('acme', 'demo-agent-run-acme');
    expect(found).toMatchObject({
      run: {
        kind: 'request',
        status: 'completed',
        trigger: 'event',
        summary: 'Posted a comment review on sprocket/catalog-portal#7 with two findings.',
      },
      conversation: 'demo-agent-run-acme',
    });
    expect(await stores.cloudSessions.find('demo-agent-run-acme')).toMatchObject({
      status: 'stopped',
      agentRun: { state: 'done' },
    });
    expect(await seed()).toBe('unchanged');
  });
});
