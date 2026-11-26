// What GitHub's use cases need from the world outside, each implemented by an adapter: the
// GitHub App (`adapters/github`), and the installations, mints and events a workspace holds
// (`adapters/persistence`, `gitHubStores.ts`).

import type {
  ConnectedInstallation,
  GitHubInstallation,
  GitHubRepository,
  InstallerFacts,
  InstallState,
} from '../domain/connections.js';
import type { GitHubPermissions, TokenMint } from '../domain/gitHubTokens.js';
import type { GitHubEvent } from '../domain/webhooks.js';

/**
 * The installations of Consola's GitHub App that workspaces hold. An installation belongs to one
 * workspace at most: its id is the record's key. Every call throws when the database does not
 * answer.
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
    /** The id of the person who connected it. */
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
   * The id of the workspace that holds the installation, or null when none does: whose a webhook
   * event that came through it is.
   */
  holderOf(installationId: number): Promise<string | null>;
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
 * first. Every call throws when the database does not answer.
 */
export type TokenMintStore = {
  /**
   * Whether the workspace holds the installation: false for another workspace's installation,
   * one nobody holds, or a workspace that holds none.
   */
  holds(ids: { workspaceId: string; installationId: number }): Promise<boolean>;
  /** Records a mint. It throws when it cannot, and then the token is never handed out. */
  record(mint: TokenMint): Promise<void>;
  /** The workspace's mints, oldest first. */
  mintsOf(workspaceId: string): Promise<TokenMint[]>;
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

/** Tells GitHub's webhook deliveries from anyone else's, by their signature. */
export type WebhookSignatures = {
  /**
   * Whether `signature` (`X-Hub-Signature-256`, `sha256=` and 64 hex digits) is the HMAC-SHA256
   * of `body`, exactly as it arrived, under the app's webhook secret, compared in constant time.
   * False for a signature that is missing or not of that shape. It never throws.
   */
  verify(body: Uint8Array, signature: string | undefined): boolean;
};

/** The GitHub events each workspace received, kept for its runners and triggers. */
export type GitHubEventStore = {
  /**
   * Records the event for its workspace, unless one with its delivery id is recorded there
   * already (`recorded-before`, and nothing changes), so a delivery sent again, at once or
   * later, is recorded once. Throws when the database does not answer.
   */
  record(event: GitHubEvent): Promise<'recorded' | 'recorded-before'>;
};
