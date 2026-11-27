import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../adapters/persistence/database.js';
import { createDrizzleStores } from '../adapters/persistence/stores.js';
import {
  makeTestWorkspace,
  openTestDatabase,
} from '../adapters/persistence/database.test-helpers.js';
import type { Caller } from '../domain/caller.js';
import type { Factory, FactoryFile } from '../domain/factory.js';
import type { Team } from '../domain/team.js';
import {
  changeFactory,
  createFactory,
  listFactories,
  readFactory,
  readFactoryVersion,
  saveFactoryFiles,
} from './factories.js';
import type { FactoryStore, TeamStore } from './ports.js';
import { callerAs as caller, fakeMembership } from './membership.test-helpers.js';
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

const dana = () => caller('person-dana', 'owner');
const eli = () => caller('person-eli', 'admin');
const fay = () => caller('person-fay', 'member');
const gus = () => caller('person-gus', 'member');

/**
 * Acme, made whole with Dana (owner), Eli (admin), Fay and Gus (members), and a Platform team only
 * Fay is in. Everyone is in the first team, General.
 */
async function acme(): Promise<{ general: Team; platform: Team }> {
  await makeTestWorkspace(db, membership, 'acme', [
    ['person-dana', 'owner'],
    ['person-eli', 'admin'],
    ['person-fay', 'member'],
    ['person-gus', 'member'],
  ]);
  const platform = await teams.create('acme', 'Platform');
  if (platform === 'name-taken') throw new Error('Platform was taken');
  const withFay = await teams.addMember('acme', platform.id, 'person-fay');
  if (typeof withFay === 'string') throw new Error(`Fay was not added: ${withFay}`);
  const [general] = await teams.list('acme');
  if (!general) throw new Error('Acme has no first team');
  return { general, platform: withFay };
}

async function made(who: Caller, name: string, teamId: string): Promise<Factory> {
  const answer = await createFactory(teams, factories, who, { name, teamId });
  if (answer.kind !== 'created') throw new Error(`${name} was not made: ${answer.kind}`);
  return answer.factory;
}

const AGENT = '---\ndescription: Reviews pull requests.\n---\nYou review pull requests.\n';
const FILES: FactoryFile[] = [
  { path: 'factory.yml', content: 'version: 1\nautomations:\n' },
  { path: 'agents/reviewer.md', content: AGENT },
];

describe('createFactory', () => {
  it('makes a blank factory that names its owning team, its files stored here', async () => {
    const { platform } = await acme();
    const answer = await createFactory(teams, factories, dana(), {
      name: ' Deploys ',
      teamId: platform.id,
    });
    expect(answer).toEqual({
      kind: 'created',
      factory: {
        id: expect.any(String),
        name: 'Deploys',
        teamId: platform.id,
        source: { kind: 'stored' },
        latestVersion: 1,
        updatedAt: expect.any(String),
      },
    });
  });

  it('lets a member make one for a team they are in, and no other', async () => {
    const { platform } = await acme();
    expect(
      await createFactory(teams, factories, fay(), { name: 'Deploys', teamId: platform.id }),
    ).toMatchObject({ kind: 'created' });
    expect(
      await createFactory(teams, factories, gus(), { name: 'Reviews', teamId: platform.id }),
    ).toEqual({ kind: 'team-not-found' });
  });

  it("refuses a team that is not the workspace's", async () => {
    await acme();
    expect(
      await createFactory(teams, factories, dana(), { name: 'Deploys', teamId: 'no-such-team' }),
    ).toEqual({ kind: 'team-not-found' });
  });

  it('names every problem with a name, and keeps names unique whatever their case', async () => {
    const { general } = await acme();
    expect(
      await createFactory(teams, factories, dana(), { name: '  ', teamId: general.id }),
    ).toEqual({ kind: 'invalid', problems: ['name_missing'] });
    await made(dana(), 'Deploys', general.id);
    expect(
      await createFactory(teams, factories, eli(), { name: 'deploys', teamId: general.id }),
    ).toEqual({ kind: 'name-taken' });
  });
});

describe('changeFactory', () => {
  it('renames a factory, trimmed, leaving its team, versions and when it was saved', async () => {
    const { platform } = await acme();
    const deploys = await made(fay(), 'Deploys', platform.id);
    await saveFactoryFiles(teams, factories, fay(), deploys.id, { baseVersion: 1, files: FILES });
    const [saved] = await factories.list('acme');

    const answer = await changeFactory(teams, factories, fay(), deploys.id, { name: ' Ship it ' });
    expect(answer).toEqual({ kind: 'changed', factory: { ...saved, name: 'Ship it' } });
    expect((await factories.version('acme', deploys.id, 2))?.files).toHaveLength(2);
  });

  it('takes a new case of its own name, and refuses another factory’s', async () => {
    const { general } = await acme();
    const deploys = await made(dana(), 'Deploys', general.id);
    await made(dana(), 'Reviews', general.id);
    expect(
      await changeFactory(teams, factories, dana(), deploys.id, { name: 'DEPLOYS' }),
    ).toMatchObject({ kind: 'changed', factory: { name: 'DEPLOYS' } });
    expect(await changeFactory(teams, factories, dana(), deploys.id, { name: 'reviews' })).toEqual({
      kind: 'name-taken',
    });
  });

  it('names every problem with a name before anything is read', async () => {
    expect(await changeFactory(teams, factories, dana(), 'x', { name: '\t' })).toEqual({
      kind: 'invalid',
      problems: ['name_missing'],
    });
    expect(
      await changeFactory(teams, factories, dana(), 'x', { name: `${'a'.repeat(65)}\u0007` }),
    ).toEqual({ kind: 'invalid', problems: ['name_too_long', 'name_invalid'] });
  });

  it('moves a factory to another team, renaming it in the same change when asked', async () => {
    const { general, platform } = await acme();
    const deploys = await made(dana(), 'Deploys', general.id);
    expect(
      await changeFactory(teams, factories, eli(), deploys.id, {
        name: 'Platform deploys',
        teamId: platform.id,
      }),
    ).toEqual({
      kind: 'changed',
      factory: { ...deploys, name: 'Platform deploys', teamId: platform.id },
    });
    // Gus is not in Platform, so the factory is gone from his sight.
    expect(await readFactory(teams, factories, gus(), deploys.id)).toEqual({ kind: 'not-found' });
  });

  it('lets a member move a factory of their team only to a team they are in', async () => {
    const { general, platform } = await acme();
    const design = await teams.create('acme', 'Design');
    if (design === 'name-taken') throw new Error('Design was taken');
    const deploys = await made(fay(), 'Deploys', platform.id);

    // Fay is in General and Platform, not Design.
    expect(await changeFactory(teams, factories, fay(), deploys.id, { teamId: design.id })).toEqual(
      { kind: 'team-not-found' },
    );
    expect(
      await changeFactory(teams, factories, fay(), deploys.id, {
        name: 'Elsewhere',
        teamId: design.id,
      }),
    ).toEqual({ kind: 'team-not-found' });
    expect(await factories.get('acme', deploys.id)).toEqual(deploys);
    expect(
      await changeFactory(teams, factories, fay(), deploys.id, { teamId: general.id }),
    ).toMatchObject({ kind: 'changed', factory: { teamId: general.id } });
  });

  it('keeps a factory from a member outside its team: not found, renamed or moved', async () => {
    const { general, platform } = await acme();
    const deploys = await made(fay(), 'Deploys', platform.id);
    // Gus is in General alone.
    for (const change of [{ name: 'Mine' }, { teamId: general.id }]) {
      expect(await changeFactory(teams, factories, gus(), deploys.id, change)).toEqual({
        kind: 'not-found',
      });
    }
    expect(await factories.get('acme', deploys.id)).toEqual(deploys);
  });

  it('lets an admin in no team but General move any factory to any team', async () => {
    const { general, platform } = await acme();
    const deploys = await made(fay(), 'Deploys', platform.id);
    const design = await teams.create('acme', 'Design');
    if (design === 'name-taken') throw new Error('Design was taken');
    expect(
      await changeFactory(teams, factories, eli(), deploys.id, { teamId: design.id }),
    ).toMatchObject({ kind: 'changed', factory: { teamId: design.id } });
    expect(
      await changeFactory(teams, factories, eli(), deploys.id, { teamId: general.id }),
    ).toMatchObject({ kind: 'changed', factory: { teamId: general.id } });
  });

  it('moves as a member once an admin is demoted: the role is the one read for the request', async () => {
    const { general, platform } = await acme();
    const deploys = await made(dana(), 'Deploys', general.id);
    membership.put('acme', 'person-eli', 'member');
    const demoted = caller('person-eli', 'member');
    // Eli is in General alone.
    expect(
      await changeFactory(teams, factories, demoted, deploys.id, { teamId: platform.id }),
    ).toEqual({ kind: 'team-not-found' });
    expect(
      await changeFactory(teams, factories, demoted, deploys.id, { name: 'Still mine' }),
    ).toMatchObject({ kind: 'changed' });
  });

  it('finds no team that is gone, or another workspace’s, to move to', async () => {
    const { general } = await acme();
    const deploys = await made(dana(), 'Deploys', general.id);
    const gone = await teams.create('acme', 'Gone');
    if (gone === 'name-taken') throw new Error('Gone was taken');
    expect(await teams.remove('acme', gone.id)).toBe('removed');
    expect(await changeFactory(teams, factories, dana(), deploys.id, { teamId: gone.id })).toEqual({
      kind: 'team-not-found',
    });
    expect(
      await changeFactory(teams, factories, dana(), deploys.id, { teamId: 'no-such-team' }),
    ).toEqual({ kind: 'team-not-found' });
  });

  it('changes nothing for a change that names neither, answering the factory', async () => {
    const { general } = await acme();
    const deploys = await made(dana(), 'Deploys', general.id);
    expect(await changeFactory(teams, factories, gus(), deploys.id, {})).toEqual({
      kind: 'changed',
      factory: deploys,
    });
  });

  it('changes nothing of another workspace, whoever asks', async () => {
    const { general } = await acme();
    const deploys = await made(dana(), 'Deploys', general.id);
    await makeTestWorkspace(db, membership, 'sprocket', [['person-dana', 'owner']]);
    const sprocketOwner = caller('person-dana', 'owner', 'sprocket');
    expect(
      await changeFactory(teams, factories, sprocketOwner, deploys.id, { name: 'Mine' }),
    ).toEqual({ kind: 'not-found' });
    expect(await factories.get('acme', deploys.id)).toEqual(deploys);
  });
});

describe('saving and reading files', () => {
  it('saves files as a new version, and reading returns the latest version', async () => {
    const { platform } = await acme();
    const deploys = await made(fay(), 'Deploys', platform.id);

    const saved = await saveFactoryFiles(teams, factories, fay(), deploys.id, {
      baseVersion: 1,
      files: FILES,
    });
    expect(saved).toEqual({
      kind: 'saved',
      version: {
        factoryId: deploys.id,
        version: 2,
        savedAt: expect.any(String),
        savedBy: 'person-fay',
        files: [FILES[1], FILES[0]],
      },
      notices: [],
    });

    const read = await readFactory(teams, factories, fay(), deploys.id);
    expect(read).toEqual({
      kind: 'found',
      factory: { ...deploys, latestVersion: 2, updatedAt: expect.any(String) },
      version: saved.kind === 'saved' ? saved.version : null,
    });
  });

  it('keeps every earlier version readable', async () => {
    const { general } = await acme();
    const deploys = await made(dana(), 'Deploys', general.id);
    await saveFactoryFiles(teams, factories, dana(), deploys.id, { baseVersion: 1, files: FILES });
    await saveFactoryFiles(teams, factories, eli(), deploys.id, { baseVersion: 2, files: [] });

    const first = await readFactoryVersion(teams, factories, gus(), deploys.id, 1);
    expect(first).toMatchObject({ kind: 'found', version: { version: 1, files: [] } });
    const second = await readFactoryVersion(teams, factories, gus(), deploys.id, 2);
    expect(second).toMatchObject({
      kind: 'found',
      version: { version: 2, savedBy: 'person-dana' },
    });
    expect(second.kind === 'found' && second.version.files.map((f) => f.path)).toEqual([
      'agents/reviewer.md',
      'factory.yml',
    ]);
    expect(await readFactoryVersion(teams, factories, gus(), deploys.id, 4)).toEqual({
      kind: 'version-not-found',
    });
  });

  it('refuses files that fail the factory schema, with the errors, and saves nothing', async () => {
    const { general } = await acme();
    const deploys = await made(dana(), 'Deploys', general.id);
    const answer = await saveFactoryFiles(teams, factories, dana(), deploys.id, {
      baseVersion: 1,
      files: [{ path: 'agents/reviewer.md', content: '---\ncolour: blue\n---\nYou review.\n' }],
    });
    expect(answer).toEqual({
      kind: 'invalid',
      issues: [
        expect.objectContaining({
          file: 'agents/reviewer.md',
          line: 2,
          message: 'Unrecognized key in an agent file: `colour`.',
        }),
      ],
    });
    expect(await readFactory(teams, factories, dana(), deploys.id)).toMatchObject({
      factory: { latestVersion: 1 },
    });
  });

  it('refuses a save from a version that is no longer the latest, naming the latest', async () => {
    const { general } = await acme();
    const deploys = await made(dana(), 'Deploys', general.id);
    await saveFactoryFiles(teams, factories, dana(), deploys.id, { baseVersion: 1, files: FILES });
    expect(
      await saveFactoryFiles(teams, factories, eli(), deploys.id, { baseVersion: 1, files: [] }),
    ).toEqual({ kind: 'moved', latestVersion: 2 });
  });

  it("tells a later slice's folder apart: stored, with factory-spec's notice", async () => {
    const { general } = await acme();
    const deploys = await made(dana(), 'Deploys', general.id);
    const answer = await saveFactoryFiles(teams, factories, dana(), deploys.id, {
      baseVersion: 1,
      files: [{ path: 'evals/accuracy.yaml', content: 'cases: []\n' }],
    });
    expect(answer).toMatchObject({
      kind: 'saved',
      notices: [{ message: expect.stringContaining('`evals/`') }],
    });
  });
});

describe('who sees a factory', () => {
  it('shows owners and admins every factory, and a member their teams’ alone', async () => {
    const { general, platform } = await acme();
    await made(dana(), 'Deploys', platform.id);
    await made(dana(), 'Reviews', general.id);
    const names = async (who: Caller) => {
      const answer = await listFactories(teams, factories, who);
      return answer.kind === 'listed' ? answer.factories.map((factory) => factory.name) : answer;
    };
    expect(await names(dana())).toEqual(['Deploys', 'Reviews']);
    expect(await names(eli())).toEqual(['Deploys', 'Reviews']);
    expect(await names(fay())).toEqual(['Deploys', 'Reviews']);
    expect(await names(gus())).toEqual(['Reviews']);
  });

  it('keeps a factory from a member outside its team: not found, never read or saved', async () => {
    const { platform } = await acme();
    const deploys = await made(fay(), 'Deploys', platform.id);
    expect(await readFactory(teams, factories, gus(), deploys.id)).toEqual({ kind: 'not-found' });
    expect(await readFactoryVersion(teams, factories, gus(), deploys.id, 1)).toEqual({
      kind: 'not-found',
    });
    expect(
      await saveFactoryFiles(teams, factories, gus(), deploys.id, { baseVersion: 1, files: FILES }),
    ).toEqual({ kind: 'not-found' });
    // An admin, in no team but General, sees it and may save it.
    expect(await readFactory(teams, factories, eli(), deploys.id)).toMatchObject({
      kind: 'found',
    });
    expect(
      await saveFactoryFiles(teams, factories, eli(), deploys.id, { baseVersion: 1, files: FILES }),
    ).toMatchObject({ kind: 'saved' });
  });

  it('sees as a member once an admin is demoted: the role is the one read for the request', async () => {
    const { platform } = await acme();
    const deploys = await made(fay(), 'Deploys', platform.id);
    membership.put('acme', 'person-eli', 'member');
    const demoted = caller('person-eli', 'member');
    expect(await readFactory(teams, factories, demoted, deploys.id)).toEqual({
      kind: 'not-found',
    });
    const listed = await listFactories(teams, factories, demoted);
    expect(listed).toEqual({ kind: 'listed', factories: [] });
  });

  it('finds no factory of another workspace, whoever asks', async () => {
    const { general } = await acme();
    const deploys = await made(dana(), 'Deploys', general.id);
    // Sprocket, where Dana is an owner too.
    await makeTestWorkspace(db, membership, 'sprocket', [['person-dana', 'owner']]);
    const sprocketOwner = caller('person-dana', 'owner', 'sprocket');
    expect(await listFactories(teams, factories, sprocketOwner)).toEqual({
      kind: 'listed',
      factories: [],
    });
    expect(await readFactory(teams, factories, sprocketOwner, deploys.id)).toEqual({
      kind: 'not-found',
    });
    expect(
      await saveFactoryFiles(teams, factories, sprocketOwner, deploys.id, {
        baseVersion: 1,
        files: [],
      }),
    ).toEqual({ kind: 'not-found' });
    expect(
      await createFactory(teams, factories, sprocketOwner, { name: 'Mine', teamId: general.id }),
    ).toEqual({ kind: 'team-not-found' });
  });
});
