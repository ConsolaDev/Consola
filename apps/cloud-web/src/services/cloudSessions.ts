import {
  type CloudSession,
  type CloudSessionOptions,
  type CloudSessionPass,
  type Harness,
  isHarness,
  isSessionStatus,
  type OptionsAnswer,
  type PassAnswer,
  type SessionAnswer,
  type SessionsAnswer,
  type StartAnswer,
  type StartRefusalCode,
  type StopAnswer,
} from '../domain/cloudSession';
import { messageForPassAnswer } from '../domain/cloudSessionMessages';
import {
  type CellDeps,
  type CellSession,
  codeOf,
  createCellSession,
  pageCellSession,
  UNAVAILABLE,
} from './cell';

/*
 * The person's cloud sessions, from the workspace's regional cell, reached through `cell.ts` as
 * runs and teams are: the cell's address on the page's own origin, and a cell token for the
 * workspace the page shows with every call. Each session is the person's own; the cell answers
 * another's as not found.
 *
 * Every call answers in domain types and never throws, but `renewPass`, which is the chat's
 * `onPassExpired` and rejects when there is no pass to give. Only a 401 from `cloud-global` means
 * signed out; anything the calls do not expect, a proxy's error page or a cell that does not
 * answer included, is `unavailable`. An answer is read defensively, as the contract's types check
 * nothing that arrives.
 */

const NO_RUNNER = { kind: 'no-runner' } as const;
const NOT_FOUND = { kind: 'not-found' } as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const isText = (value: unknown): value is string => typeof value === 'string';
const isTextOrNull = (value: unknown): boolean => value === null || isText(value);
const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** A body with the shape of a session: the parts the pages read. */
function isSession(body: unknown): body is CloudSession {
  return (
    isObject(body) &&
    isText(body.id) &&
    body.id !== '' &&
    isText(body.repository) &&
    isHarness(body.harness) &&
    isSessionStatus(body.status) &&
    isTextOrNull(body.title) &&
    isTextOrNull(body.hostUrl) &&
    isTextOrNull(body.error) &&
    isTextOrNull(body.errorCode) &&
    isTime(body.createdAt) &&
    (body.endedAt === null || isTime(body.endedAt))
  );
}

/** What a runner offers, keeping only the harnesses this page can name. */
function optionsOf(body: unknown): CloudSessionOptions | null {
  if (!isObject(body) || !Array.isArray(body.repositories) || !Array.isArray(body.harnesses)) {
    return null;
  }
  if (!body.repositories.every(isText)) return null;
  return { repositories: body.repositories, harnesses: body.harnesses.filter(isHarness) };
}

/** Whether an address is one the chat may connect to: an `http(s)` origin. */
function isHostAddress(value: unknown): value is string {
  if (!isText(value)) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

function isPass(body: unknown): body is CloudSessionPass {
  return (
    isObject(body) &&
    isText(body.pass) &&
    body.pass !== '' &&
    isHostAddress(body.hostUrl) &&
    isTime(body.expiresAt)
  );
}

const START_REFUSALS: Readonly<Record<StartRefusalCode, 400 | 503>> = {
  no_runner: 503,
  repository_not_offered: 400,
  harness_not_offered: 400,
  invalid_request: 400,
};

/** The cell's refusal of a start, by its code and the status it comes with, if it is one. */
function startRefusalOf(status: number, error: unknown): StartRefusalCode | null {
  const code = codeOf(error);
  return typeof code === 'string' &&
    Object.hasOwn(START_REFUSALS, code) &&
    START_REFUSALS[code as StartRefusalCode] === status
    ? (code as StartRefusalCode)
    : null;
}

/** The cell's `no_runner`, which only comes as a 503. */
const isNoRunner = (status: number, error: unknown): boolean =>
  status === 503 && codeOf(error) === 'no_runner';

/** The cell's own `not_found`: a 404 without it is a proxy's, with no cell behind it. */
const isNotFound = (status: number, error: unknown): boolean =>
  status === 404 && codeOf(error) === 'not_found';

type Workspace = { id: string };

export type CloudSessionsService = {
  /** The person's sessions in `workspace`, newest first. */
  loadSessions(workspace: Workspace): Promise<SessionsAnswer>;
  loadSession(workspace: Workspace, sessionId: string): Promise<SessionAnswer>;
  /** The repositories and harnesses the workspace's runner offers a new session. */
  loadOptions(workspace: Workspace): Promise<OptionsAnswer>;
  /** Starts a session: the cell records it and hands it to the runner, or refuses with a code. */
  startSession(
    workspace: Workspace,
    asked: { repository: string; harness: Harness },
  ): Promise<StartAnswer>;
  /** Ends a session at once, whether or not its runner is connected. */
  stopSession(workspace: Workspace, sessionId: string): Promise<StopAnswer>;
  /** A pass to a running session's host, and the host's address. */
  issuePass(workspace: Workspace, sessionId: string): Promise<PassAnswer>;
  /**
   * A new pass, for the chat's `onPassExpired`: it rejects, with the sentence for why, when the
   * cell gives none (a session no longer running is a 404), so the chat stops asking.
   */
  renewPass(
    workspace: Workspace & { name: string; region: string },
    sessionId: string,
  ): Promise<string>;
};

/**
 * The cloud sessions service. The page uses `cloudSessionsService`, on the page's cell session; a
 * test builds its own with `cloud-global`'s client and the cell's `fetch` stood in for.
 */
export function createCloudSessionsService(
  deps: CellDeps & { session?: CellSession } = {},
): CloudSessionsService {
  const { onCell } = deps.session ?? createCellSession(deps);

  async function issuePass(workspace: Workspace, sessionId: string): Promise<PassAnswer> {
    try {
      const answer = await onCell(workspace.id, (cell) =>
        cell.POST('/api/cloud-sessions/{sessionId}/pass', { params: { path: { sessionId } } }),
      );
      if ('kind' in answer) return answer;
      const { data, error, response } = answer;
      if (response.status === 200 && isPass(data)) return { kind: 'issued', pass: data };
      if (isNotFound(response.status, error)) return NOT_FOUND;
      if (isNoRunner(response.status, error)) return NO_RUNNER;
      return UNAVAILABLE;
    } catch {
      return UNAVAILABLE;
    }
  }

  return {
    async loadSessions(workspace) {
      try {
        const answer = await onCell(workspace.id, (cell) => cell.GET('/api/cloud-sessions'));
        if ('kind' in answer) return answer;
        const { data, response } = answer;
        if (response.status === 200 && Array.isArray(data) && data.every(isSession)) {
          return { kind: 'listed', sessions: data };
        }
        return UNAVAILABLE;
      } catch {
        return UNAVAILABLE;
      }
    },

    async loadSession(workspace, sessionId) {
      try {
        const answer = await onCell(workspace.id, (cell) =>
          cell.GET('/api/cloud-sessions/{sessionId}', { params: { path: { sessionId } } }),
        );
        if ('kind' in answer) return answer;
        const { data, error, response } = answer;
        if (response.status === 200 && isSession(data)) return { kind: 'found', session: data };
        if (isNotFound(response.status, error)) return NOT_FOUND;
        return UNAVAILABLE;
      } catch {
        return UNAVAILABLE;
      }
    },

    async loadOptions(workspace) {
      try {
        const answer = await onCell(workspace.id, (cell) =>
          cell.GET('/api/cloud-sessions/options'),
        );
        if ('kind' in answer) return answer;
        const { data, error, response } = answer;
        const options = response.status === 200 ? optionsOf(data) : null;
        if (options) return { kind: 'offered', options };
        if (isNoRunner(response.status, error)) return NO_RUNNER;
        return UNAVAILABLE;
      } catch {
        return UNAVAILABLE;
      }
    },

    async startSession(workspace, { repository, harness }) {
      try {
        const answer = await onCell(workspace.id, (cell) =>
          cell.POST('/api/cloud-sessions', { body: { repository, harness } }),
        );
        if ('kind' in answer) return answer;
        const { data, error, response } = answer;
        if (response.status === 201 && isSession(data)) return { kind: 'started', session: data };
        const code = startRefusalOf(response.status, error);
        return code ? { kind: 'refused', code } : UNAVAILABLE;
      } catch {
        return UNAVAILABLE;
      }
    },

    async stopSession(workspace, sessionId) {
      try {
        const answer = await onCell(workspace.id, (cell) =>
          cell.POST('/api/cloud-sessions/{sessionId}/stop', { params: { path: { sessionId } } }),
        );
        if ('kind' in answer) return answer;
        const { data, error, response } = answer;
        if (response.status === 202 && isSession(data)) return { kind: 'stopped', session: data };
        if (isNotFound(response.status, error)) return NOT_FOUND;
        return UNAVAILABLE;
      } catch {
        return UNAVAILABLE;
      }
    },

    issuePass,

    async renewPass(workspace, sessionId) {
      const answer = await issuePass(workspace, sessionId);
      if (answer.kind === 'issued') return answer.pass.pass;
      throw new Error(messageForPassAnswer(answer, workspace));
    },
  };
}

/** The page's cloud sessions service. */
export const cloudSessionsService = createCloudSessionsService({ session: pageCellSession });
