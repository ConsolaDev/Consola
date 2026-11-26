import { is } from 'drizzle-orm';
import { getTableConfig, integer, PgTable, pgTable, text } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { schema } from './schema.js';

/**
 * Keeps two rules every table of the cell follows. Every table carries a not-null `workspace_id`,
 * the workspace's id in `cloud-global`, so no row is ever without the workspace it belongs to.
 * And the cell holds no accounts: people live in `cloud-global`, and a cell table refers to a
 * person by their global id, so no table here is named after an account table.
 */

/** Better Auth's tables in `cloud-global`, which never have a copy in a cell. */
const ACCOUNT_TABLES = new Set([
  'user',
  'session',
  'account',
  'verification',
  'member',
  'invitation',
]);

/** Every way the tables in `exports` break the rules, as `<table> …`. */
function violationsOf(exports: Record<string, unknown>): string[] {
  return Object.values(exports)
    .filter((value): value is PgTable => is(value, PgTable))
    .flatMap((table) => {
      const { name, columns } = getTableConfig(table);
      const problems: string[] = [];
      if (ACCOUNT_TABLES.has(name)) problems.push(`${name} is an account table`);
      const workspace = columns.find((column) => column.name === 'workspace_id');
      if (!workspace) problems.push(`${name} has no workspace_id`);
      else if (!workspace.notNull) problems.push(`${name} has a nullable workspace_id`);
      return problems;
    });
}

describe('the schema', () => {
  it('every table keeps the rules', () => {
    expect(violationsOf(schema)).toEqual([]);
  });

  it('the checker reports a table without workspace_id', () => {
    const runs = pgTable('run', { id: text('id').primaryKey() });
    expect(violationsOf({ runs })).toEqual(['run has no workspace_id']);
  });

  it('the checker reports a nullable workspace_id', () => {
    const runs = pgTable('run', { id: text('id').primaryKey(), workspaceId: text('workspace_id') });
    expect(violationsOf({ runs })).toEqual(['run has a nullable workspace_id']);
  });

  it('the checker reports an account table', () => {
    const people = pgTable('user', { workspaceId: text('workspace_id').notNull() });
    expect(violationsOf({ people })).toEqual(['user is an account table']);
  });

  it('the checker passes a table that keeps the rules, and ignores what is not a table', () => {
    const runs = pgTable('run', {
      id: text('id').primaryKey(),
      workspaceId: text('workspace_id').notNull(),
      startedBy: text('started_by_person_id').notNull(),
      attempt: integer('attempt').notNull(),
    });
    expect(violationsOf({ runs, RUN_STATES: ['queued', 'running'] })).toEqual([]);
  });
});
