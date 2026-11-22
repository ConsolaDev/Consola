import { cellTokenClaims, type WorkspaceRole } from '@consola/cloud-contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Database, migrateDatabase, openDatabase } from '../adapters/persistence/database.js';
import { createDrizzleStores } from '../adapters/persistence/stores.js';
import { admitClaims, type Caller } from '../domain/caller.js';
import type { Factory, FactoryFile } from '../domain/factory.js';
import type { Team } from '../domain/team.js';
import {
  createFactory,
  listFactories,
  readFactory,
  readFactoryVersion,
  saveFactoryFiles,
} from './factories.js';
import type { FactoryStore, TeamStore, WorkspaceCopies } from './ports.js';

let db: Database;
let close: () => Promise<void>;
let teams: TeamStore;
let factories: FactoryStore;
let workspaceCopies: WorkspaceCopies;

beforeEach(async () => {
  ({ db, close } = openDatabase('pglite:memory'));
  await migrateDatabase(db);
  ({ teams, factories, workspaceCopies } = createDrizzleStores(db));
});

afterEach(async () => {
  await close();
});

/** Who a checked cell token names: only `admitClaims` makes a caller. */
function caller(personId: string, role: WorkspaceRole, workspaceId = 'acme'): Caller {
  const now = Math.floor(Date.now() / 1000);
  const claims = cellTokenClaims({ personId, workspaceId, role, region: 'eu', issuedAt: now });
  const admitted = admitClaims(claims, now, 'eu');
  if (admitted.kind !== 'accepted') throw new Error('the token was not accepted');
  return admitted.caller;
}

const dana = () => caller('person-dana', 'owner');
const eli = () => caller('person-eli', 'admin');
const fay = () => caller('person-fay', 'member');
const gus = () => caller('person-gus', 'member');

let sequence = 0;

/** Applies `change` to Acme's copy, the way the outbox does. */
async function apply(change: Parameters<WorkspaceCopies['applyAfter']>[0]['change']) {
  sequence += 1;
  await workspaceCopies.applyAfter({
    workspaceId: 'acme',
    sequence,
    after: sequence === 1 ? null : sequence - 1,
    change,
  });
}

/**
 * Acme, opened in the copy with Dana (owner), Eli (admin), Fay and Gus (members), and a Platform
 * team only Fay is in. Everyone is in the first team, General.
 */
async function acme(): Promise<{ general: Team; platform: Team }> {
  sequence = 0;
  await apply({ kind: 'open-workspace' });
  for (const [personId, role] of [
    ['person-dana', 'owner'],
    ['person-eli', 'admin'],
    ['person-fay', 'member'],
    ['person-gus', 'member'],
  ] as const) {
    await apply({ kind: 'put-member', personId, role });
  }
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

  it('is pending while the cell does not hold the workspace', async () => {
    expect(
      await createFactory(teams, factories, dana(), { name: 'Deploys', teamId: 'general' }),
    ).toEqual({ kind: 'workspace-pending' });
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

  it('follows the copy: an admin demoted since their token was minted sees as a member', async () => {
    const { platform } = await acme();
    const deploys = await made(fay(), 'Deploys', platform.id);
    await apply({ kind: 'put-member', personId: 'person-eli', role: 'member' });
    // The same token, still saying admin.
    expect(await readFactory(teams, factories, eli(), deploys.id)).toEqual({ kind: 'not-found' });
    const listed = await listFactories(teams, factories, eli());
    expect(listed).toEqual({ kind: 'listed', factories: [] });
  });

  it('shows nothing to someone the copy does not hold', async () => {
    const { general } = await acme();
    const deploys = await made(dana(), 'Deploys', general.id);
    const stranger = caller('person-hal', 'owner');
    expect(await listFactories(teams, factories, stranger)).toEqual({
      kind: 'listed',
      factories: [],
    });
    expect(await readFactory(teams, factories, stranger, deploys.id)).toEqual({
      kind: 'not-found',
    });
    expect(
      await createFactory(teams, factories, stranger, { name: 'Mine', teamId: general.id }),
    ).toEqual({ kind: 'team-not-found' });
  });

  it('finds no factory of another workspace, whoever asks', async () => {
    const { general } = await acme();
    const deploys = await made(dana(), 'Deploys', general.id);
    // Sprocket, where Dana is an owner too.
    await workspaceCopies.applyAfter({
      workspaceId: 'sprocket',
      sequence: 1,
      after: null,
      change: { kind: 'open-workspace' },
    });
    await workspaceCopies.applyAfter({
      workspaceId: 'sprocket',
      sequence: 2,
      after: 1,
      change: { kind: 'put-member', personId: 'person-dana', role: 'owner' },
    });
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

  it('is pending while the cell does not hold the workspace', async () => {
    expect(await listFactories(teams, factories, dana())).toEqual({ kind: 'workspace-pending' });
    expect(await readFactory(teams, factories, dana(), 'x')).toEqual({
      kind: 'workspace-pending',
    });
  });
});
