import type { CELL_TOKEN_ALGORITHM, CellTokenClaims, WorkspaceRole } from '@consola/cloud-contract';
import type { MyWorkspace, NewWorkspace, Workspace } from '../domain/workspace.js';

// What the use cases need from the world outside, each implemented by an adapter.

export type WorkspaceStore = {
  /**
   * Makes the workspace and its first member, together or not at all. A slug that any workspace
   * has, in any region, is `slug-taken`, and then nothing is written.
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
