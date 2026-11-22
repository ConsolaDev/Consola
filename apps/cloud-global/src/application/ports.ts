import type {
  CELL_TOKEN_ALGORITHM,
  CellTokenClaims,
  OutboxMessage,
  Region,
  WorkspaceRole,
} from '@consola/cloud-contract';
import type { MyWorkspace, NewWorkspace, Workspace, WorkspaceMember } from '../domain/workspace.js';

// What the use cases need from the world outside, each implemented by an adapter.

export type WorkspaceStore = {
  /**
   * Makes the workspace and its first member, together or not at all, each with the outbox
   * message its cell must hear (`workspace.created`, then `member.added`). A slug that any
   * workspace has, in any region, is `slug-taken`, and then nothing is written.
   */
  create(
    workspace: NewWorkspace,
    firstMember: { userId: string; role: WorkspaceRole },
  ): Promise<{ kind: 'created'; workspace: Workspace } | { kind: 'slug-taken' }>;
};

export type MembershipStore = {
  /** The workspace as this person sees it, or null when they are not in it or it is not there. */
  workspaceFor(ids: { workspaceId: string; userId: string }): Promise<MyWorkspace | null>;
  /** Every workspace the person is in, in the order they joined. */
  workspacesOf(userId: string): Promise<MyWorkspace[]>;
  /** Every member of the workspace, with their role, in the order they joined. */
  membersOf(workspaceId: string): Promise<WorkspaceMember[]>;
};

export type SessionStore = {
  /** Makes the workspace the session's active one. */
  setActiveWorkspace(ids: { sessionId: string; workspaceId: string }): Promise<void>;
  /** The active workspace of the person's most recently used session that has one, if any. */
  lastActiveWorkspace(userId: string): Promise<string | null>;
};

export type PeopleStore = {
  /** Whether the person's email is verified, as stored now; null when there is no such person. */
  emailVerified(userId: string): Promise<boolean | null>;
};

export type HealthProbe = {
  /** Whether the database answers a query, never throwing when it does not. */
  databaseAnswers(): Promise<boolean>;
};

/**
 * A public key a cell checks cell tokens with, as the key set publishes it: Ed25519, named by its
 * JWK thumbprint (RFC 7638). It never has a private part (`d`).
 */
export type CellTokenPublicKey = {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
  kid: string;
  alg: typeof CELL_TOKEN_ALGORITHM;
  use: 'sig';
};

/** The public keys a cell checks cell tokens with: a JSON Web Key Set (RFC 7517). */
export type CellTokenKeySet = { keys: CellTokenPublicKey[] };

export type CellTokenSigner = {
  /**
   * The claims, signed as a cell token: a JWT whose header names `CELL_TOKEN_ALGORITHM` and the
   * `kid` of the key that signed it, and whose payload is the claims and nothing else.
   */
  sign(claims: CellTokenClaims): Promise<string>;
  /** The public keys tokens are checked with, the signing key's among them. */
  publicKeys(): CellTokenKeySet;
};

/** Which message of which workspace: the outbox's key. */
export type OutboxMessageKey = { workspaceId: string; sequence: number };

/** A message its cell has not confirmed yet, as the outbox holds it. */
export type UndeliveredMessage = {
  key: OutboxMessageKey;
  /**
   * The message as stored, in the contract's shape. It is read with the contract's reader
   * (`readOutboxMessage`) before it is signed, so a row nothing here wrote is never sent.
   */
  stored: unknown;
  /** How many deliveries of it have failed so far. */
  attempts: number;
  /** When its next delivery is due; null when none has failed, so it is due at once. */
  nextAttemptAt: Date | null;
};

export type OutboxStore = {
  /** Each workspace's first message its cell has not confirmed: the only one it may be sent. */
  firstUndelivered(): Promise<UndeliveredMessage[]>;
  /** The workspace's first message its cell has not confirmed, or null when it has them all. */
  firstUndeliveredOf(workspaceId: string): Promise<UndeliveredMessage | null>;
  /** Records the cell's confirmation, at `at`. */
  recordDelivered(key: OutboxMessageKey, at: Date): Promise<void>;
  /**
   * Records a failed delivery: when it was, why (a status or a reason, never a body, a signature
   * or a key), and when the next one is due.
   */
  recordFailed(
    key: OutboxMessageKey,
    failure: { at: Date; error: string; nextAttemptAt: Date },
  ): Promise<void>;
};

export type OutboxSigner = {
  /**
   * The message, signed for its cell: a JWS in compact serialization whose payload is the
   * message's JSON, signed with the key that signs cell tokens, and whose protected header names
   * `CELL_TOKEN_ALGORITHM`, that key's `kid` and `OUTBOX_MESSAGE_TYPE`.
   */
  signOutboxMessage(message: OutboxMessage): Promise<string>;
};

/** What one delivery came to. */
export type DeliveryAnswer =
  /** The cell answered 2xx: it has the message. */
  | { kind: 'confirmed'; status: number }
  /**
   * Anything else: a refusal, no answer in time, or no connection. `error` says which, in words
   * that hold no body, signature or key.
   */
  | { kind: 'failed'; error: string }
  /** Abandoned, because the worker is stopping: nothing is known of it, and nothing is recorded. */
  | { kind: 'stopped' };

export type CellDelivery = {
  /** Whether the region has a cell to deliver to. */
  reaches(region: Region): boolean;
  /** Sends one signed message to the region's cell; `signal` abandons it. */
  deliver(region: Region, signedMessage: string, signal?: AbortSignal): Promise<DeliveryAnswer>;
};
