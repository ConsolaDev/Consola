import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it } from 'vitest';
import { migrateDatabase, openDatabase } from './database.js';
import type { Database } from './database.js';
import { schema } from './schema.js';

const MIGRATIONS = fileURLToPath(new URL('../../../drizzle', import.meta.url));

type Journal = { entries: { idx: number; tag: string }[] };

/** Applies the migrations up to and including `lastTag`, as a database made back then had. */
async function migrateUpTo(db: Database, lastTag: string): Promise<void> {
  const journal = JSON.parse(
    await readFile(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8'),
  ) as Journal;
  const last = journal.entries.findIndex((entry) => entry.tag === lastTag);
  if (last === -1) throw new Error(`No migration is tagged ${lastTag}.`);
  const entries = journal.entries.slice(0, last + 1);
  const folder = await mkdtemp(join(tmpdir(), 'cloud-global-migrations-'));
  try {
    await mkdir(join(folder, 'meta'));
    await writeFile(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));
    for (const entry of entries) {
      await copyFile(join(MIGRATIONS, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    }
    await migrate(db as unknown as Parameters<typeof migrate>[0], { migrationsFolder: folder });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

async function tableNames(db: ReturnType<typeof openDatabase>['db']): Promise<string[]> {
  const result = (await db.execute(
    sql`select table_name from information_schema.tables where table_schema = 'public'`,
  )) as { rows: { table_name: string }[] };
  return result.rows.map((row) => String(row.table_name));
}

describe('the database', () => {
  it('migrates a fresh in-memory database', async () => {
    const { db, close } = openDatabase('pglite:memory');
    await migrateDatabase(db);
    expect(await tableNames(db)).toEqual(
      expect.arrayContaining([
        'user',
        'session',
        'account',
        'verification',
        'organization',
        'member',
        'invitation',
        'outbox_message',
      ]),
    );
    await close();
  });

  it('migrating twice changes nothing', async () => {
    const { db, close } = openDatabase('pglite:memory');
    await migrateDatabase(db);
    await expect(migrateDatabase(db)).resolves.toBeUndefined();
    await close();
  });

  it('keeps data in a pglite folder across reopen', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'cloud-global-db-'));
    const url = `pglite:${join(folder, 'db')}`;
    try {
      const first = openDatabase(url);
      await migrateDatabase(first.db);
      await first.db.insert(schema.organization).values({
        id: 'org-1',
        name: 'Sprocket',
        slug: 'sprocket',
        region: 'eu',
        createdAt: new Date(),
      });
      await first.close();

      const second = openDatabase(url);
      const rows = await second.db.select().from(schema.organization);
      expect(rows.map((row) => row.slug)).toEqual(['sprocket']);
      await second.close();
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('puts an organisation made before regions existed in eu', async () => {
    const { db, close } = openDatabase('pglite:memory');
    try {
      await migrateUpTo(db, '0000_futuristic_luckman');
      await db.execute(
        sql`insert into "organization" (id, name, slug, created_at) values ('org-1', 'Sprocket', 'sprocket', now())`,
      );

      await migrateDatabase(db);

      const rows = await db.select().from(schema.organization);
      expect(rows.map((row) => [row.slug, row.region])).toEqual([['sprocket', 'eu']]);
    } finally {
      await close();
    }
  });

  it("gives every workspace made before the outbox its messages, as a new one's", async () => {
    const { db, close } = openDatabase('pglite:memory');
    try {
      await migrateUpTo(db, '0001_organization_region');
      await db.execute(sql`insert into "user" (id, name, email, email_verified) values
        ('person-dana', 'Dana Ortiz', 'dana@sprocket.test', true),
        ('person-lee', 'Lee Park', 'lee@sprocket.test', true),
        ('person-sam', 'Sam Reyes', 'sam@acme.test', true)`);
      await db.execute(sql`insert into "organization" (id, name, slug, region, created_at) values
        ('sprocket-org', 'Sprocket', 'sprocket', 'us', now()),
        ('acme-org', 'Acme', 'acme', 'eu', now()),
        ('empty-org', 'Empty', 'empty', 'eu', now())`);
      // Lee joined Sprocket before Dana, and Dana twice: she is added once, as she first joined.
      await db.execute(sql`insert into "member" (id, organization_id, user_id, role, created_at) values
        ('m-1', 'sprocket-org', 'person-dana', 'owner', '2026-11-21T10:00:00Z'),
        ('m-2', 'sprocket-org', 'person-lee', 'member', '2026-11-21T09:00:00Z'),
        ('m-3', 'sprocket-org', 'person-dana', 'admin', '2026-11-21T12:00:00Z'),
        ('m-4', 'acme-org', 'person-sam', 'admin', '2026-11-21T11:00:00Z')`);

      await migrateDatabase(db);

      const rows = await db
        .select({
          workspaceId: schema.outboxMessage.organizationId,
          sequence: schema.outboxMessage.sequence,
          region: schema.outboxMessage.region,
          changeType: schema.outboxMessage.changeType,
          personId: schema.outboxMessage.personId,
          role: schema.outboxMessage.role,
          attempts: schema.outboxMessage.attempts,
          nextAttemptAt: schema.outboxMessage.nextAttemptAt,
          deliveredAt: schema.outboxMessage.deliveredAt,
        })
        .from(schema.outboxMessage)
        .orderBy(schema.outboxMessage.organizationId, schema.outboxMessage.sequence);
      const due = { attempts: 0, nextAttemptAt: null, deliveredAt: null };
      expect(rows).toEqual([
        {
          workspaceId: 'acme-org',
          sequence: 1,
          region: 'eu',
          changeType: 'workspace.created',
          personId: null,
          role: null,
          ...due,
        },
        {
          workspaceId: 'acme-org',
          sequence: 2,
          region: 'eu',
          changeType: 'member.added',
          personId: 'person-sam',
          role: 'admin',
          ...due,
        },
        {
          workspaceId: 'empty-org',
          sequence: 1,
          region: 'eu',
          changeType: 'workspace.created',
          personId: null,
          role: null,
          ...due,
        },
        {
          workspaceId: 'sprocket-org',
          sequence: 1,
          region: 'us',
          changeType: 'workspace.created',
          personId: null,
          role: null,
          ...due,
        },
        {
          workspaceId: 'sprocket-org',
          sequence: 2,
          region: 'us',
          changeType: 'member.added',
          personId: 'person-lee',
          role: 'member',
          ...due,
        },
        {
          workspaceId: 'sprocket-org',
          sequence: 3,
          region: 'us',
          changeType: 'member.added',
          personId: 'person-dana',
          role: 'owner',
          ...due,
        },
      ]);
    } finally {
      await close();
    }
  });

  it('refuses to guess a role the contract does not list, naming the workspace', async () => {
    const { db, close } = openDatabase('pglite:memory');
    try {
      await migrateUpTo(db, '0001_organization_region');
      await db.execute(sql`insert into "user" (id, name, email, email_verified) values
        ('person-dana', 'Dana Ortiz', 'dana@sprocket.test', true)`);
      await db.execute(sql`insert into "organization" (id, name, slug, region, created_at) values
        ('sprocket-org', 'Sprocket', 'sprocket', 'us', now())`);
      await db.execute(sql`insert into "member" (id, organization_id, user_id, role, created_at) values
        ('m-1', 'sprocket-org', 'person-dana', 'admin,member', now())`);

      const failure = await migrateDatabase(db).catch((error: unknown) => error);
      const messages: string[] = [];
      for (let at = failure; at instanceof Error; at = at.cause) messages.push(at.message);
      expect(messages.join('\n')).toContain(
        'A member of sprocket has a role the contract does not list. Set it to owner, admin or member, then start again.',
      );
      expect(messages.join('\n')).not.toContain('dana');
      // Nothing of the migration stays: no outbox, so the next start tries it again.
      expect(await tableNames(db)).not.toContain('outbox_message');

      await db.execute(sql`update "member" set role = 'admin' where id = 'm-1'`);
      await migrateDatabase(db);
      expect(await db.select().from(schema.outboxMessage)).toHaveLength(2);
    } finally {
      await close();
    }
  });

  it('refuses an organisation with no region', async () => {
    const { db, close } = openDatabase('pglite:memory');
    try {
      await migrateDatabase(db);
      await expect(
        db.execute(
          sql`insert into "organization" (id, name, slug, created_at) values ('org-1', 'Sprocket', 'sprocket', now())`,
        ),
      ).rejects.toThrow();
    } finally {
      await close();
    }
  });

  it('refuses an unknown scheme', () => {
    expect(() => openDatabase('mysql://x')).toThrow(/mysql/);
  });
});
