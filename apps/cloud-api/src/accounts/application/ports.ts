import type {
  CELL_TOKEN_ALGORITHM,
  CellTokenClaims,
  GitHubEventMessage,
} from '@consola/cloud-contract';
import type { Region } from '../../shared/region.js';
import type { WorkspaceRole } from '../../shared/workspaceRole.js';
import type {
  ConnectedInstallation,
  GitHubInstallation,
  GitHubRepository,
  InstallerFacts,
  InstallState,
} from '../domain/connections.js';
import type { GitHubPermissions, TokenMint } from '../domain/gitHubTokens.js';
import type { MyWorkspace, NewWorkspace, Workspace, WorkspaceMember } from '../domain/workspace.js';
import type { WorkspaceIcon } from '../domain/workspaceIcon.js';

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
  /**
   * Sets the workspace's icon, or clears it (null), and nothing else on the row. No cell holds an
   * icon, so it writes no outbox message.
   */
  setIcon(change: { workspaceId: string; icon: WorkspaceIcon | null }): Promise<void>;
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

/**
 * The installations of Consola's GitHub App that workspaces hold. An installation belongs to one
 * workspace at most: its id is the record's key.
 */
export type InstallationStore = {
  /**
   * Records that the workspace holds the installation, unless another workspace already does
   * (`taken`, and then nothing is written). One the workspace already holds is
   * `already-connected`, and its account is written again, since an organisation can be renamed.
   */
  connect(entry: {
    installation: GitHubInstallation;
    workspaceId: string;
    connectedBy: string;
    at: Date;
  }): Promise<'connected' | 'already-connected' | 'taken'>;
  /** The installations the workspace holds, in the order they were connected. */
  ofWorkspace(workspaceId: string): Promise<ConnectedInstallation[]>;
  /**
   * Removes the record that the workspace holds the installation. False when it holds no such
   * installation, another workspace's included, and then nothing is removed.
   */
  disconnect(ids: { workspaceId: string; installationId: number }): Promise<boolean>;
  /**
   * The workspace that holds the installation, with its region, or null when none does: where a
   * webhook event that came through it is passed on to.
   */
  holderOf(installationId: number): Promise<{ workspaceId: string; region: Region } | null>;
};

/** Signs the `state` of a Connect, and reads one back only when this signer signed it. */
export type InstallStateSigner = {
  sign(state: InstallState): string;
  /** The state, or null when it is not one this signer signed, or not a state at all. */
  read(token: string): InstallState | null;
};

/**
 * Consola's GitHub App, as GitHub answers for it. A call GitHub cannot answer (down, slow, or an
 * answer of a shape it never gives) is `unavailable`, never thrown.
 */
export type GitHubApp = {
  /** The address that installs the app, carrying `state` back to Consola's callback. */
  installUrl(state: string): string;
  /**
   * What GitHub says of the person it sent back with `code`, about installation
   * `installationId` (`InstallerFacts`): whether it is among the installations they can reach,
   * their own account, and their membership of the installation's organisation. GitHub's
   * answer, since the callback's `installation_id` can be forged. The code is used once, and the
   * token it is exchanged for is revoked once read, never kept. A code GitHub refuses (used,
   * expired, made up) is `code-refused`.
   */
  installerFacts(
    code: string,
    installationId: number,
  ): Promise<
    { kind: 'read'; facts: InstallerFacts } | { kind: 'code-refused' } | { kind: 'unavailable' }
  >;
  /**
   * The repositories an installation covers, as GitHub says now. An installation GitHub no
   * longer has (uninstalled, or suspended) is `gone`.
   */
  repositoriesOf(
    installationId: number,
  ): Promise<
    | { kind: 'listed'; repositories: GitHubRepository[] }
    | { kind: 'gone' }
    | { kind: 'unavailable' }
  >;
};

/**
 * The record of every GitHub token minted (14.3), and what a mint must know of the workspace
 * first.
 */
export type TokenMintStore = {
  /**
   * The workspace's region, when the workspace holds the installation. Null when it does not:
   * another workspace's installation, one nobody holds, or a workspace that is not there.
   */
  holding(ids: { workspaceId: string; installationId: number }): Promise<{ region: Region } | null>;
  /** Records a mint. It throws when it cannot, and then the token is never handed out. */
  record(mint: TokenMint): Promise<void>;
  /** The workspace's mints, oldest first. */
  mintsOf(workspaceId: string): Promise<TokenMint[]>;
};

/**
 * Checks what a cell signed, with the public key configured for each region's cell. The key that
 * checks a request says which cell sent it.
 */
export type CellRequestVerifier = {
  /**
   * A cell's request for a GitHub token (`GITHUB_TOKEN_REQUEST_TYPE`): its payload, not yet read,
   * and the region of the cell whose key signed it. `unsigned` when no cell's key checks it: not
   * a compact JWS, another algorithm or `typ`, no `kid`, a key no cell has, or a signature that
   * does not check.
   */
  verifyTokenRequest(
    signed: string,
  ): Promise<{ kind: 'signed'; region: Region; payload: unknown } | { kind: 'unsigned' }>;
};

/** What GitHub answered a mint. */
export type MintAnswer =
  /**
   * GitHub minted a token: it, when it expires, and the repositories and permissions GitHub says
   * it carries, which are checked against what was asked before it is handed out.
   */
  | {
      kind: 'minted';
      token: string;
      expiresAt: Date;
      repositories: Array<{ id: number; fullName: string }>;
      permissions: Record<string, string>;
    }
  /** GitHub no longer has the installation: uninstalled, or suspended. */
  | { kind: 'gone' }
  /**
   * GitHub refused the scope: a repository the installation does not cover, or a permission the
   * app or the installation was not granted.
   */
  | { kind: 'refused' }
  | { kind: 'unavailable' };

/** Mints installation tokens from Consola's GitHub App, each narrowed to what it is asked for. */
export type GitHubTokenMinter = {
  /**
   * A new installation token for exactly these repositories and permissions: never kept, never
   * reused, and never logged.
   */
  mintToken(
    installationId: number,
    scope: { repositoryIds: number[]; permissions: GitHubPermissions },
  ): Promise<MintAnswer>;
  /** Revokes a token that is not handed out after all. It never throws; GitHub's own expiry follows. */
  revokeToken(token: string): Promise<void>;
};

// GitHub's webhooks (14.2): checked here, then passed on to the workspace's cell, which keeps
// them. Nothing of an event is stored here.

/** Tells GitHub's webhook deliveries from anyone else's, by their signature. */
export type WebhookSignatures = {
  /**
   * Whether `signature` (`X-Hub-Signature-256`, `sha256=` and 64 hex digits) is the HMAC-SHA256
   * of `body`, exactly as it arrived, under the app's webhook secret, compared in constant time.
   * False for a signature that is missing or not of that shape. It never throws.
   */
  verify(body: Uint8Array, signature: string | undefined): boolean;
};

export type GitHubEventSigner = {
  /**
   * The event, signed for its workspace's cell: a JWS in compact serialization whose payload is
   * the event's JSON, signed with the key that signs cell tokens, and whose protected header
   * names `CELL_TOKEN_ALGORITHM`, that key's `kid` and `GITHUB_EVENT_TYPE`.
   */
  signGitHubEvent(event: GitHubEventMessage): Promise<string>;
};

/** What passing one event on to a cell came to. */
export type CellEventAnswer =
  /** The cell recorded it now. */
  | { kind: 'recorded' }
  /** The cell had recorded a delivery with its id for the workspace already: nothing changed. */
  | { kind: 'recorded-before' }
  /**
   * Anything else: a refusal, no answer in time, or no connection. `error` says which, in words
   * that hold no body, signature or key.
   */
  | { kind: 'failed'; error: string };

/** The cells GitHub's events are passed on to, one a region. */
export type CellEvents = {
  /** Whether the region has a cell to pass events on to. */
  reaches(region: Region): boolean;
  /** Passes one signed event on to the region's cell, and says what it answered. */
  pass(region: Region, signedEvent: string): Promise<CellEventAnswer>;
};
