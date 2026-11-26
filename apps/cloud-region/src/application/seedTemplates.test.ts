import { CODE_REVIEW_TEAM_FILES } from '@consola/factory-spec';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateDatabase, openDatabase } from '../adapters/persistence/database.js';
import type { Database } from '../adapters/persistence/database.js';
import { createDrizzleStores } from '../adapters/persistence/stores.js';
import type { FactoryStore, TeamStore, WorkspaceCopies } from './ports.js';
import { seedCodeReviewTeam } from './seedTemplates.js';

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

async function holdAcme() {
  await workspaceCopies.applyAfter({
    workspaceId: 'acme',
    sequence: 1,
    after: null,
    change: { kind: 'open-workspace' },
  });
  await workspaceCopies.applyAfter({
    workspaceId: 'acme',
    sequence: 2,
    after: 1,
    change: { kind: 'put-member', personId: 'person-dana', role: 'owner' },
  });
}

const sorted = (files: ReadonlyArray<{ path: string; content: string }>) =>
  [...files].sort((a, b) => (a.path < b.path ? -1 : 1));

describe('seedCodeReviewTeam', () => {
  it('installs the code review team on the first team, and saves again only when its files differ', async () => {
    await holdAcme();
    const ports = { teams, factories };

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

  it('does nothing for a workspace the cell does not hold', async () => {
    expect(await seedCodeReviewTeam({ teams, factories }, 'globex')).toBe('workspace-pending');
  });
});
