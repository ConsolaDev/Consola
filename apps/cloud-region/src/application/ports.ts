// What the use cases need from the world outside, each implemented by an adapter.

import type { GitHubEventMessage, WorkspaceRole } from '@consola/cloud-contract';
import type { Team } from '../domain/team.js';
import type { CopyChange } from '../domain/workspaceCopy.js';

export type HealthProbe = {
  /** Whether the database answers a query, never throwing when it does not. */
  databaseAnswers(): Promise<boolean>;
};

/** What checking a token's signature found. */
export type SignatureCheck =
  /** Signed by one of `cloud-global`'s keys, for a cell, and in date: its claims, still unread. */
  | { kind: 'verified'; payload: unknown }
  /** Not a token `cloud-global` signed for a cell, or no longer in date. */
  | { kind: 'invalid' }
  /** `cloud-global`'s keys could not be had, so no token can be checked. */
  | { kind: 'keys-unavailable' };

export type TokenVerifier = {
  /**
   * Checks a cell token at `nowSeconds` (whole seconds since the epoch): its signature with
   * `cloud-global`'s public keys, allowing `CELL_TOKEN_ALGORITHM` alone, and its audience and
   * times as the contract has them. It never throws, and never lets a token through when the keys
   * cannot be had.
   */
  verify(token: string, nowSeconds: number): Promise<SignatureCheck>;
};

export type Clock = {
  /** The time now, in whole seconds since the epoch. */
  nowSeconds(): number;
};

/** What checking the signature of a delivery from `cloud-global` (a message, an event) found. */
export type DeliveryCheck =
  /** Signed by one of `cloud-global`'s keys, with the verifier's `typ`: its payload, unread. */
  | { kind: 'verified'; payload: Uint8Array }
  /** Not a delivery `cloud-global` signed. `reason` says why, for the log, never the body. */
  | { kind: 'unsigned'; reason: string }
  /** `cloud-global`'s keys could not be had, so no delivery can be checked. */
  | { kind: 'keys-unavailable' };

export type DeliveryVerifier = {
  /**
   * Checks a delivery's body, a compact JWS, with `cloud-global`'s public keys: the key its
   * header names by `kid`, `CELL_TOKEN_ALGORITHM` alone, and the one `typ` the verifier takes
   * (`OUTBOX_MESSAGE_TYPE` for the outbox, `GITHUB_EVENT_TYPE` for GitHub's events). It never
   * throws, and never lets a delivery through when the keys cannot be had.
   */
  verify(delivery: string): Promise<DeliveryCheck>;
};

/** One message, ready to apply to its workspace's copy. */
export type CopyStep = {
  workspaceId: string;
  /** The message's sequence, which becomes the copy's last applied. */
  sequence: number;
  /** The copy's last applied sequence the step was decided against: null when it held nothing. */
  after: number | null;
  change: CopyChange;
};

/** The cell's copy of each workspace and its members, kept from `cloud-global`'s outbox. */
export type WorkspaceCopies = {
  /**
   * The sequence of the last message applied to the workspace's copy, or null when the cell
   * holds nothing of it. Throws when the database does not answer.
   */
  lastApplied(workspaceId: string): Promise<number | null>;
  /**
   * In one transaction, makes the step's change and moves the copy's last applied sequence from
   * `after` to `sequence`, but only if it still is `after` (null: the copy holds nothing of the
   * workspace yet). When it is not, another delivery applied a message first, and the answer is
   * `moved`, with nothing changed. Throws when the database does not answer.
   */
  applyAfter(step: CopyStep): Promise<'applied' | 'moved'>;
};

/** The GitHub events `cloud-global` passed on, each kept for its workspace. */
export type GitHubEventStore = {
  /**
   * Records the event for its workspace, unless the cell already has one with its delivery id
   * there (`recorded-before`, and nothing changes) or holds nothing of the workspace yet
   * (`workspace-pending`, its `workspace.created` not applied). Throws when the database does
   * not answer.
   */
  record(event: GitHubEventMessage): Promise<'recorded' | 'recorded-before' | 'workspace-pending'>;
};

/**
 * A workspace's teams. Every call is scoped by the workspace's id, and a team of another
 * workspace is one the store does not have (`not-found`). Every call throws when the database
 * does not answer.
 */
export type TeamStore = {
  /** Whether the cell holds the workspace's copy yet: whether its `workspace.created` is applied. */
  holdsWorkspace(workspaceId: string): Promise<boolean>;
  /** The person's role in the workspace as the cell's copy holds it, or null when not a member. */
  roleInCopy(workspaceId: string, personId: string): Promise<WorkspaceRole | null>;
  /** The workspace's teams: its first team first, then the others by name, whatever their case. */
  list(workspaceId: string): Promise<Team[]>;
  /** Makes a team with no members. `name-taken` when another team has the name, in any case. */
  create(workspaceId: string, name: string): Promise<Team | 'name-taken'>;
  rename(
    workspaceId: string,
    teamId: string,
    name: string,
  ): Promise<Team | 'not-found' | 'name-taken'>;
  /** Deletes a team and every place in it, unless it is the first team, which stays. */
  remove(workspaceId: string, teamId: string): Promise<'removed' | 'not-found' | 'first-team'>;
  /**
   * Makes the person a member of the team, if they are a member of the workspace in the cell's
   * copy (`not-a-member` when not). A person already in it stays as they are.
   */
  addMember(
    workspaceId: string,
    teamId: string,
    personId: string,
  ): Promise<Team | 'not-found' | 'not-a-member'>;
  /** Takes the person out of the team. Someone not in it changes nothing. */
  removeMember(workspaceId: string, teamId: string, personId: string): Promise<Team | 'not-found'>;
};
