import { FIRST_SEQUENCE, type WorkspaceChange, type WorkspaceRole } from '@consola/cloud-contract';

/**
 * The cell's copy of a workspace: that it exists, who its members are and their roles, kept from
 * `cloud-global`'s outbox messages. Ids and roles only, since the cell holds no accounts.
 *
 * A workspace's messages are applied in sequence order, each once. The copy remembers the
 * sequence of the last message it applied, and that is all the rule below needs.
 */

/** Where a message stands against what the copy has applied. */
export type Placement =
  /** It is the workspace's next message: apply it. */
  | { kind: 'next' }
  /** The copy has applied it already: it changes nothing. */
  | { kind: 'applied-before' }
  /** Messages before it are missing. `nextSequence` is the one the copy applies next. */
  | { kind: 'ahead'; nextSequence: number };

/**
 * The sequence of the message the copy applies next: `FIRST_SEQUENCE` while it holds nothing of
 * the workspace (`lastApplied` null), and otherwise one more than the last it applied.
 */
export function nextSequenceAfter(lastApplied: number | null): number {
  return lastApplied === null ? FIRST_SEQUENCE : lastApplied + 1;
}

/**
 * Where a message with `sequence` stands, when the last one the copy applied for its workspace is
 * `lastApplied` (null when the copy holds nothing of it). A message at or below `lastApplied` has
 * been applied, so applying it again would repeat a change: it changes nothing. One further ahead
 * than the next waits for the ones before it.
 */
export function placeMessage(sequence: number, lastApplied: number | null): Placement {
  const nextSequence = nextSequenceAfter(lastApplied);
  if (sequence < nextSequence) return { kind: 'applied-before' };
  if (sequence === nextSequence) return { kind: 'next' };
  return { kind: 'ahead', nextSequence };
}

/**
 * What applying a change does to the copy. Each is a state to reach, not a step to take, so a
 * copy that differs from `cloud-global`'s records (a member already there, or missing) ends up
 * where `cloud-global` is rather than refusing the message, which `cloud-global` would send
 * again and again while its workspace's later messages wait.
 *
 * Each also keeps the workspace's teams true to it (`team.ts`), in the same transaction.
 */
export type CopyChange =
  /** The copy starts holding the workspace, with no members, and with its first team. */
  | { kind: 'open-workspace' }
  /**
   * The person is a member with `role`: added if they are not one, their role set if they are.
   * A person added joins the workspace's first team; one already a member keeps their teams.
   */
  | { kind: 'put-member'; personId: string; role: WorkspaceRole }
  /**
   * The person is not a member: removed if they are one, leaving every team of the workspace,
   * and nothing changes if not.
   */
  | { kind: 'drop-member'; personId: string };

/**
 * What a change from `cloud-global` does to the copy:
 * - `workspace.created` opens the workspace;
 * - `member.added` and `member.role-changed` both put the member with the message's role, so an
 *   added member who is there already takes the message's role, and a role change for someone
 *   who is not there adds them;
 * - `member.removed` drops the member, which for someone not there changes nothing.
 */
export function copyChangeOf(change: WorkspaceChange): CopyChange {
  switch (change.type) {
    case 'workspace.created':
      return { kind: 'open-workspace' };
    case 'member.added':
    case 'member.role-changed':
      return { kind: 'put-member', personId: change.personId, role: change.role };
    case 'member.removed':
      return { kind: 'drop-member', personId: change.personId };
  }
}
