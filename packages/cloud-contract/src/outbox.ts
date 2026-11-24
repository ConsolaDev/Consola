import { fieldProblem, isId, isRecord, isWholeNumber, read, refused } from './read.js';
import type { ReadResult } from './read.js';
import { isRegion } from './region.js';
import type { Region } from './region.js';
import { isWorkspaceRole } from './workspaceRole.js';
import type { WorkspaceRole } from './workspaceRole.js';

/**
 * The changes `cloud-global` tells a workspace's cell about, through its outbox: each message is
 * written in the same transaction as its change, and delivered until the cell confirms it. They
 * hold ids and roles only, never anything else about a person, since a cell holds no accounts.
 */
export const WORKSPACE_CHANGE_TYPES = [
  'workspace.created',
  'member.added',
  'member.role-changed',
  'member.removed',
] as const;

export type WorkspaceChangeType = (typeof WORKSPACE_CHANGE_TYPES)[number];

export type WorkspaceChange =
  /** The workspace was made, in the message's region. It is always the workspace's first. */
  | { type: 'workspace.created' }
  /** A person joined the workspace, with a role. */
  | { type: 'member.added'; personId: string; role: WorkspaceRole }
  /** A member's role is now `role`. */
  | { type: 'member.role-changed'; personId: string; role: WorkspaceRole }
  /** A person is no longer a member. */
  | { type: 'member.removed'; personId: string };

/** The sequence of a workspace's first message, which is its `workspace.created`. */
export const FIRST_SEQUENCE = 1;

/** One message from `cloud-global`'s outbox, about one workspace. */
export type OutboxMessage = {
  /** The workspace's id in `cloud-global`. */
  workspaceId: string;
  /** The workspace's region. A cell refuses a message about a workspace in another region. */
  region: Region;
  /**
   * The message's place among its workspace's messages: `FIRST_SEQUENCE` for the first, and one
   * more for each after it, in the order their changes committed. A cell applies a workspace's
   * messages in that order, so one it has already applied changes nothing.
   */
  sequence: number;
  change: WorkspaceChange;
};

const ENVELOPE = ['workspaceId', 'region', 'sequence', 'change'] as const;

const CHANGE_FIELDS: Record<WorkspaceChangeType, readonly string[]> = {
  'workspace.created': ['type'],
  'member.added': ['type', 'personId', 'role'],
  'member.role-changed': ['type', 'personId', 'role'],
  'member.removed': ['type', 'personId'],
};

export function isWorkspaceChangeType(value: unknown): value is WorkspaceChangeType {
  return typeof value === 'string' && (WORKSPACE_CHANGE_TYPES as readonly string[]).includes(value);
}

/**
 * Reads a message as it arrives at a cell, once its signature has been checked (JSON, parsed).
 * It refuses any other shape: a field missing, or one the contract does not name, a change type
 * it does not know, a sequence that is not a whole number from `FIRST_SEQUENCE`, and a workspace
 * whose first message is anything but its `workspace.created`. Whether the region is the cell's
 * own, and whether the sequence is the next one, are the cell's to check.
 */
export function readOutboxMessage(value: unknown): ReadResult<OutboxMessage> {
  if (!isRecord(value)) return refused('the message is not an object');
  const fields = fieldProblem(value, ENVELOPE, 'the message');
  if (fields !== null) return refused(fields);

  const { workspaceId, region, sequence } = value;
  if (!isId(workspaceId)) return refused("`workspaceId` is not a workspace's id");
  if (!isRegion(region)) return refused('`region` is not a region');
  if (!isWholeNumber(sequence) || sequence < FIRST_SEQUENCE) {
    return refused(`\`sequence\` is not a whole number from ${FIRST_SEQUENCE}`);
  }
  const change = readChange(value.change);
  if (!change.ok) return change;

  const created = change.value.type === 'workspace.created';
  if (created && sequence !== FIRST_SEQUENCE) {
    return refused("`workspace.created` is not the workspace's first message");
  }
  if (!created && sequence === FIRST_SEQUENCE) {
    return refused("a workspace's first message is not its `workspace.created`");
  }
  return read({ workspaceId, region, sequence, change: change.value });
}

function readChange(value: unknown): ReadResult<WorkspaceChange> {
  if (!isRecord(value)) return refused('`change` is not an object');
  const { type } = value;
  if (!isWorkspaceChangeType(type))
    return refused('`change.type` is not a change the contract names');
  const fields = fieldProblem(value, CHANGE_FIELDS[type], `the \`${type}\` change`);
  if (fields !== null) return refused(fields);
  if (type === 'workspace.created') return read({ type });

  const { personId } = value;
  if (!isId(personId)) return refused("`change.personId` is not a person's id");
  if (type === 'member.removed') return read({ type, personId });

  const { role } = value;
  if (!isWorkspaceRole(role)) return refused('`change.role` is not a workspace role');
  return read({ type, personId, role });
}
