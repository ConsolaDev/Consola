import { randomUUID } from 'node:crypto';
import { FIRST_SEQUENCE } from '@consola/cloud-contract';
import type { OutboxMessage, WorkspaceChange } from '@consola/cloud-contract';
import { and, eq, max, ne } from 'drizzle-orm';
import type { NewWorkspace } from '../../domain/workspace.js';
import type { Transaction } from './database.js';
import { regionOf } from './regionOf.js';
import { schema } from './schema.js';

/** A change to the members of a workspace that exists. */
export type MemberChange = Exclude<WorkspaceChange, { type: 'workspace.created' }>;

/**
 * A change to write: a new workspace, with what its row needs and no message carries (its name
 * and slug), or a change to the members of one that exists, by its id.
 */
export type WorkspaceChangeToWrite =
  | { change: { type: 'workspace.created' }; workspace: NewWorkspace & { id: string } }
  | { change: MemberChange; workspaceId: string };

/**
 * Writes a change to a workspace and its outbox message, in the caller's transaction, so the two
 * commit together or not at all. It is the one way anything here changes what a workspace's cell
 * must hear about: making a workspace (its `organization` row), and adding a member, changing a
 * member's role or removing one (its `member` rows).
 *
 * The message's `sequence` is one more than the workspace's last, so each workspace's messages
 * count from `FIRST_SEQUENCE` with no gaps, in the order their transactions commit: a change to a
 * workspace that exists holds that workspace's row (`for no key update`) until its transaction
 * ends, so a second change to the same workspace waits for the first to commit or roll back and
 * then counts from it. The lock comes before the change writes anything, so changes to one
 * workspace queue rather than deadlock, and it does not block the key-share locks other tables'
 * foreign keys take on the row. The primary key on (workspace, sequence) backs this: two messages
 * can never share a place.
 *
 * Its answer is the message written, or null when the change would change nothing, and then
 * nothing is written: a slug any workspace has, a workspace that is not there, a person already
 * a member, not a member, or already in the role.
 */
export async function writeWorkspaceChange(
  tx: Transaction,
  toWrite: WorkspaceChangeToWrite,
): Promise<OutboxMessage | null> {
  const now = new Date();

  if ('workspace' in toWrite) {
    const { id, name, slug, region } = toWrite.workspace;
    // A row this transaction makes is seen by no other until it commits, so it needs no lock.
    const [row] = await tx
      .insert(schema.organization)
      .values({ id, name, slug, region, createdAt: now })
      .onConflictDoNothing({ target: schema.organization.slug })
      .returning({
        id: schema.organization.id,
        slug: schema.organization.slug,
        region: schema.organization.region,
      });
    if (!row) return null;
    return append(tx, now, {
      workspaceId: row.id,
      region: regionOf(row),
      sequence: FIRST_SEQUENCE,
      change: { type: 'workspace.created' },
    });
  }

  const { workspaceId, change } = toWrite;
  const [workspace] = await tx
    .select({ slug: schema.organization.slug, region: schema.organization.region })
    .from(schema.organization)
    .where(eq(schema.organization.id, workspaceId))
    .for('no key update');
  if (!workspace) return null;

  if (!(await changeMembers(tx, now, workspaceId, change))) return null;

  const [last] = await tx
    .select({ sequence: max(schema.outboxMessage.sequence) })
    .from(schema.outboxMessage)
    .where(eq(schema.outboxMessage.organizationId, workspaceId));
  const sequence = Number(last?.sequence ?? 0) + 1;
  if (sequence === FIRST_SEQUENCE) {
    // Its cell would refuse a member before the workspace, so this is refused here first.
    throw new Error(`The workspace ${workspace.slug} has no \`workspace.created\` message.`);
  }
  return append(tx, now, { workspaceId, region: regionOf(workspace), sequence, change });
}

/** Makes the change to the workspace's `member` rows: whether it changed any. */
async function changeMembers(
  tx: Transaction,
  now: Date,
  workspaceId: string,
  change: MemberChange,
): Promise<boolean> {
  const theirs = and(
    eq(schema.member.organizationId, workspaceId),
    eq(schema.member.userId, change.personId),
  );
  switch (change.type) {
    case 'member.added': {
      // Nothing in the table stops a second row for one person, so this does.
      const [already] = await tx
        .select({ id: schema.member.id })
        .from(schema.member)
        .where(theirs)
        .limit(1);
      if (already) return false;
      await tx.insert(schema.member).values({
        id: randomUUID(),
        organizationId: workspaceId,
        userId: change.personId,
        role: change.role,
        createdAt: now,
      });
      return true;
    }
    case 'member.role-changed': {
      const changed = await tx
        .update(schema.member)
        .set({ role: change.role })
        .where(and(theirs, ne(schema.member.role, change.role)))
        .returning({ id: schema.member.id });
      return changed.length > 0;
    }
    case 'member.removed': {
      const removed = await tx
        .delete(schema.member)
        .where(theirs)
        .returning({ id: schema.member.id });
      return removed.length > 0;
    }
  }
}

/** Writes the message to the outbox, due at once, and answers it as written. */
async function append(tx: Transaction, now: Date, message: OutboxMessage): Promise<OutboxMessage> {
  const { change } = message;
  await tx.insert(schema.outboxMessage).values({
    organizationId: message.workspaceId,
    sequence: message.sequence,
    region: message.region,
    changeType: change.type,
    personId: change.type === 'workspace.created' ? null : change.personId,
    role:
      change.type === 'member.added' || change.type === 'member.role-changed' ? change.role : null,
    createdAt: now,
  });
  return message;
}
