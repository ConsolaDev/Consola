import {
  boolean,
  isOneOf,
  isPositiveWhole,
  isRecord,
  isTextUpTo,
  objectOf,
  type Reader,
  type ReadResult,
  read,
  readerOf,
  refused,
} from './read.js';
import { isRepository, type Repository } from './repository.js';

/**
 * What the cell tells a runner of a GitHub event (`github.event`), and what a runner may ask a
 * GitHub token for (`github.token.request`).
 *
 * An event is narrowed facts, never GitHub's payload: the cell keeps the payload and sends only
 * what a runner matches triggers on and works from. Every string is bounded, in UTF-16 code units
 * (`String.length`), and a pull request's title is the author's own text, so the cell cuts each to
 * its bound before it sends. One event is named today, `pull_request`; another joins the union
 * (`GitHubEventFacts`) with a reader of its own.
 */

/**
 * GitHub's id of a delivery (`X-GitHub-Delivery`): a GUID, read as letters, digits and dashes, at
 * most 64 of them, as `@consola/cloud-contract` reads it where the cell receives the event.
 */
export function isDeliveryId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(value);
}

/** The events the protocol names, by GitHub's own names (`X-GitHub-Event`). */
export const GITHUB_EVENT_NAMES = ['pull_request'] as const;
export type GitHubEventName = (typeof GITHUB_EVENT_NAMES)[number];

/** The longest an event's action may be (`opened`, `synchronize`, `ready_for_review`). */
export const GITHUB_ACTION_MAX = 64;

/** The longest a pull request's title may be. GitHub's own limit is 256 characters. */
export const PULL_REQUEST_TITLE_MAX = 1024;

/** The longest an author's login may be. GitHub's are at most 39, and a bot's adds `[bot]`. */
export const GITHUB_LOGIN_MAX = 64;

/** The longest a branch's name (`headRef`, `baseRef`) may be. */
export const GIT_REF_MAX = 1024;

/** The longest a pull request's address may be. */
export const GITHUB_URL_MAX = 2048;

/** A pull request event's facts. */
export type PullRequestFacts = {
  name: 'pull_request';
  /** GitHub's action: lowercase words joined by `_` (`opened`, `synchronize`). */
  action: string;
  repository: Repository;
  number: number;
  /** Its page: an https address. */
  url: string;
  /** The author's own text, at most `PULL_REQUEST_TITLE_MAX`, possibly empty. */
  title: string;
  /** The author's login. */
  author: string;
  draft: boolean;
  /** The head commit: 40 lowercase hex digits. */
  headSha: string;
  /** The head branch's name, without `refs/heads/`. */
  headRef: string;
  /** The base branch's name, without `refs/heads/`. */
  baseRef: string;
  /** Whether the head is in another repository (a fork) than the base. */
  fork: boolean;
};

/** Every event's facts, by `name`. */
export type GitHubEventFacts = PullRequestFacts;

const ACTION = /^[a-z][a-z_]*$/;
const SHA = /^[0-9a-f]{40}$/;

function isGitHubUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > GITHUB_URL_MAX) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

const upTo = (max: number, what: string): Reader<string> =>
  readerOf((value: unknown): value is string => isTextUpTo(value, max), what);

const readPullRequest = objectOf<PullRequestFacts>({
  name: readerOf((value: unknown): value is 'pull_request' => value === 'pull_request', 'an event'),
  action: readerOf(
    (value: unknown): value is string => isTextUpTo(value, GITHUB_ACTION_MAX) && ACTION.test(value),
    "a GitHub event's action",
  ),
  repository: readerOf(isRepository, '`owner/name`'),
  number: readerOf(isPositiveWhole, 'a whole number from 1'),
  url: readerOf(isGitHubUrl, 'an https address'),
  title: readerOf(
    (value: unknown): value is string =>
      typeof value === 'string' && value.length <= PULL_REQUEST_TITLE_MAX,
    `text of at most ${PULL_REQUEST_TITLE_MAX} characters`,
  ),
  author: upTo(GITHUB_LOGIN_MAX, 'a GitHub login'),
  draft: boolean,
  headSha: readerOf(
    (value: unknown): value is string => typeof value === 'string' && SHA.test(value),
    "a commit's 40 lowercase hex digits",
  ),
  headRef: upTo(GIT_REF_MAX, "a branch's name"),
  baseRef: upTo(GIT_REF_MAX, "a branch's name"),
  fork: boolean,
});

/**
 * Reads an event's facts, as strictly as the messages: a `name` the protocol does not name, a
 * field missing or one it does not name, and a string past its bound are refused. `at` names
 * where the facts sit in their message.
 */
export function readGitHubEventFacts(json: unknown, at = 'event'): ReadResult<GitHubEventFacts> {
  if (!isRecord(json)) return refused(`\`${at}\` is not an object`);
  if (json.name === 'pull_request') return readPullRequest(json, at);
  return refused(`\`${at}.name\` is not an event the protocol names`);
}

/** How far a GitHub token may reach for one permission. */
export const GITHUB_PERMISSION_LEVELS = ['read', 'write'] as const;
export type GitHubPermissionLevel = (typeof GITHUB_PERMISSION_LEVELS)[number];

/**
 * The permissions a runner asks a token for, by GitHub's names (`contents`, `pull_requests`):
 * 1 to `GITHUB_PERMISSIONS_MAX` of them. Which a step may have is the cell's to decide.
 */
export type GitHubPermissions = Record<string, GitHubPermissionLevel>;

export const GITHUB_PERMISSIONS_MAX = 8;

/** A permission's name: lowercase snake_case, at most 64 characters. */
const PERMISSION_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** Reads the permissions a token is asked for. A reason never names a permission. */
export const readGitHubPermissions: Reader<GitHubPermissions> = (value, at) => {
  if (!isRecord(value)) return refused(`\`${at}\` is not an object`);
  const entries = Object.entries(value);
  if (entries.length === 0) return refused(`\`${at}\` names no permission`);
  if (entries.length > GITHUB_PERMISSIONS_MAX) {
    return refused(`\`${at}\` names more than ${GITHUB_PERMISSIONS_MAX} permissions`);
  }
  if (!entries.every(([name]) => PERMISSION_NAME.test(name))) {
    return refused(`\`${at}\` names a permission that is not lowercase snake_case`);
  }
  if (!entries.every(([, level]) => isOneOf(GITHUB_PERMISSION_LEVELS, level))) {
    return refused(`\`${at}\` gives a permission a level that is not \`read\` or \`write\``);
  }
  return read(Object.fromEntries(entries) as GitHubPermissions);
};
