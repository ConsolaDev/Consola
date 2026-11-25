import {
  type GitHubEventFacts,
  type GitHubPermissions,
  isDeliveryId,
  readGitHubEventFacts,
  readGitHubPermissions,
} from './github.js';
import {
  fieldProblem,
  isId,
  isIsoTime,
  isOneOf,
  isPositiveWhole,
  isTextUpTo,
  listOf,
  objectOf,
  type Reader,
  type ReadResult,
  read,
  readerOf,
  refused,
} from './read.js';
import { isRepository, type Repository } from './repository.js';
import { readRunRecord, type RunRecord } from './run.js';

/**
 * The messages for automation runs (CON-116, stage 1). The cell stays the store and writes no run
 * of its own; the runner decides. So the cell hands the runner what it holds (GitHub's events,
 * the factories' files, a person's answer to a run, a token for a step) and the runner records
 * each run back, whole, every time it changes. Each message's reader is `messages.ts`'s, by its
 * `type`.
 */

/** The longest a request's id may be. */
export const REQUEST_ID_MAX = 64;

const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A request's id: 1 to `REQUEST_ID_MAX` letters, digits, `_` or `-`. The runner picks it for a
 * request, and the cell's answer names it, so the runner can match the two.
 */
export function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID.test(value);
}

// Runner to cell.

/** One factory at one version. */
export type FactoryPick = { factoryId: string; version: number };

/**
 * Asks for the workspace's factories, each at its latest saved version, or with `only` for one
 * factory at one version (a run's, which a runner that restarted picks up). Answered by
 * `factories` with the same `requestId`.
 */
export type FactoriesRequest = { type: 'factories.request'; requestId: string; only?: FactoryPick };

/** A run, whole, every time it changes. The cell may answer `run.refused`. */
export type RunRecordMessage = { type: 'run.record'; run: RunRecord };

/** The runner has dealt with a `github.event`: it recorded the event's runs, or found none. */
export type GitHubEventAck = { type: 'github.event.ack'; deliveryId: string };

/**
 * Asks for a GitHub token for one step of a run, on one repository, with these permissions.
 * Answered by `github.token` or `github.token.refused` with the same `requestId`.
 */
export type GitHubStepTokenRequest = {
  type: 'github.token.request';
  requestId: string;
  runId: string;
  stepId: string;
  repository: Repository;
  permissions: GitHubPermissions;
};

// Cell to runner.

/** A GitHub event the workspace's installation received, as narrowed facts. */
export type GitHubEventNotice = {
  type: 'github.event';
  deliveryId: string;
  event: GitHubEventFacts;
};

/** The most factories one `factories` message holds. */
export const FACTORIES_PER_ANSWER_MAX = 64;

/** The most files one factory in a `factories` message holds. The cell stores at most 500. */
export const FILES_PER_FACTORY_MAX = 512;

/** The longest a file's path inside its factory's folder may be. */
export const FACTORY_FILE_PATH_MAX = 256;

/**
 * The longest a file's text may be, in UTF-16 code units: factory-spec reads at most 1 MiB of
 * UTF-8 of one file, which never takes more code units than bytes.
 */
export const FACTORY_FILE_TEXT_MAX = 1024 * 1024;

/** A file of a factory's folder: its path inside the folder, and its text. */
export type FactoryFile = { readonly path: string; readonly content: string };

/** One factory at one version, with that version's files. */
export type FactorySnapshot = { factoryId: string; version: number; files: FactoryFile[] };

/**
 * The answer to `factories.request`: the factories asked for, none for an `only` the cell does
 * not hold.
 */
export type FactoriesAnswer = {
  type: 'factories';
  requestId: string;
  factories: FactorySnapshot[];
};

/** A person's answer to a run waiting for approval. */
export const RUN_DECISIONS = ['approved', 'rejected'] as const;
export type RunDecision = (typeof RUN_DECISIONS)[number];

/**
 * A person answered a run's approval. `run` is the record as the cell stores it, so a runner that
 * restarted can pick the run up; `personId` is the person's global id.
 */
export type RunAnswered = {
  type: 'run.answered';
  run: RunRecord;
  decision: RunDecision;
  personId: string;
};

/** The longest a GitHub token may be. */
export const GITHUB_TOKEN_MAX = 2048;

const TOKEN = /^[\x21-\x7e]+$/;

/**
 * A GitHub token for a step, until `expiresAt` (an ISO 8601 time). `token` is a secret: no
 * reader's reason holds it, and neither side logs it.
 */
export type GitHubStepToken = {
  type: 'github.token';
  requestId: string;
  token: string;
  expiresAt: string;
};

/** The longest a token's refusal may be. */
export const TOKEN_REFUSAL_MAX = 1024;

/** Why the cell gave no token for a `github.token.request`, in words for the run's page. */
export type GitHubStepTokenRefused = {
  type: 'github.token.refused';
  requestId: string;
  reason: string;
};

/** The most problems one `run.refused` names. */
export const RUN_PROBLEMS_MAX = 64;

/** The longest a problem's `field` or `message` may be. */
export const RUN_PROBLEM_TEXT_MAX = 1024;

/** What is wrong with a record, naming the field it is in, as the cell's `checkRun` says it. */
export type RunProblem = { readonly field: string; readonly message: string };

/** The cell's check refused a `run.record`: the run is stored as it was before, if at all. */
export type RunRefused = { type: 'run.refused'; runId: string; problems: RunProblem[] };

const upTo = (max: number, what: string): Reader<string> =>
  readerOf((value: unknown): value is string => isTextUpTo(value, max), what);

const readPick = objectOf<FactoryPick>({
  factoryId: readerOf(isId, "a factory's id"),
  version: readerOf(isPositiveWhole, 'a version from 1'),
});

export function readFactoriesRequest(
  message: Record<string, unknown>,
): ReadResult<FactoriesRequest> {
  const fields = fieldProblem(message, ['type', 'requestId'], 'the factories request', ['only']);
  if (fields !== null) return refused(fields);
  const { requestId, only } = message;
  if (!isRequestId(requestId)) return refused("`requestId` is not a request's id");
  const request: FactoriesRequest = { type: 'factories.request', requestId };
  if (only !== undefined) {
    const pick = readPick(only, 'only');
    if (!pick.ok) return pick;
    request.only = pick.value;
  }
  return read(request);
}

export function readRunRecordMessage(
  message: Record<string, unknown>,
): ReadResult<RunRecordMessage> {
  const fields = fieldProblem(message, ['type', 'run'], 'the run record');
  if (fields !== null) return refused(fields);
  const run = readRunRecord(message.run, 'run');
  if (!run.ok) return run;
  return read({ type: 'run.record', run: run.value });
}

export function readGitHubEventAck(message: Record<string, unknown>): ReadResult<GitHubEventAck> {
  const fields = fieldProblem(message, ['type', 'deliveryId'], 'the acknowledgement');
  if (fields !== null) return refused(fields);
  const { deliveryId } = message;
  if (!isDeliveryId(deliveryId)) return refused("`deliveryId` is not a GitHub delivery's id");
  return read({ type: 'github.event.ack', deliveryId });
}

const TOKEN_REQUEST = [
  'type',
  'requestId',
  'runId',
  'stepId',
  'repository',
  'permissions',
] as const;

export function readGitHubStepTokenRequest(
  message: Record<string, unknown>,
): ReadResult<GitHubStepTokenRequest> {
  const fields = fieldProblem(message, TOKEN_REQUEST, 'the token request');
  if (fields !== null) return refused(fields);
  const { requestId, runId, stepId, repository } = message;
  if (!isRequestId(requestId)) return refused("`requestId` is not a request's id");
  if (!isId(runId)) return refused("`runId` is not a run's id");
  if (!isId(stepId)) return refused("`stepId` is not a step's id");
  if (!isRepository(repository)) return refused('`repository` is not `owner/name`');
  const permissions = readGitHubPermissions(message.permissions, 'permissions');
  if (!permissions.ok) return permissions;
  return read({
    type: 'github.token.request',
    requestId,
    runId,
    stepId,
    repository,
    permissions: permissions.value,
  });
}

export function readGitHubEventNotice(
  message: Record<string, unknown>,
): ReadResult<GitHubEventNotice> {
  const fields = fieldProblem(message, ['type', 'deliveryId', 'event'], 'the event');
  if (fields !== null) return refused(fields);
  const { deliveryId } = message;
  if (!isDeliveryId(deliveryId)) return refused("`deliveryId` is not a GitHub delivery's id");
  const event = readGitHubEventFacts(message.event, 'event');
  if (!event.ok) return event;
  return read({ type: 'github.event', deliveryId, event: event.value });
}

const readFactories = listOf(
  objectOf<FactorySnapshot>({
    factoryId: readerOf(isId, "a factory's id"),
    version: readerOf(isPositiveWhole, 'a version from 1'),
    files: listOf(
      objectOf<FactoryFile>({
        path: upTo(FACTORY_FILE_PATH_MAX, "a path in a factory's folder"),
        content: readerOf(
          (value: unknown): value is string =>
            typeof value === 'string' && value.length <= FACTORY_FILE_TEXT_MAX,
          "a factory file's text",
        ),
      }),
      FILES_PER_FACTORY_MAX,
    ),
  }),
  FACTORIES_PER_ANSWER_MAX,
);

export function readFactoriesAnswer(message: Record<string, unknown>): ReadResult<FactoriesAnswer> {
  const fields = fieldProblem(message, ['type', 'requestId', 'factories'], 'the factories');
  if (fields !== null) return refused(fields);
  const { requestId } = message;
  if (!isRequestId(requestId)) return refused("`requestId` is not a request's id");
  const factories = readFactories(message.factories, 'factories');
  if (!factories.ok) return factories;
  return read({ type: 'factories', requestId, factories: factories.value });
}

export function readRunAnswered(message: Record<string, unknown>): ReadResult<RunAnswered> {
  const fields = fieldProblem(message, ['type', 'run', 'decision', 'personId'], 'the answer');
  if (fields !== null) return refused(fields);
  const { decision, personId } = message;
  const run = readRunRecord(message.run, 'run');
  if (!run.ok) return run;
  if (!isOneOf(RUN_DECISIONS, decision)) return refused('`decision` is not a decision');
  if (!isId(personId)) return refused("`personId` is not a person's id");
  return read({ type: 'run.answered', run: run.value, decision, personId });
}

export function readGitHubStepToken(message: Record<string, unknown>): ReadResult<GitHubStepToken> {
  const fields = fieldProblem(message, ['type', 'requestId', 'token', 'expiresAt'], 'the token');
  if (fields !== null) return refused(fields);
  const { requestId, token, expiresAt } = message;
  if (!isRequestId(requestId)) return refused("`requestId` is not a request's id");
  // The reason says what is wrong with the token, never any of it.
  if (!isTextUpTo(token, GITHUB_TOKEN_MAX) || !TOKEN.test(token)) {
    return refused('`token` is not a token');
  }
  if (!isIsoTime(expiresAt)) return refused('`expiresAt` is not an ISO 8601 time');
  return read({ type: 'github.token', requestId, token, expiresAt });
}

export function readGitHubStepTokenRefused(
  message: Record<string, unknown>,
): ReadResult<GitHubStepTokenRefused> {
  const fields = fieldProblem(message, ['type', 'requestId', 'reason'], 'the refusal');
  if (fields !== null) return refused(fields);
  const { requestId, reason } = message;
  if (!isRequestId(requestId)) return refused("`requestId` is not a request's id");
  if (!isTextUpTo(reason, TOKEN_REFUSAL_MAX)) return refused('`reason` is not text');
  return read({ type: 'github.token.refused', requestId, reason });
}

const readProblems = listOf(
  objectOf<RunProblem>({
    field: upTo(RUN_PROBLEM_TEXT_MAX, "a field's name"),
    message: upTo(RUN_PROBLEM_TEXT_MAX, 'text'),
  }),
  RUN_PROBLEMS_MAX,
);

export function readRunRefused(message: Record<string, unknown>): ReadResult<RunRefused> {
  const fields = fieldProblem(message, ['type', 'runId', 'problems'], 'the refusal');
  if (fields !== null) return refused(fields);
  const { runId } = message;
  if (!isId(runId)) return refused("`runId` is not a run's id");
  const problems = readProblems(message.problems, 'problems');
  if (!problems.ok) return problems;
  if (problems.value.length === 0) return refused('`problems` names no problem');
  return read({ type: 'run.refused', runId, problems: problems.value });
}
