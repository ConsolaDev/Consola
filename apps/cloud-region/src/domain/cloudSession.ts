import { type Harness, isHarness, isRepository, type Repository } from '@consola/runner-protocol';

/** Where a cloud session is in its life. `stopped` and `failed` are ends. */
export const CLOUD_SESSION_STATUSES = ['starting', 'running', 'stopped', 'failed'] as const;
export type CloudSessionStatus = (typeof CLOUD_SESSION_STATUSES)[number];

/**
 * The codes of failures the cell decides itself, which `cloud-web` words. A failure a runner
 * reports is its own message instead, kept in `error` and never mistaken for one of these
 * (`CloudSession.errorCode`).
 */
export const CELL_FAILURE_CODES = {
  /** The runner restarted and its sandbox for the session is gone (Task 3's `hello`). */
  runnerRestarted: 'runner_restarted',
  /** The cell could not hand the start to the runner. */
  runnerUnreachable: 'runner_unreachable',
} as const;
export type CellFailureCode = (typeof CELL_FAILURE_CODES)[keyof typeof CELL_FAILURE_CODES];

/**
 * One cloud session as the cell records it. Times are whole seconds since the epoch.
 *
 * A failure carries exactly one of two things, never both: `error`, the message the runner
 * reported (provider or start script), or `errorCode`, a code the cell decided itself
 * (`CELL_FAILURE_CODES`). Both are null while the session lives or when it was stopped.
 */
export type CloudSession = {
  id: string;
  workspaceId: string;
  /** The person who started it, by their global id: the only one who sees it. */
  personId: string;
  repository: Repository;
  harness: Harness;
  status: CloudSessionStatus;
  title: string | null;
  /** The origin the session's host listens on, once the runner reported it. */
  hostUrl: string | null;
  error: string | null;
  errorCode: CellFailureCode | null;
  /** The runner the start was handed to; only its updates count. */
  runnerId: string;
  createdAt: number;
  endedAt: number | null;
};

export const isEnded = (status: CloudSessionStatus): boolean =>
  status === 'stopped' || status === 'failed';

/**
 * The status after an update names `update`: `starting` goes to `running` or `failed`, `running`
 * to `stopped` or `failed`. Anything else, an ended session included, stays as it is.
 */
export function nextStatus(
  current: CloudSessionStatus,
  update: 'running' | 'stopped' | 'failed',
): CloudSessionStatus {
  if (current === 'starting' && (update === 'running' || update === 'failed')) return update;
  if (current === 'running' && (update === 'stopped' || update === 'failed')) return update;
  return current;
}

/** The session after `nextStatus` moved it at `now`: reaching an end sets `endedAt`. */
export function transition(
  session: CloudSession,
  update: 'running' | 'stopped' | 'failed',
  now: number,
): CloudSession {
  const status = nextStatus(session.status, update);
  if (status === session.status) return session;
  return { ...session, status, endedAt: isEnded(status) ? now : null };
}

/** What a person asks for when they start a session. */
export type StartRequest = { repository: Repository; harness: Harness };

const START_FIELDS = ['repository', 'harness'];

/** Reads a request body: exactly `{ repository, harness }`, each valid. Never throws. */
export function readStartRequest(body: unknown): { ok: true; value: StartRequest } | { ok: false } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false };
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== START_FIELDS.length || !keys.every((key) => START_FIELDS.includes(key))) {
    return { ok: false };
  }
  const { repository, harness } = record;
  if (!isRepository(repository) || !isHarness(harness)) return { ok: false };
  return { ok: true, value: { repository, harness } };
}
