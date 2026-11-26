import { PGlite } from '@electric-sql/pglite';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { asc } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GitHubEventStore } from '../../application/gitHubPorts.js';
import type { GitHubEvent } from '../../domain/webhooks.js';
import { createGitHubStores } from './gitHubStores.js';
import * as gitHubTables from './gitHubTables.js';

const { gitHubEvents } = gitHubTables;

let client: PGlite;
let db: PgliteDatabase;
let events: GitHubEventStore;

// GitHub's three tables alone, made from their definitions.
beforeEach(async () => {
  client = new PGlite();
  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(gitHubTables),
  );
  for (const statement of statements) await client.exec(statement);
  db = drizzle(client);
  ({ events } = createGitHubStores(db));
});

afterEach(async () => {
  if (!client.closed) await client.close();
});

/** Acme's installation 41 opening a pull request in the `sprocket` organisation's repository. */
const opened = (overrides: Partial<GitHubEvent> = {}): GitHubEvent => ({
  workspaceId: 'acme',
  deliveryId: '72d3162e-cc78-11e3-81ab-4c9367dc0958',
  event: 'pull_request',
  installationId: 41,
  payload: {
    action: 'opened',
    number: 7,
    pull_request: { title: 'Price the catalog in euros' },
    repository: { full_name: 'sprocket/catalog-portal' },
    installation: { id: 41 },
  },
  ...overrides,
});

const recorded = () =>
  db
    .select()
    .from(gitHubEvents)
    .orderBy(asc(gitHubEvents.workspaceId), asc(gitHubEvents.deliveryId));

describe('the GitHub event store', () => {
  it('records an event for its workspace, its payload as GitHub sent it', async () => {
    const event = opened();
    expect(await events.record(event)).toBe('recorded');
    expect(await recorded()).toEqual([
      {
        workspaceId: 'acme',
        deliveryId: event.deliveryId,
        event: 'pull_request',
        installationId: 41,
        payload: JSON.stringify(event.payload),
        receivedAt: expect.any(Date),
      },
    ]);
  });

  it('records a delivery once, however often it arrives, keeping the first', async () => {
    expect(await events.record(opened())).toBe('recorded');
    const again = opened({ payload: { action: 'closed', installation: { id: 41 } } });
    expect(await events.record(again)).toBe('recorded-before');

    const rows = await recorded();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.payload ?? '')).toMatchObject({ action: 'opened' });
  });

  it('records one delivery sent twice at once only once', async () => {
    const answers = await Promise.all([events.record(opened()), events.record(opened())]);
    expect(answers.sort()).toEqual(['recorded', 'recorded-before']);
    expect(await recorded()).toHaveLength(1);
  });

  it("keeps each workspace's events apart, a delivery id in another workspace included", async () => {
    expect(await events.record(opened())).toBe('recorded');
    expect(await events.record(opened({ workspaceId: 'sprocket' }))).toBe('recorded');
    expect((await recorded()).map((row) => row.workspaceId)).toEqual(['acme', 'sprocket']);
  });

  it('keeps a payload whatever it holds, a NUL character included', async () => {
    const payload = { action: 'edited', body: 'before\u0000after', installation: { id: 41 } };
    expect(await events.record(opened({ payload }))).toBe('recorded');
    expect(JSON.parse((await recorded())[0]?.payload ?? '')).toEqual(payload);
  });

  it('throws when the database does not answer', async () => {
    await client.close();
    await expect(events.record(opened())).rejects.toThrow();
  });
});
