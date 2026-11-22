// What the use cases need from the world outside, each implemented by an adapter.

import type { Harness, PassClaims, Repository } from '@consola/runner-protocol';
import type { CloudSession, CloudSessionStatus, RunnerIdentity } from '../domain/cloudSession.js';
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

/** What checking an outbox delivery's signature found. */
export type DeliveryCheck =
  /** Signed by one of `cloud-global`'s keys, as an outbox message: its payload, still unread. */
  | { kind: 'verified'; payload: Uint8Array }
  /** Not a delivery `cloud-global` signed. `reason` says why, for the log, never the body. */
  | { kind: 'unsigned'; reason: string }
  /** `cloud-global`'s keys could not be had, so no delivery can be checked. */
  | { kind: 'keys-unavailable' };

export type DeliveryVerifier = {
  /**
   * Checks a delivery's body, a compact JWS, with `cloud-global`'s public keys: the key its
   * header names by `kid`, `CELL_TOKEN_ALGORITHM` alone, and `typ` `OUTBOX_MESSAGE_TYPE`. It
   * never throws, and never lets a delivery through when the keys cannot be had.
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

export type { RunnerIdentity };

/** What a connected runner offers a workspace: where it can start a session, and with what. */
export type Offer = {
  runnerId: string;
  repositories: Repository[];
  harnesses: Harness[];
};

/** What the cell asks a runner to start, in the cell's terms (the socket adds the pass key). */
export type SessionStartRequest = {
  sessionId: string;
  workspaceId: string;
  repository: Repository;
  harness: Harness;
};

/** The runner that serves a workspace, as the use cases see it. */
export type RunnerChannel = {
  /** What the workspace's connected runner offers, or null when none is connected. */
  connected(workspaceId: string): Offer | null;
  /** Hands a start to the runner. Rejects when it cannot be delivered. */
  startSession(runnerId: string, request: SessionStartRequest): Promise<void>;
  /** Hands a stop to the runner. Rejects when it cannot be delivered. */
  stopSession(runnerId: string, sessionId: string): Promise<void>;
};

/** What a use case may change on a row; a key left out stays. */
export type CloudSessionChanges = Partial<
  Pick<CloudSession, 'status' | 'title' | 'hostUrl' | 'error' | 'errorCode' | 'endedAt'>
>;

/** The cell's record of its cloud sessions. Every method throws when the database does not answer. */
export type CloudSessionStore = {
  insert(session: CloudSession): Promise<void>;
  /** One session by id, whoever's. For the runner's updates, never for a person's request. */
  find(sessionId: string): Promise<CloudSession | null>;
  /** The session if it is `personId`'s own in `workspaceId`, else null. */
  findOwn(workspaceId: string, personId: string, sessionId: string): Promise<CloudSession | null>;
  /** The person's sessions in the workspace, newest first. */
  listOwn(workspaceId: string, personId: string): Promise<CloudSession[]>;
  /** The runner's sessions in its workspace that have not ended: `starting` or `running`. */
  listLive(runner: RunnerIdentity): Promise<CloudSession[]>;
  /**
   * Applies `changes` only if the row still has the status `expected`: a compare-and-set, so a
   * late update never overwrites an end. True when it applied.
   */
  update(
    sessionId: string,
    expected: CloudSessionStatus,
    changes: CloudSessionChanges,
  ): Promise<boolean>;
};

export type Ids = {
  /** A new unguessable id. */
  newId(): string;
};

/**
 * Signs session passes with the cell's own key (`PASS_PRIVATE_KEY`), whose public half each
 * session's host is handed in `session.start`.
 */
export type PassSigner = {
  /** The pass for `claims`: a compact JWS, EdDSA, with `typ` `PASS_TYPE`. */
  sign(claims: PassClaims): Promise<string>;
};

/** Everything the cloud session use cases need. */
export type CloudSessionPorts = {
  sessions: CloudSessionStore;
  runners: RunnerChannel;
  ids: Ids;
  clock: Clock;
  /** Null when the cell has no pass key: then it has no runner either, and issues no pass. */
  passes: PassSigner | null;
};

/** What a runner's messages need: the sessions, and the time. */
export type RunnerUpdatePorts = Pick<CloudSessionPorts, 'sessions' | 'clock'>;
