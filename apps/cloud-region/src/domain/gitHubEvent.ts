import {
  GIT_REF_MAX,
  GITHUB_ACTION_MAX,
  GITHUB_LOGIN_MAX,
  GITHUB_URL_MAX,
  isRepository,
  PULL_REQUEST_TITLE_MAX,
  readGitHubEventFacts,
} from '@consola/runner-protocol';
import type { GitHubEventFacts, PullRequestFacts, Repository } from '@consola/runner-protocol';

/**
 * What the cell makes of a GitHub event it records, for the workspace's runner (CON-116, stage
 * 1). The cell hands a runner narrowed facts (`GitHubEventFacts`), never GitHub's payload, and
 * reads them here, strictly: the payload is untrusted, and a pull request's title, branches and
 * login are its author's. A string past the protocol's bound is refused, but for the title, which
 * is cut to it. An address is taken only on `https:` at github.com.
 *
 * Every reason names a field, never what it held, so it can be logged.
 */

/** The events the cell hands a runner, by GitHub's names: a pull request's, in stage 1. */
export const EVENTS_FOR_RUNNERS: readonly string[] = ['pull_request'];

/** How far back a runner's hello reaches for the events it has not acknowledged. */
export const HELD_EVENTS_WINDOW_SECONDS = 24 * 60 * 60;

/** The most held events one hello sends again: the newest, oldest first. */
export const HELD_EVENTS_MAX = 200;

/**
 * What becomes of an event for the runners: `held` until the runner acknowledges it, with the
 * facts it is handed; `not-for-runners`, an event of a name runners take that does not read into
 * facts, never handed and never tried again; or null, an event of a name no runner takes.
 */
export type HandOver =
  | { kind: 'held'; facts: GitHubEventFacts }
  | { kind: 'not-for-runners'; reason: string }
  | null;

/**
 * Where an event stands with the runners, as the cell keeps it: `held` until the runner
 * acknowledges it, then `acknowledged`; `not-for-runners` when it did not read into facts.
 */
export const RUNNER_STATES = ['held', 'acknowledged', 'not-for-runners'] as const;
export type RunnerState = (typeof RUNNER_STATES)[number];

/** A held event as the cell hands it again. */
export type HeldEvent = { deliveryId: string; facts: GitHubEventFacts };

/** The repository an event happened in, by GitHub's id (which a rename keeps) and its name now. */
export type EventRepository = { id: number; fullName: Repository };

type Read<T> = { ok: true; value: T } | { ok: false; reason: string };

const refused = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isGitHubId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** A control character, which no branch name or login holds. */
const CONTROL = /\p{Cc}/u;

/** Text of 1 to `max` code units, with no control character. */
const isPlainText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !CONTROL.test(value);

const ACTION = /^[a-z][a-z_]*$/;
const SHA = /^[0-9a-f]{40}$/;
/** A UTF-16 surrogate with no partner, which no UTF-8 text can hold. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * A title as a runner may record it: at most `PULL_REQUEST_TITLE_MAX` code units, never cut
 * between the halves of a pair, with a NUL or a lone surrogate (which the cell's database cannot
 * hold, so neither could a run's record of it) as U+FFFD.
 */
export function titleOf(title: string): string {
  const clean = title.replaceAll('\u0000', '�').replaceAll(LONE_SURROGATE, '�');
  if (clean.length <= PULL_REQUEST_TITLE_MAX) return clean;
  const end = /[\uD800-\uDBFF]/.test(clean.charAt(PULL_REQUEST_TITLE_MAX - 1))
    ? PULL_REQUEST_TITLE_MAX - 1
    : PULL_REQUEST_TITLE_MAX;
  return clean.slice(0, end);
}

/**
 * A pull request's page, if it is one at github.com: `https:`, no user, no port, and the path
 * `/<owner>/<name>/pull/<number>` of the event's own repository and number, in any case.
 */
function isPullRequestPage(
  value: unknown,
  repository: Repository,
  number: number,
): value is string {
  if (typeof value !== 'string' || value.length > GITHUB_URL_MAX) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.hostname === 'github.com' &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    url.search === '' &&
    url.hash === '' &&
    url.pathname.toLowerCase() === `/${repository}/pull/${number}`.toLowerCase()
  );
}

/** The repository a payload names (`repository.id`, `repository.full_name`), or null. */
export function repositoryOfPayload(payload: Record<string, unknown>): EventRepository | null {
  const { repository } = payload;
  if (!isRecord(repository)) return null;
  const { id, full_name: fullName } = repository;
  return isGitHubId(id) && isRepository(fullName) ? { id, fullName } : null;
}

/** A `pull_request` event's facts, read from GitHub's payload. */
export function pullRequestFactsOf(payload: Record<string, unknown>): Read<PullRequestFacts> {
  const { action, pull_request: pullRequest } = payload;
  if (typeof action !== 'string' || action.length > GITHUB_ACTION_MAX || !ACTION.test(action)) {
    return refused('`action` is not an action');
  }
  const repository = repositoryOfPayload(payload);
  if (!repository) return refused('`repository` does not name a repository');
  if (!isRecord(pullRequest)) return refused('`pull_request` is not an object');

  const { number, html_url: url, title, user, draft, head, base } = pullRequest;
  if (!isGitHubId(number)) return refused('`pull_request.number` is not a number from 1');
  if (!isPullRequestPage(url, repository.fullName, number)) {
    return refused("`pull_request.html_url` is not the pull request's page at https://github.com");
  }
  if (typeof title !== 'string') return refused('`pull_request.title` is not text');
  if (!isRecord(user) || !isPlainText(user.login, GITHUB_LOGIN_MAX)) {
    return refused('`pull_request.user.login` is not a login');
  }
  if (typeof draft !== 'boolean') return refused('`pull_request.draft` is not true or false');
  if (!isRecord(head) || typeof head.sha !== 'string' || !SHA.test(head.sha)) {
    return refused("`pull_request.head.sha` is not a commit's 40 lowercase hex digits");
  }
  if (!isPlainText(head.ref, GIT_REF_MAX)) return refused('`pull_request.head.ref` is no branch');
  if (!isRecord(base) || !isPlainText(base.ref, GIT_REF_MAX)) {
    return refused('`pull_request.base.ref` is no branch');
  }
  // The base is the event's repository; a head whose repository is gone was a fork.
  if (!isRecord(base.repo) || base.repo.id !== repository.id) {
    return refused('`pull_request.base.repo` is not the repository of the event');
  }
  const headRepo = head.repo;
  if (headRepo !== null && !(isRecord(headRepo) && isGitHubId(headRepo.id))) {
    return refused('`pull_request.head.repo` is not a repository');
  }

  const facts: PullRequestFacts = {
    name: 'pull_request',
    action,
    repository: repository.fullName,
    number,
    url,
    title: titleOf(title),
    author: user.login,
    draft,
    headSha: head.sha,
    headRef: head.ref,
    baseRef: base.ref,
    fork: headRepo === null || headRepo.id !== repository.id,
  };
  // Parse, never assert: what goes out is what the runner's own reader takes.
  const read = readGitHubEventFacts(JSON.parse(JSON.stringify(facts)));
  return read.ok && read.value.name === 'pull_request'
    ? { ok: true, value: read.value }
    : refused(read.ok ? 'the facts are not a pull request' : read.reason);
}

/** What becomes of an event named `name` for the runners (`HandOver`). */
export function handOverOf(name: string, payload: Record<string, unknown>): HandOver {
  if (!EVENTS_FOR_RUNNERS.includes(name)) return null;
  const read = pullRequestFactsOf(payload);
  return read.ok
    ? { kind: 'held', facts: read.value }
    : { kind: 'not-for-runners', reason: read.reason };
}
