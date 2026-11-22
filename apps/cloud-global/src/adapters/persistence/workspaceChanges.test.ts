import { randomUUID } from 'node:crypto';
import { readOutboxMessage } from '@consola/cloud-contract';
import { asc, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Database, migrateDatabase, openDatabase } from './database.js';
import { schema } from './schema.js';
import { type WorkspaceChangeToWrite, writeWorkspaceChange } from './workspaceChanges.js';

let db: Database;
let close: () => Promise<void>;

/** The people of these tests, with the email and name a message must never carry. */
const PEOPLE = [
  { id: 'person-dana', name: 'Dana Ortiz', email: 'dana@acme.test' },
  { id: 'person-lee', name: 'Lee Park', email: 'lee@sprocket.test' },
  { id: 'person-sam', name: 'Sam Reyes', email: 'sam@acme.test' },
];

async function openWithPeople(url = 'pglite:memory', people = PEOPLE) {
  const opened = openDatabase(url);
  await migrateDatabase(opened.db);
  await opened.db.insert(schema.user).values(people.map((p) => ({ ...p, emailVerified: true })));
  return opened;
}

beforeEach(async () => {
  ({ db, close } = await openWithPeople());
});

afterEach(async () => {
  await close();
});

const write = (toWrite: WorkspaceChangeToWrite, on: Database = db) =>
  on.transaction((tx) => writeWorkspaceChange(tx, toWrite));

/** Makes Acme in the EU, owned by Dana, the way the workspace store does. */
async function makeAcme(on: Database = db): Promise<string> {
  const id = randomUUID();
  await on.transaction(async (tx) => {
    await writeWorkspaceChange(tx, {
      workspace: { id, name: 'Acme', slug: 'acme', region: 'eu' },
      change: { type: 'workspace.created' },
    });
    await writeWorkspaceChange(tx, {
      workspaceId: id,
      change: { type: 'member.added', personId: 'person-dana', role: 'owner' },
    });
  });
  return id;
}

/** Each of the workspace's messages as the store would hand it to its cell, in order. */
async function messagesOf(workspaceId: string, on: Database = db) {
  return on
    .select({
      sequence: schema.outboxMessage.sequence,
      changeType: schema.outboxMessage.changeType,
      personId: schema.outboxMessage.personId,
      role: schema.outboxMessage.role,
    })
    .from(schema.outboxMessage)
    .where(eq(schema.outboxMessage.organizationId, workspaceId))
    .orderBy(asc(schema.outboxMessage.sequence));
}

async function membersOf(workspaceId: string) {
  return db
    .select({ userId: schema.member.userId, role: schema.member.role })
    .from(schema.member)
    .where(eq(schema.member.organizationId, workspaceId))
    .orderBy(asc(schema.member.userId));
}

/** Every message along a failure's causes: drizzle words a failed query, Postgres its reason. */
async function failureOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const messages: string[] = [];
    for (let at: unknown = error; at instanceof Error; at = at.cause) messages.push(at.message);
    return messages.join('\n');
  }
  throw new Error('expected a failure');
}

/** Makes the database refuse every write of a kind to a table, as a failure the test chose. */
async function refuse(table: 'member' | 'outbox_message', writes = 'insert or update or delete') {
  await db.execute(
    sql.raw(`create or replace function refused_by_the_test() returns trigger language plpgsql
      as $$ begin raise exception 'refused by the test'; end $$`),
  );
  await db.execute(
    sql.raw(`create trigger refused_by_the_test before ${writes} on "${table}"
      for each row execute function refused_by_the_test()`),
  );
}

describe('writing a change with its message', () => {
  it('writes each of the four changes and its message, as ids and roles only', async () => {
    const id = randomUUID();
    const written = await db.transaction(async (tx) => [
      await writeWorkspaceChange(tx, {
        workspace: { id, name: 'Acme', slug: 'acme', region: 'eu' },
        change: { type: 'workspace.created' },
      }),
      await writeWorkspaceChange(tx, {
        workspaceId: id,
        change: { type: 'member.added', personId: 'person-dana', role: 'owner' },
      }),
      await writeWorkspaceChange(tx, {
        workspaceId: id,
        change: { type: 'member.added', personId: 'person-lee', role: 'member' },
      }),
      await writeWorkspaceChange(tx, {
        workspaceId: id,
        change: { type: 'member.role-changed', personId: 'person-lee', role: 'admin' },
      }),
      await writeWorkspaceChange(tx, {
        workspaceId: id,
        change: { type: 'member.removed', personId: 'person-lee' },
      }),
    ]);

    // The exact JSON each message is, so nothing about a person but their id rides along.
    expect(written.map((message) => JSON.stringify(message))).toEqual([
      `{"workspaceId":"${id}","region":"eu","sequence":1,"change":{"type":"workspace.created"}}`,
      `{"workspaceId":"${id}","region":"eu","sequence":2,"change":{"type":"member.added","personId":"person-dana","role":"owner"}}`,
      `{"workspaceId":"${id}","region":"eu","sequence":3,"change":{"type":"member.added","personId":"person-lee","role":"member"}}`,
      `{"workspaceId":"${id}","region":"eu","sequence":4,"change":{"type":"member.role-changed","personId":"person-lee","role":"admin"}}`,
      `{"workspaceId":"${id}","region":"eu","sequence":5,"change":{"type":"member.removed","personId":"person-lee"}}`,
    ]);
    for (const message of written) {
      expect(readOutboxMessage(JSON.parse(JSON.stringify(message)))).toEqual({
        ok: true,
        value: message,
      });
    }

    // The changes themselves, in the same transaction.
    expect(await db.select().from(schema.organization)).toEqual([
      expect.objectContaining({ id, name: 'Acme', slug: 'acme', region: 'eu' }),
    ]);
    expect(await membersOf(id)).toEqual([{ userId: 'person-dana', role: 'owner' }]);

    // And the rows, which hold nothing else either.
    const rows = await db.select().from(schema.outboxMessage);
    expect(rows).toHaveLength(5);
    const stored = JSON.stringify(rows);
    for (const person of PEOPLE) {
      expect(stored).not.toContain(person.email);
      expect(stored).not.toContain(person.name);
    }
    expect(stored).not.toContain('Acme');
    expect(rows.every((row) => row.deliveredAt === null && row.attempts === 0)).toBe(true);
    expect(rows.every((row) => row.nextAttemptAt === null)).toBe(true);
  });

  it('writes the region the workspace is in, read from its row', async () => {
    const id = randomUUID();
    await write({
      workspace: { id, name: 'Sprocket', slug: 'sprocket', region: 'us' },
      change: { type: 'workspace.created' },
    });
    const added = await write({
      workspaceId: id,
      change: { type: 'member.added', personId: 'person-lee', role: 'owner' },
    });
    expect(added?.region).toBe('us');
  });

  it('writes nothing for a change that changes nothing', async () => {
    const acme = await makeAcme();
    const before = await messagesOf(acme);

    const unchanged = [
      // A slug any workspace has.
      await write({
        workspace: { id: randomUUID(), name: 'Acme US', slug: 'acme', region: 'us' },
        change: { type: 'workspace.created' },
      }),
      // A workspace that is not there.
      await write({
        workspaceId: 'no-such-workspace',
        change: { type: 'member.added', personId: 'person-lee', role: 'member' },
      }),
      // A person already a member.
      await write({
        workspaceId: acme,
        change: { type: 'member.added', personId: 'person-dana', role: 'admin' },
      }),
      // Already in the role.
      await write({
        workspaceId: acme,
        change: { type: 'member.role-changed', personId: 'person-dana', role: 'owner' },
      }),
      // Not a member.
      await write({
        workspaceId: acme,
        change: { type: 'member.role-changed', personId: 'person-lee', role: 'admin' },
      }),
      await write({
        workspaceId: acme,
        change: { type: 'member.removed', personId: 'person-lee' },
      }),
    ];

    expect(unchanged).toEqual([null, null, null, null, null, null]);
    expect(await messagesOf(acme)).toEqual(before);
    expect(await db.select().from(schema.outboxMessage)).toHaveLength(2);
    expect(await membersOf(acme)).toEqual([{ userId: 'person-dana', role: 'owner' }]);
  });

  it('refuses a member change to a workspace that has no `workspace.created`', async () => {
    await db.insert(schema.organization).values({
      id: 'acme-unannounced',
      name: 'Acme',
      slug: 'acme',
      region: 'eu',
      createdAt: new Date(),
    });
    await expect(
      write({
        workspaceId: 'acme-unannounced',
        change: { type: 'member.added', personId: 'person-dana', role: 'owner' },
      }),
    ).rejects.toThrow(/has no `workspace.created`/);
    expect(await db.select().from(schema.member)).toEqual([]);
  });
});

describe('a change and its message commit together or not at all', () => {
  it('a workspace is not made when its message cannot be written', async () => {
    await refuse('outbox_message', 'insert');
    await expect(makeAcme()).rejects.toThrow();
    expect(await db.select().from(schema.organization)).toEqual([]);
    expect(await db.select().from(schema.member)).toEqual([]);
  });

  it('no message is written when the workspace or its first member cannot be', async () => {
    await refuse('member', 'insert');
    await expect(makeAcme()).rejects.toThrow();
    // `workspace.created` was written before the member failed, and went with it.
    expect(await db.select().from(schema.outboxMessage)).toEqual([]);
    expect(await db.select().from(schema.organization)).toEqual([]);
  });

  it.each<[string, WorkspaceChangeToWrite['change']]>([
    ['adding a member', { type: 'member.added', personId: 'person-lee', role: 'member' }],
    ['changing a role', { type: 'member.role-changed', personId: 'person-dana', role: 'admin' }],
    ['removing a member', { type: 'member.removed', personId: 'person-dana' }],
  ])('%s does not happen when its message cannot be written', async (_what, change) => {
    const acme = await makeAcme();
    await refuse('outbox_message', 'insert');

    await expect(write({ workspaceId: acme, change })).rejects.toThrow();
    expect(await membersOf(acme)).toEqual([{ userId: 'person-dana', role: 'owner' }]);
    expect(await messagesOf(acme)).toHaveLength(2);
  });

  it.each<[string, WorkspaceChangeToWrite['change']]>([
    ['adding a member', { type: 'member.added', personId: 'person-lee', role: 'member' }],
    ['changing a role', { type: 'member.role-changed', personId: 'person-dana', role: 'admin' }],
    ['removing a member', { type: 'member.removed', personId: 'person-dana' }],
  ])('%s writes no message when the change itself fails', async (_what, change) => {
    const acme = await makeAcme();
    await refuse('member');

    await expect(write({ workspaceId: acme, change })).rejects.toThrow();
    expect(await messagesOf(acme)).toHaveLength(2);
  });

  it('a transaction that fails after writing undoes both', async () => {
    const acme = await makeAcme();
    await expect(
      db.transaction(async (tx) => {
        await writeWorkspaceChange(tx, {
          workspaceId: acme,
          change: { type: 'member.added', personId: 'person-lee', role: 'member' },
        });
        throw new Error('the caller failed');
      }),
    ).rejects.toThrow('the caller failed');
    expect(await membersOf(acme)).toEqual([{ userId: 'person-dana', role: 'owner' }]);
    expect(await messagesOf(acme)).toHaveLength(2);
  });
});

describe('the outbox table', () => {
  /** A row as raw SQL, past every check the writer makes, so only the table's own stand. */
  const insert = (values: string) =>
    db.execute(
      sql.raw(`insert into outbox_message
        (organization_id, sequence, region, change_type, person_id, role, created_at)
        values (${values}, now())`),
    );

  it.each([
    [
      'a role the contract does not list',
      `'acme', 2, 'eu', 'member.added', 'person-dana', 'admin,member'`,
    ],
    ['a role on a removal', `'acme', 2, 'eu', 'member.removed', 'person-dana', 'owner'`],
    ['a member change with no person', `'acme', 2, 'eu', 'member.added', null, 'owner'`],
    ['a member change first', `'acme', 1, 'eu', 'member.added', 'person-dana', 'owner'`],
    [
      'a workspace made after its first message',
      `'acme', 2, 'eu', 'workspace.created', null, null`,
    ],
    ['a person on a new workspace', `'acme', 1, 'eu', 'workspace.created', 'person-dana', null`],
    [
      'a change the contract does not name',
      `'acme', 2, 'eu', 'member.renamed', 'person-dana', null`,
    ],
    ['a region the contract does not list', `'acme', 1, 'apac', 'workspace.created', null, null`],
  ])('refuses %s', async (_what, values) => {
    expect(await failureOf(insert(values))).toMatch(/violates check constraint/);
  });

  it('refuses a second message at the same place', async () => {
    await insert(`'acme', 1, 'eu', 'workspace.created', null, null`);
    expect(await failureOf(insert(`'acme', 1, 'eu', 'workspace.created', null, null`))).toMatch(
      /duplicate key/,
    );
  });
});

/** Twenty more people, for changes that race. */
const CROWD = Array.from({ length: 20 }, (_, i) => ({
  id: `person-${i}`,
  name: `Person ${i}`,
  email: `person-${i}@sprocket.test`,
}));

/**
 * A database of its own, with every person in it: PGlite in memory, or, when
 * CLOUD_GLOBAL_TEST_POSTGRES_URL names a Postgres server's maintenance database, a database the
 * test makes there and drops after.
 */
async function databaseOn(driver: 'PGlite' | 'Postgres', adminUrl: string | undefined) {
  if (driver === 'PGlite') return openWithPeople('pglite:memory', [...PEOPLE, ...CROWD]);
  const admin = openDatabase(adminUrl as string);
  const name = `cloud_global_test_${randomUUID().replaceAll('-', '')}`;
  await admin.db.execute(sql.raw(`create database ${name}`));
  const url = new URL(adminUrl as string);
  url.pathname = `/${name}`;
  const opened = await openWithPeople(url.toString(), [...PEOPLE, ...CROWD]);
  return {
    db: opened.db,
    async close() {
      await opened.close();
      await admin.db.execute(sql.raw(`drop database ${name} with (force)`));
      await admin.close();
    },
  };
}

/**
 * Sequences while changes race. PGlite runs one transaction at a time, so there this proves the
 * counting; on a real Postgres, where they run at once, it proves the lock. Without it, two
 * changes would count from the same last message, and one would fail on the primary key.
 */
describe.each([
  ['PGlite' as const, undefined],
  ['Postgres' as const, process.env.CLOUD_GLOBAL_TEST_POSTGRES_URL],
])('sequences on %s', (driver, adminUrl) => {
  const runs = driver === 'PGlite' || adminUrl !== undefined;

  it.skipIf(!runs)('count each workspace from 1, with no gaps, while changes race', async () => {
    const own = await databaseOn(driver, adminUrl);
    try {
      const acme = await makeAcme(own.db);
      const sprocket = randomUUID();
      await write(
        {
          workspace: { id: sprocket, name: 'Sprocket', slug: 'sprocket', region: 'us' },
          change: { type: 'workspace.created' },
        },
        own.db,
      );

      // Twenty people join both at once, each in a transaction of their own, beside a role
      // change, and a change that rolls back after it has written its message.
      const joins = CROWD.flatMap((person) =>
        [acme, sprocket].map((workspaceId) =>
          write(
            { workspaceId, change: { type: 'member.added', personId: person.id, role: 'member' } },
            own.db,
          ),
        ),
      );
      const rolledBack = own.db
        .transaction(async (tx) => {
          await writeWorkspaceChange(tx, {
            workspaceId: acme,
            change: { type: 'member.added', personId: 'person-lee', role: 'admin' },
          });
          throw new Error('rolled back');
        })
        .catch((error: Error) => error.message);
      const roleChange = write(
        {
          workspaceId: acme,
          change: { type: 'member.role-changed', personId: 'person-dana', role: 'admin' },
        },
        own.db,
      );
      // Every write but the one that rolls back succeeds: none lost a race on the primary key.
      const written = await Promise.all([...joins, roleChange]);
      expect(written.every((message) => message !== null)).toBe(true);
      expect(await rolledBack).toBe('rolled back');

      const sequences = async (workspaceId: string) =>
        (await messagesOf(workspaceId, own.db)).map((message) => message.sequence);
      const upTo = (last: number) => Array.from({ length: last }, (_, i) => i + 1);
      // Acme: made, Dana, twenty people and a role change; the add that rolled back left no gap.
      expect(await sequences(acme)).toEqual(upTo(23));
      expect(await sequences(sprocket)).toEqual(upTo(21));
      // Each message names the place it was written at, so what each change was told matches.
      expect(
        written
          .filter((message) => message?.workspaceId === acme)
          .map((message) => message?.sequence)
          .sort((a, b) => (a ?? 0) - (b ?? 0)),
      ).toEqual(upTo(23).slice(2));
    } finally {
      await own.close();
    }
  });
});
