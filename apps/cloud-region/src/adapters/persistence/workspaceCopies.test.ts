import type { WorkspaceRole } from '@consola/cloud-contract';
import { asc } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CopyStep } from '../../application/ports.js';
import { type Database, migrateDatabase, openDatabase } from './database.js';
import { workspaceMembers, workspaces } from './tables.js';
import { createWorkspaceCopies } from './workspaceCopies.js';

let db: Database;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = openDatabase('pglite:memory'));
  await migrateDatabase(db);
});

afterEach(async () => {
  await close();
});

/** Every row of both tables, in a fixed order. */
async function tables() {
  return {
    workspaces: await db.select().from(workspaces).orderBy(asc(workspaces.workspaceId)),
    members: await db
      .select()
      .from(workspaceMembers)
      .orderBy(asc(workspaceMembers.workspaceId), asc(workspaceMembers.personId)),
  };
}

const open = (workspaceId: string): CopyStep => ({
  workspaceId,
  sequence: 1,
  after: null,
  change: { kind: 'open-workspace' },
});

const put = (
  workspaceId: string,
  sequence: number,
  personId: string,
  role: WorkspaceRole,
): CopyStep => ({
  workspaceId,
  sequence,
  after: sequence - 1,
  change: { kind: 'put-member', personId, role },
});

const drop = (workspaceId: string, sequence: number, personId: string): CopyStep => ({
  workspaceId,
  sequence,
  after: sequence - 1,
  change: { kind: 'drop-member', personId },
});

describe('the workspace copies', () => {
  it('hold nothing of a workspace no message has opened', async () => {
    const copies = createWorkspaceCopies(db);
    expect(await copies.lastApplied('acme')).toBeNull();
  });

  it("open a workspace with its first message, and remember that message's sequence", async () => {
    const copies = createWorkspaceCopies(db);
    expect(await copies.applyAfter(open('acme'))).toBe('applied');
    expect(await copies.lastApplied('acme')).toBe(1);
    expect(await tables()).toEqual({
      workspaces: [{ workspaceId: 'acme', lastAppliedSequence: 1 }],
      members: [],
    });
  });

  it('put a member, then set their role, then drop them, moving the sequence each time', async () => {
    const copies = createWorkspaceCopies(db);
    await copies.applyAfter(open('acme'));
    expect(await copies.applyAfter(put('acme', 2, 'person-dana', 'owner'))).toBe('applied');
    expect(await copies.applyAfter(put('acme', 3, 'person-eli', 'member'))).toBe('applied');
    expect(await copies.applyAfter(put('acme', 4, 'person-eli', 'admin'))).toBe('applied');
    expect((await tables()).members).toEqual([
      { workspaceId: 'acme', personId: 'person-dana', role: 'owner' },
      { workspaceId: 'acme', personId: 'person-eli', role: 'admin' },
    ]);

    expect(await copies.applyAfter(drop('acme', 5, 'person-eli'))).toBe('applied');
    expect(await tables()).toEqual({
      workspaces: [{ workspaceId: 'acme', lastAppliedSequence: 5 }],
      members: [{ workspaceId: 'acme', personId: 'person-dana', role: 'owner' }],
    });
  });

  it('drop someone who is not a member by changing nothing but the sequence', async () => {
    const copies = createWorkspaceCopies(db);
    await copies.applyAfter(open('acme'));
    await copies.applyAfter(put('acme', 2, 'person-dana', 'owner'));
    expect(await copies.applyAfter(drop('acme', 3, 'person-eli'))).toBe('applied');
    expect(await tables()).toEqual({
      workspaces: [{ workspaceId: 'acme', lastAppliedSequence: 3 }],
      members: [{ workspaceId: 'acme', personId: 'person-dana', role: 'owner' }],
    });
  });

  it('change nothing when the sequence has moved from the one the step was decided against', async () => {
    const copies = createWorkspaceCopies(db);
    await copies.applyAfter(open('acme'));
    await copies.applyAfter(put('acme', 2, 'person-dana', 'owner'));
    const before = await tables();

    // Another delivery opened it, or applied #2, first.
    expect(await copies.applyAfter(open('acme'))).toBe('moved');
    expect(await copies.applyAfter(put('acme', 2, 'person-eli', 'admin'))).toBe('moved');
    // Decided against a sequence the copy never had.
    expect(await copies.applyAfter({ ...put('acme', 9, 'person-eli', 'admin'), after: 7 })).toBe(
      'moved',
    );
    expect(await tables()).toEqual(before);
  });

  it('change nothing for a workspace no message has opened, but its opening', async () => {
    const copies = createWorkspaceCopies(db);
    expect(await copies.applyAfter(put('acme', 2, 'person-dana', 'owner'))).toBe('moved');
    expect(await tables()).toEqual({ workspaces: [], members: [] });
  });

  it('make the change and move the sequence in one transaction: neither without the other', async () => {
    const copies = createWorkspaceCopies(db);
    await copies.applyAfter(open('acme'));
    // A change the database refuses, after the sequence has moved inside the transaction.
    const broken = put('acme', 2, 'person-dana', null as unknown as WorkspaceRole);
    await expect(copies.applyAfter(broken)).rejects.toThrow();
    expect(await copies.lastApplied('acme')).toBe(1);
    expect((await tables()).members).toEqual([]);
  });

  it('apply one of two steps decided at once against the same sequence', async () => {
    const copies = createWorkspaceCopies(db);
    await copies.applyAfter(open('acme'));
    const answers = await Promise.all([
      copies.applyAfter(put('acme', 2, 'person-dana', 'owner')),
      copies.applyAfter(put('acme', 2, 'person-eli', 'member')),
      copies.applyAfter(open('sprocket')),
      copies.applyAfter(open('sprocket')),
    ]);
    expect(answers.filter((answer) => answer === 'applied')).toHaveLength(2);
    const after = await tables();
    expect(after.workspaces).toEqual([
      { workspaceId: 'acme', lastAppliedSequence: 2 },
      { workspaceId: 'sprocket', lastAppliedSequence: 1 },
    ]);
    expect(after.members).toHaveLength(1);
  });

  it("keep each workspace's members apart", async () => {
    const copies = createWorkspaceCopies(db);
    await copies.applyAfter(open('acme'));
    await copies.applyAfter(open('sprocket'));
    await copies.applyAfter(put('acme', 2, 'person-dana', 'owner'));
    await copies.applyAfter(put('sprocket', 2, 'person-dana', 'member'));
    await copies.applyAfter(drop('sprocket', 3, 'person-dana'));
    expect(await tables()).toEqual({
      workspaces: [
        { workspaceId: 'acme', lastAppliedSequence: 2 },
        { workspaceId: 'sprocket', lastAppliedSequence: 3 },
      ],
      members: [{ workspaceId: 'acme', personId: 'person-dana', role: 'owner' }],
    });
  });

  it('keep sequences past the range of a 32-bit integer', async () => {
    const copies = createWorkspaceCopies(db);
    await copies.applyAfter(open('acme'));
    await db.update(workspaces).set({ lastAppliedSequence: 2 ** 40 });
    expect(await copies.applyAfter(put('acme', 2 ** 40 + 1, 'person-dana', 'owner'))).toBe(
      'applied',
    );
    expect(await copies.lastApplied('acme')).toBe(2 ** 40 + 1);
  });
});

describe('the copy', () => {
  it('holds ids and roles only: no email, no name, nothing else of an account', () => {
    const columns = (table: typeof workspaces | typeof workspaceMembers) =>
      getTableConfig(table).columns.map((column) => column.name);
    expect(columns(workspaces)).toEqual(['workspace_id', 'last_applied_sequence']);
    expect(columns(workspaceMembers)).toEqual(['workspace_id', 'person_id', 'role']);
  });
});
