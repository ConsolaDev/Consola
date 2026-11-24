import type { CellRefusal } from './cell';
import type { components, paths } from './cellApiContract';
import {
  failedWords,
  HARNESS_NAMES,
  SESSION_STATUS_WORDS,
  STARTING_WORDS,
  STOPPED_WORDS,
  UNPUSHED_CHANGES_WARNING,
} from './cloudSessionMessages';

/**
 * A person's cloud sessions as the web app sees them: each a sandbox the workspace's runner runs
 * for them, with an agent CLI working in one of the runner's repositories. They live in the
 * workspace's regional cell (`apps/cloud-region/AGENTS.md`, "Cloud sessions"), which shows a
 * person only their own and decides every status: `starting` goes to `running` or `failed`, and
 * `running` to `stopped` or `failed`, the two ends. A running session's chat connects straight
 * to its sandbox's host, with a short-lived pass the cell signs.
 */

type Schemas = components['schemas'];

export type CloudSession = Schemas['CloudSession'];
export type CloudSessionOptions = Schemas['CloudSessionOptions'];
export type CloudSessionPass = Schemas['CloudSessionPass'];
export type CloudSessionStatus = CloudSession['status'];
export type Harness = CloudSession['harness'];
/** A failure the cell decided itself, which the page words (never shows as a code). */
export type CellFailureCode = NonNullable<CloudSession['errorCode']>;

type StartError<Status extends 400 | 503> =
  paths['/api/cloud-sessions']['post']['responses'][Status]['content']['application/json']['error'];

/**
 * Why the cell refused to start a session, by its code: no runner connected, a repository or a
 * harness the runner does not offer, or a body it could not read. Nothing was recorded for any.
 */
export type StartRefusalCode = Exclude<
  StartError<400> | StartError<503>,
  'token_check_unavailable'
>;

export function isHarness(value: unknown): value is Harness {
  return typeof value === 'string' && Object.hasOwn(HARNESS_NAMES, value);
}

export function isSessionStatus(value: unknown): value is CloudSessionStatus {
  return typeof value === 'string' && Object.hasOwn(SESSION_STATUS_WORDS, value);
}

/** Whether a session has ended: it never moves again. */
export function isEnded(status: CloudSessionStatus): boolean {
  return status === 'stopped' || status === 'failed';
}

/** What a session is called: its title, or "Session" and its id's first eight characters. */
export function sessionLabel(session: Pick<CloudSession, 'id' | 'title'>): string {
  const title = session.title?.trim();
  return title ? title : `Session ${session.id.slice(0, 8)}`;
}

/** When a session started, as an ISO time (the cell counts epoch seconds). */
export function startedAt(session: Pick<CloudSession, 'createdAt'>): string {
  return new Date(session.createdAt * 1000).toISOString();
}

const POLL_MS: Readonly<Record<CloudSessionStatus, number | null>> = {
  starting: 2_000,
  running: 10_000,
  stopped: null,
  failed: null,
};

/**
 * How long a session's page waits before reading it again: briefly while its sandbox starts,
 * longer while it runs (to notice it stop), and never once it has ended.
 */
export function pollIntervalMs(status: CloudSessionStatus): number | null {
  return POLL_MS[status];
}

/** How long the list waits once nothing shown can change: a session started elsewhere shows. */
export const LIST_POLL_QUIET_MS = 30_000;

/** How long the list waits before reading again: as often as its liveliest session asks. */
export function listPollIntervalMs(sessions: readonly { status: CloudSessionStatus }[]): number {
  const delays = sessions
    .map((session) => pollIntervalMs(session.status))
    .filter((delay) => delay !== null);
  return delays.length > 0 ? Math.min(...delays) : LIST_POLL_QUIET_MS;
}

/**
 * Whether the page mounts the chat: only while the session runs. Once it has stopped or failed,
 * the chat unmounts, which closes its connection to the host and forgets its pass.
 */
export function chatMounted(status: CloudSessionStatus): boolean {
  return status === 'running';
}

/**
 * Whether the chat may ask the cell for a new pass when its own expires: only while the session
 * runs. A session starting has no host yet, and one ended never will, so no pass is asked for and
 * the chat does not loop reconnecting.
 */
export function shouldRenewPass(status: CloudSessionStatus): boolean {
  return status === 'running';
}

/**
 * Whether a read that came to nothing keeps what the page shows (a session, with its chat; the
 * list), saying when it was read: only while the cell or `cloud-global` is out for a while
 * (`unavailable`, `pending`), since the next read may work. Signed out, or with another workspace
 * open, the page says so instead and a running chat unmounts, so no one goes on using a session
 * the page can no longer vouch for; and a session the cell no longer has is gone.
 */
export function keepsShownOn(answer: { kind: CellRefusal['kind'] | 'not-found' }): boolean {
  return answer.kind === 'unavailable' || answer.kind === 'pending';
}

/** What a session's page shows for it. */
export type SessionScreen =
  /** The sandbox is starting: the words alone, read again shortly. */
  | { kind: 'starting'; words: string }
  /** The chat, with the warning above it and Stop. */
  | { kind: 'running'; warning: string }
  /** The words, with no chat and so no composer. */
  | { kind: 'stopped'; words: string }
  | { kind: 'failed'; words: string };

export function sessionScreen(
  session: Pick<CloudSession, 'status' | 'error' | 'errorCode'>,
): SessionScreen {
  switch (session.status) {
    case 'starting':
      return { kind: 'starting', words: STARTING_WORDS };
    case 'running':
      return { kind: 'running', warning: UNPUSHED_CHANGES_WARNING };
    case 'stopped':
      return { kind: 'stopped', words: STOPPED_WORDS };
    case 'failed':
      return { kind: 'failed', words: failedWords(session) };
  }
}

/** What reading the person's sessions came to. */
export type SessionsAnswer = { kind: 'listed'; sessions: CloudSession[] } | CellRefusal;

/** What reading one session came to. */
export type SessionAnswer =
  | { kind: 'found'; session: CloudSession }
  /** None, or someone else's: the cell says the same of both. */
  | { kind: 'not-found' }
  | CellRefusal;

/** What asking what a new session can be came to. */
export type OptionsAnswer =
  | { kind: 'offered'; options: CloudSessionOptions }
  | { kind: 'no-runner' }
  | CellRefusal;

/** What starting a session came to. */
export type StartAnswer =
  | { kind: 'started'; session: CloudSession }
  | { kind: 'refused'; code: StartRefusalCode }
  | CellRefusal;

/** What stopping a session came to: once stopped, the session, ended. */
export type StopAnswer =
  | { kind: 'stopped'; session: CloudSession }
  | { kind: 'not-found' }
  | CellRefusal;

/** What asking for a pass to a session's host came to. */
export type PassAnswer =
  | { kind: 'issued'; pass: CloudSessionPass }
  /** The session is not running, or its host has no address yet. */
  | { kind: 'not-found' }
  /** The cell has no pass key, and so no runner. */
  | { kind: 'no-runner' }
  | CellRefusal;
