import { readFileSync } from 'node:fs';
import { getTableName, is } from 'drizzle-orm';
import {
  foreignKey,
  getTableConfig,
  integer,
  pgTable,
  PgTable,
  primaryKey,
  text,
} from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { SCHEMA } from './persistence/database.js';

/**
 * The two rules that keep the data splittable ("Cloud · Design: One cloud app, one database
 * (40.1)", https://linear.app/consola/document/cloud-design-one-cloud-app-one-database-401-bfb98a2a64db):
 *
 * 1. Every company table carries its workspace id: a `workspace_id text not null`.
 * 2. Company data refers to people only by id: no foreign key from a company table into an
 *    accounts table, no column that holds an email, and no column that holds a person's name.
 *
 * Both are checked over the one Drizzle schema and over every migration (`drizzle/*.sql`), so a
 * table or column only a migration makes is checked too. Each check is also shown to fail, on a
 * fixture schema and a fixture migration that break it.
 *
 * Whom rule 2 covers: Consola's accounts, the people in `user`. What GitHub says about its own
 * users is the company's content, as it was in the cell: a push's commit authors in
 * `github_event.payload`, and `github_installation.account_login` on a personal account, stay
 * in company tables.
 */

/** The accounts tables, the only ones without a `workspace_id`, each with why. */
const ACCOUNT_TABLES: Record<string, string> = {
  user: 'accounts: a person',
  account: 'accounts: the Google account a person signs in with',
  session: "accounts: a person's sessions",
  verification: 'accounts: a sign-in in progress',
  organization: 'the workspace registry: its id is the workspace id',
  member: "Better Auth's membership, keyed by organization_id",
  invitation: "Better Auth's membership, keyed by organization_id",
};

/**
 * The company columns named `name` or ending in `_name`, each with what it holds: never a
 * person's name. A new one is added here, with its reason, or renamed.
 */
const NAME_COLUMNS: Record<string, string> = {
  'team.name': "the team's name, which the workspace gives it",
  'factory.name': "the factory's name, which the workspace gives it",
};

/** A table as the rules read it, from the schema or from the migrations alike. */
type TableFacts = {
  name: string;
  columns: Map<string, { type: string; notNull: boolean }>;
  /** Every table a foreign key of this one points into, by constraint name. */
  references: Map<string, string>;
};

/** Each way the tables break a rule, as `<table>[.<column>]: <what>`, sorted. */
function ruleBreaks(
  tables: readonly TableFacts[],
  accountTables: Record<string, string>,
  nameColumns: Record<string, string>,
): string[] {
  const breaks: string[] = [];
  const accounts = new Set(Object.keys(accountTables));
  for (const table of tables) {
    if (accounts.has(table.name)) continue;

    // Rule 1.
    const workspaceId = table.columns.get('workspace_id');
    if (!workspaceId) {
      breaks.push(`${table.name}: has no workspace_id`);
    } else {
      if (workspaceId.type !== 'text') {
        breaks.push(`${table.name}.workspace_id: is ${workspaceId.type}, not text`);
      }
      if (!workspaceId.notNull) breaks.push(`${table.name}.workspace_id: may be null`);
    }

    // Rule 2: no foreign key out, no email, no person's name.
    for (const target of new Set(table.references.values())) {
      if (accounts.has(target)) breaks.push(`${table.name}: has a foreign key into ${target}`);
    }
    for (const column of table.columns.keys()) {
      const named = `${table.name}.${column}`;
      if (column.includes('email')) breaks.push(`${named}: may hold an email`);
      const isName = column === 'name' || column.endsWith('_name');
      if (isName && !(named in nameColumns)) {
        breaks.push(`${named}: may hold a person's name, and is not on the allow-list`);
      }
    }
  }
  return breaks.sort();
}

/** The schema's tables, as the rules read them. */
function tablesOfSchema(schema: Record<string, unknown>): TableFacts[] {
  return Object.values(schema)
    .filter((value): value is PgTable => is(value, PgTable))
    .map((table) => {
      const config = getTableConfig(table);
      return {
        name: config.name,
        columns: new Map(
          config.columns.map((column) => [
            column.name,
            { type: column.getSQLType(), notNull: column.notNull },
          ]),
        ),
        references: new Map(
          config.foreignKeys.map((key) => [
            key.getName(),
            getTableName(key.reference().foreignTable),
          ]),
        ),
      };
    });
}

/** `"name"`, `"public"."name"` or a bare name, as drizzle-kit writes one: the name, unquoted. */
const NAME = String.raw`(?:"[^"]+"\.)?"?([^"\s(]+)"?`;

/** What a foreign key in a statement points into: the table after `REFERENCES`. */
const REFERENCED = new RegExp(String.raw`\bREFERENCES ${NAME}`, 'i');

/** `body` split at its commas, but none inside parentheses or quotes. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let at = 0; at < body.length; at += 1) {
    const char = body[at];
    if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      parts.push(body.slice(start, at));
      start = at + 1;
    }
  }
  parts.push(body.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/** A column's definition as SQL writes it: its name, its type, and whether it is required. */
function readColumn(definition: string): { name: string; type: string; notNull: boolean } {
  const found = /^"([^"]+)"\s+(.+)$/s.exec(definition.trim());
  if (!found) throw new Error(`Cannot read this column: ${definition}`);
  const [, name = '', rest = ''] = found;
  const [type = ''] = rest.split(
    /\s+(?:PRIMARY|NOT|NULL|DEFAULT|REFERENCES|UNIQUE|CONSTRAINT|GENERATED|CHECK)\b/i,
  );
  // A primary key's column is required whether or not the statement says so.
  const notNull = /\bNOT NULL\b/i.test(rest) || /\bPRIMARY KEY\b/i.test(rest);
  return { name, type: type.trim().toLowerCase(), notNull };
}

/** Adds the column `definition` names to `table`, with the foreign key it holds, if any. */
function addColumn(table: TableFacts, definition: string): void {
  const column = readColumn(definition);
  table.columns.set(column.name, { type: column.type, notNull: column.notNull });
  const inline = REFERENCED.exec(definition);
  if (inline) table.references.set(`${table.name}.${column.name}`, inline[1] ?? '');
}

/** A statement that changes nothing the rules read. */
const LEFT_ALONE =
  /^(?:CREATE (?:UNIQUE )?INDEX|DROP INDEX|CREATE SCHEMA|CREATE TYPE|CREATE EXTENSION)\b/i;

/** A change to a table that touches neither its columns' names, types and nulls nor its keys out. */
const CHANGE_LEFT_ALONE =
  /^(?:ADD CONSTRAINT "[^"]+" (?:UNIQUE|PRIMARY KEY|CHECK)|ALTER COLUMN "[^"]+" (?:SET|DROP) DEFAULT|(?:ENABLE|DISABLE) ROW LEVEL SECURITY)\b/i;

/** One `ALTER TABLE` change, applied to `table`. */
function applyChange(table: TableFacts, change: string): void {
  const column = (name: string | undefined) => {
    const found = table.columns.get(name ?? '');
    if (!found) throw new Error(`${table.name} has no column ${name} to change`);
    return found;
  };

  const added = /^ADD COLUMN (?:IF NOT EXISTS )?(.+)$/is.exec(change);
  if (added) {
    addColumn(table, added[1] ?? '');
    return;
  }

  const dropped = /^DROP COLUMN (?:IF EXISTS )?"([^"]+)"/i.exec(change);
  if (dropped) {
    table.columns.delete(dropped[1] ?? '');
    return;
  }

  const renamed = /^RENAME COLUMN "([^"]+)" TO "([^"]+)"$/i.exec(change);
  if (renamed) {
    const kept = column(renamed[1]);
    table.columns.delete(renamed[1] ?? '');
    table.columns.set(renamed[2] ?? '', kept);
    return;
  }

  const required = /^ALTER COLUMN "([^"]+)" (SET|DROP) NOT NULL$/i.exec(change);
  if (required) {
    column(required[1]).notNull = required[2]?.toUpperCase() === 'SET';
    return;
  }

  const retyped = /^ALTER COLUMN "([^"]+)" SET DATA TYPE (.+?)(?: USING .*)?$/is.exec(change);
  if (retyped) {
    column(retyped[1]).type = (retyped[2] ?? '').trim().toLowerCase();
    return;
  }

  const keyed = new RegExp(
    `^ADD CONSTRAINT "([^"]+)" FOREIGN KEY .*${REFERENCED.source}`,
    'is',
  ).exec(change);
  if (keyed) {
    table.references.set(keyed[1] ?? '', keyed[2] ?? '');
    return;
  }

  const unkeyed = /^DROP CONSTRAINT (?:IF EXISTS )?"([^"]+)"/i.exec(change);
  if (unkeyed) {
    table.references.delete(unkeyed[1] ?? '');
    return;
  }

  if (!CHANGE_LEFT_ALONE.test(change)) {
    throw new Error(`Cannot read this change to ${table.name}: ${change}`);
  }
}

/**
 * The tables the migrations leave, as the rules read them: every statement applied in order, as
 * drizzle-kit writes them. A statement this cannot read fails the test, so the rules are never
 * checked against a guess.
 */
function tablesOfMigrations(migrations: readonly string[]): TableFacts[] {
  const tables = new Map<string, TableFacts>();
  const tableNamed = (name: string | undefined): TableFacts => {
    const table = tables.get(name ?? '');
    if (!table) throw new Error(`A migration changes ${name}, which no migration made.`);
    return table;
  };
  const statements = migrations.flatMap((migration) =>
    migration
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim().replace(/;$/, ''))
      .filter((statement) => statement !== ''),
  );

  for (const statement of statements) {
    const created = new RegExp(
      String.raw`^CREATE TABLE (?:IF NOT EXISTS )?${NAME} \((.*)\)$`,
      'is',
    ).exec(statement);
    if (created) {
      const table: TableFacts = {
        name: created[1] ?? '',
        columns: new Map(),
        references: new Map(),
      };
      for (const part of splitTopLevel(created[2] ?? '')) {
        if (!/^CONSTRAINT\b/i.test(part)) {
          addColumn(table, part);
          continue;
        }
        const key = /^CONSTRAINT "([^"]+)" FOREIGN KEY\b/i.exec(part);
        const into = REFERENCED.exec(part);
        if (key && into) table.references.set(key[1] ?? '', into[1] ?? '');
      }
      tables.set(table.name, table);
      continue;
    }

    const dropped = new RegExp(`^DROP TABLE (?:IF EXISTS )?${NAME}`, 'i').exec(statement);
    if (dropped) {
      tables.delete(dropped[1] ?? '');
      continue;
    }

    const renamed = new RegExp(`^ALTER TABLE ${NAME} RENAME TO ${NAME}$`, 'i').exec(statement);
    if (renamed) {
      const table = tableNamed(renamed[1]);
      tables.delete(table.name);
      table.name = renamed[2] ?? '';
      tables.set(table.name, table);
      continue;
    }

    const altered = new RegExp(`^ALTER TABLE ${NAME} (.+)$`, 'is').exec(statement);
    if (altered) {
      applyChange(tableNamed(altered[1]), altered[2] ?? '');
      continue;
    }

    if (!LEFT_ALONE.test(statement)) {
      throw new Error(`Cannot read this statement: ${statement.split('\n')[0]}`);
    }
  }
  return [...tables.values()];
}

/** The app's migrations, in the order the journal applies them. */
function readMigrations(): string[] {
  const folder = new URL('../drizzle/', import.meta.url);
  const journal = JSON.parse(readFileSync(new URL('meta/_journal.json', folder), 'utf8')) as {
    entries: Array<{ tag: string }>;
  };
  return journal.entries.map((entry) => readFileSync(new URL(`${entry.tag}.sql`, folder), 'utf8'));
}

const names = (tables: readonly TableFacts[]) => tables.map((table) => table.name).sort();

describe('the two rules, over the one schema', () => {
  const tables = tablesOfSchema(SCHEMA);

  it('reads every table the schema declares', () => {
    expect(names(tables)).toEqual(
      expect.arrayContaining(['user', 'organization', 'team', 'run', 'github_installation']),
    );
  });

  it('holds both: every company table has its workspace_id, and people only by id', () => {
    expect(ruleBreaks(tables, ACCOUNT_TABLES, NAME_COLUMNS)).toEqual([]);
  });

  it('names only accounts tables that exist, and only name columns that exist', () => {
    expect(Object.keys(ACCOUNT_TABLES).filter((name) => !names(tables).includes(name))).toEqual([]);
    const columns = new Set(
      tables.flatMap((table) =>
        [...table.columns.keys()].map((column) => `${table.name}.${column}`),
      ),
    );
    expect(Object.keys(NAME_COLUMNS).filter((column) => !columns.has(column))).toEqual([]);
  });
});

describe('the two rules, over every migration', () => {
  const tables = tablesOfMigrations(readMigrations());

  it('reads the tables the schema declares, no more and no fewer', () => {
    expect(names(tables)).toEqual(names(tablesOfSchema(SCHEMA)));
  });

  it('holds both', () => {
    expect(ruleBreaks(tables, ACCOUNT_TABLES, NAME_COLUMNS)).toEqual([]);
  });

  it('reads the same columns and foreign keys as the schema has', () => {
    const shape = (each: readonly TableFacts[]) =>
      Object.fromEntries(
        each.map((table) => [
          table.name,
          {
            columns: Object.fromEntries(
              [...table.columns].map(([name, { notNull }]) => [name, notNull]),
            ),
            references: [...new Set(table.references.values())].sort(),
          },
        ]),
      );
    expect(shape(tables)).toEqual(shape(tablesOfSchema(SCHEMA)));
  });
});

// Fixtures that break each check, so a check that stopped checking would show here.
const fixtureUser = pgTable('user', { id: text('id').primaryKey(), email: text('email') });
const fixtureOrganization = pgTable('organization', { id: text('id').primaryKey() });
const fixtureMember = pgTable('member', { id: text('id').primaryKey() });
const workspaceId = () => text('workspace_id').notNull();

const FIXTURE_SCHEMA = {
  fixtureUser,
  fixtureOrganization,
  fixtureMember,
  // Rule 1.
  widget: pgTable('widget', { id: text('id').primaryKey() }),
  gadget: pgTable('gadget', { workspaceId: text('workspace_id') }),
  gizmo: pgTable('gizmo', { workspaceId: integer('workspace_id').notNull() }),
  // Rule 2: foreign keys out.
  note: pgTable('note', {
    workspaceId: workspaceId(),
    authorId: text('author_id').references(() => fixtureUser.id),
    workspace: text('workspace').references(() => fixtureOrganization.id),
  }),
  // A key declared on the table, as company's composite keys are.
  seat: pgTable(
    'seat',
    { workspaceId: workspaceId(), memberId: text('member_id').notNull() },
    (table) => [
      primaryKey({ columns: [table.workspaceId, table.memberId] }),
      foreignKey({
        name: 'seat_member_fk',
        columns: [table.memberId],
        foreignColumns: [fixtureMember.id],
      }),
    ],
  ),
  // Rule 2: emails and names.
  contact: pgTable('contact', {
    workspaceId: workspaceId(),
    authorEmail: text('author_email'),
    email: text('email'),
  }),
  profile: pgTable('profile', {
    workspaceId: workspaceId(),
    personName: text('person_name'),
    displayName: text('display_name'),
    name: text('name'),
  }),
  // Holds both: its name is on the fixture's allow-list.
  shelf: pgTable('shelf', { workspaceId: workspaceId(), name: text('name') }),
};

const FIXTURE_ACCOUNTS = { user: 'a person', organization: 'workspaces', member: 'membership' };
const FIXTURE_NAMES = { 'shelf.name': "the shelf's name" };

/** What every fixture breaks, as `ruleBreaks` words it. */
const FIXTURE_BREAKS = [
  'contact.author_email: may hold an email',
  'contact.email: may hold an email',
  'gadget.workspace_id: may be null',
  'gizmo.workspace_id: is integer, not text',
  'note: has a foreign key into organization',
  'note: has a foreign key into user',
  "profile.display_name: may hold a person's name, and is not on the allow-list",
  "profile.name: may hold a person's name, and is not on the allow-list",
  "profile.person_name: may hold a person's name, and is not on the allow-list",
  'seat: has a foreign key into member',
  'widget: has no workspace_id',
];

describe('each check fails when its rule is broken', () => {
  it('on a fixture schema', () => {
    expect(ruleBreaks(tablesOfSchema(FIXTURE_SCHEMA), FIXTURE_ACCOUNTS, FIXTURE_NAMES)).toEqual(
      FIXTURE_BREAKS,
    );
  });

  it('on a fixture migration, the changes after a table is made included', () => {
    const first = `CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text
);
--> statement-breakpoint
CREATE TABLE "organization" ("id" text PRIMARY KEY NOT NULL);
--> statement-breakpoint
CREATE TABLE "member" ("id" text PRIMARY KEY NOT NULL);
--> statement-breakpoint
CREATE TABLE "widget" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gadget" (
	"workspace_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gizmo" (
	"workspace_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "note" (
	"workspace_id" text NOT NULL,
	"author_id" text REFERENCES "public"."user"("id"),
	"workspace" text
);
--> statement-breakpoint
CREATE TABLE "seat" (
	"workspace_id" text NOT NULL,
	"member_id" text NOT NULL,
	CONSTRAINT "seat_workspace_id_member_id_pk" PRIMARY KEY("workspace_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "contact" (
	"workspace_id" text NOT NULL,
	"author_email" text
);
--> statement-breakpoint
CREATE TABLE "profile" (
	"workspace_id" text NOT NULL,
	"person" text,
	"display_name" text,
	"name" text
);
--> statement-breakpoint
CREATE TABLE "shelf" ("workspace_id" text NOT NULL, "name" text);
--> statement-breakpoint
CREATE INDEX "profile_name_idx" ON "profile" USING btree ("name");`;
    // A later migration that breaks what the first one kept.
    const second = `ALTER TABLE "widget" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "gadget" ALTER COLUMN "workspace_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_workspace_fk" FOREIGN KEY ("workspace") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seat" ADD CONSTRAINT "seat_member_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id");--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "profile" RENAME COLUMN "person" TO "person_name";`;
    expect(
      ruleBreaks(tablesOfMigrations([first, second]), FIXTURE_ACCOUNTS, FIXTURE_NAMES),
    ).toEqual(FIXTURE_BREAKS);
  });

  it('and a migration that undoes a break is read as undone', () => {
    const made = `CREATE TABLE "user" ("id" text PRIMARY KEY NOT NULL);
--> statement-breakpoint
CREATE TABLE "note" ("workspace_id" text, "author_id" text);
--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_author_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id");`;
    const undone = `ALTER TABLE "note" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "note" DROP CONSTRAINT "note_author_fk";`;
    expect(ruleBreaks(tablesOfMigrations([made]), { user: 'a person' }, {})).toEqual([
      'note.workspace_id: may be null',
      'note: has a foreign key into user',
    ]);
    expect(ruleBreaks(tablesOfMigrations([made, undone]), { user: 'a person' }, {})).toEqual([]);
  });

  it('refuses a migration it cannot read rather than guess', () => {
    expect(() =>
      tablesOfMigrations([
        'CREATE TABLE "note" ("workspace_id" text NOT NULL);',
        'TRUNCATE "note"',
      ]),
    ).toThrow(/Cannot read/);
    expect(() =>
      tablesOfMigrations([
        'CREATE TABLE "note" ("workspace_id" text NOT NULL)',
        'ALTER TABLE "note" ADD "email" text',
      ]),
    ).toThrow(/Cannot read/);
  });
});
