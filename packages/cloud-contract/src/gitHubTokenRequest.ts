import { CLOCK_SKEW_SECONDS } from './cellToken.js';
import { fieldProblem, isId, isRecord, isWholeNumber, read, refused } from './read.js';
import type { ReadResult } from './read.js';

/**
 * A cell's request for a GitHub token: the cell asks `cloud-global` for an installation token of
 * Consola's GitHub App, narrowed to some of a workspace's repositories, for one purpose.
 * `cloud-global` holds the app's key, so only it mints; the cell holds the work the token is
 * for (a factory pulled from a repository, a run), so only it asks.
 *
 * The request is signed by the cell, with a key of its own: its JSON as the payload of a JWS in
 * compact serialization (RFC 7515), with `CELL_TOKEN_ALGORITHM` (Ed25519) as the algorithm, the
 * cell's key's `kid` (its JWK thumbprint, RFC 7638) and `GITHUB_TOKEN_REQUEST_TYPE` as `typ` in
 * the protected header. `cloud-global` knows each region's public key from its configuration, so
 * the key that checks a request says which region's cell sent it. Nothing `cloud-global` signs
 * can pass for one: its key is no cell's, a cell token names another audience, and an outbox
 * message another `typ` and no audience at all.
 *
 * The workspace is the one the cell serves the request for: the `ws` of the caller's cell token,
 * or the workspace of a run or a factory the cell holds, never a workspace a request to the cell
 * names. `cloud-global` checks that the workspace is in the cell's region and holds the
 * installation, and that the installation covers every repository, before it mints anything.
 */
export const GITHUB_TOKEN_REQUEST_TYPE = 'consola-github-token-request';

/** The audience every request names: `cloud-global`, never a cell. */
export const GITHUB_TOKEN_REQUEST_AUDIENCE = 'consola-global';

/**
 * How long a signed request may be used. A cell signs one for each request it sends, so a minute
 * covers the clocks' difference and a slow answer, and a request captured on the way is soon
 * worth nothing.
 */
export const GITHUB_TOKEN_REQUEST_LIFETIME_SECONDS = 60;

/**
 * What a token can be for. Each purpose fixes the permissions the token gets, which
 * `cloud-global` decides and the request cannot widen:
 *
 * - `review-run`: a run of the review automation, on its repositories: contents read and pull
 *   requests write;
 * - `factory-pull`: pulling a repo-backed factory's files, from its one repository: contents
 *   read;
 * - `factory-save`: saving a repo-backed factory's files, to its one repository: contents write.
 */
export const GITHUB_TOKEN_PURPOSES = ['review-run', 'factory-pull', 'factory-save'] as const;

export type GitHubTokenPurpose = (typeof GITHUB_TOKEN_PURPOSES)[number];

export function isGitHubTokenPurpose(value: unknown): value is GitHubTokenPurpose {
  return typeof value === 'string' && (GITHUB_TOKEN_PURPOSES as readonly string[]).includes(value);
}

/** A request, as the cell signs it. Times are whole seconds since the epoch. */
export type GitHubTokenRequest = {
  /** Always `GITHUB_TOKEN_REQUEST_AUDIENCE`. */
  aud: typeof GITHUB_TOKEN_REQUEST_AUDIENCE;
  /** The workspace the token is for: its id in `cloud-global`. */
  workspaceId: string;
  /** The installation of Consola's GitHub App the workspace holds: its id on GitHub. */
  installationId: number;
  purpose: GitHubTokenPurpose;
  /**
   * The repositories the token is narrowed to, by their ids on GitHub, which a rename keeps. How
   * many a purpose may name, and that none is named twice, are `cloud-global`'s rules.
   */
  repositoryIds: number[];
  /** When the cell signed it. */
  iat: number;
  /** Until when it may be used: at most `GITHUB_TOKEN_REQUEST_LIFETIME_SECONDS` after `iat`. */
  exp: number;
};

const FIELDS = [
  'aud',
  'workspaceId',
  'installationId',
  'purpose',
  'repositoryIds',
  'iat',
  'exp',
] as const;

/** What a cell asks for, in its own words. */
export type GitHubTokenAsk = {
  workspaceId: string;
  installationId: number;
  purpose: GitHubTokenPurpose;
  repositoryIds: readonly number[];
  /** The time it signs the request, in whole seconds since the epoch. */
  issuedAt: number;
};

/**
 * The request a cell signs for what it asks, usable for `GITHUB_TOKEN_REQUEST_LIFETIME_SECONDS`
 * after it signs it. It throws on what `cloud-global`'s reader would refuse, so no such request is
 * ever sent.
 */
export function gitHubTokenRequest(ask: GitHubTokenAsk): GitHubTokenRequest {
  const request = {
    aud: GITHUB_TOKEN_REQUEST_AUDIENCE,
    workspaceId: ask.workspaceId,
    installationId: ask.installationId,
    purpose: ask.purpose,
    repositoryIds: [...ask.repositoryIds],
    iat: ask.issuedAt,
    exp: ask.issuedAt + GITHUB_TOKEN_REQUEST_LIFETIME_SECONDS,
  };
  const checked = readGitHubTokenRequest(request, ask.issuedAt);
  if (!checked.ok) throw new TypeError(`No GitHub token can be asked for this: ${checked.reason}.`);
  return checked.value;
}

/** An id GitHub gives a thing: a whole number above 0. */
const isGitHubId = (value: unknown): value is number => isWholeNumber(value) && value > 0;

/**
 * Reads a request whose signature has already been checked, at `nowSeconds` (whole seconds since
 * the epoch, from `cloud-global`'s clock). It refuses a request of any other shape (a field
 * missing, or one the contract does not name, such as permissions: the purpose fixes them), one
 * meant for anything but `cloud-global`, one that lives longer than a request may, one signed in
 * the future and one that has expired, each allowing `CLOCK_SKEW_SECONDS` between the clocks.
 * Whether the workspace is in the signing cell's region, holds the installation, and may have a
 * token for those repositories is `cloud-global`'s to check.
 */
export function readGitHubTokenRequest(
  payload: unknown,
  nowSeconds: number,
): ReadResult<GitHubTokenRequest> {
  // NaN would compare false with every time, so a request would never expire.
  if (!Number.isFinite(nowSeconds)) {
    throw new TypeError('The time to read a request at is not a number.');
  }
  if (!isRecord(payload)) return refused('the request is not an object');
  const fields = fieldProblem(payload, FIELDS, 'the request');
  if (fields !== null) return refused(fields);

  const { aud, workspaceId, installationId, purpose, repositoryIds, iat, exp } = payload;
  if (aud !== GITHUB_TOKEN_REQUEST_AUDIENCE) {
    return refused('the request is not meant for cloud-global (`aud`)');
  }
  if (!isId(workspaceId)) return refused("`workspaceId` is not a workspace's id");
  if (!isGitHubId(installationId)) return refused('`installationId` is not a GitHub id');
  if (!isGitHubTokenPurpose(purpose)) {
    return refused('`purpose` is not a purpose the contract names');
  }
  if (!Array.isArray(repositoryIds) || !repositoryIds.every(isGitHubId)) {
    return refused('`repositoryIds` is not a list of GitHub ids');
  }
  if (!isWholeNumber(iat) || iat < 0) return refused('`iat` is not a time in whole seconds');
  if (!isWholeNumber(exp) || exp < 0) return refused('`exp` is not a time in whole seconds');
  if (exp <= iat) return refused('the request expires before it was signed');
  if (exp - iat > GITHUB_TOKEN_REQUEST_LIFETIME_SECONDS) {
    return refused('the request lives longer than a request may');
  }
  if (iat > nowSeconds + CLOCK_SKEW_SECONDS) return refused('the request was signed in the future');
  if (nowSeconds >= exp + CLOCK_SKEW_SECONDS) return refused('the request has expired');
  return read({
    aud,
    workspaceId,
    installationId,
    purpose,
    repositoryIds: [...repositoryIds],
    iat,
    exp,
  });
}
