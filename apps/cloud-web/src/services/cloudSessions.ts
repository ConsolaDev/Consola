import { isHarness, isSessionStatus } from '../domain/cloudSession';
import type {
  AgentRunReport,
  AgentRunState,
  CloudSession,
  CloudSessionOptions,
  CloudSessionOrigin,
  CloudSessionPass,
  DispatchedAgent,
  DispatchedAgentStatus,
  Harness,
  OptionsAnswer,
  PassAnswer,
  SessionAnswer,
  SessionsAnswer,
  StartAnswer,
  StartRefusalCode,
  StopAnswer,
} from '../domain/cloudSession';
import { messageForPassAnswer } from '../domain/cloudSessionMessages';
import { codeOf, createCellSession, pageCellSession, UNAVAILABLE } from './cell';
import type { CellDeps, CellSession } from './cell';

/*
 * The person's cloud sessions, from the workspace's regional cell, reached through `cell.ts` as
 * runs and teams are: the cell's address on the page's own origin, and a cell token for the
 * workspace the page shows with every call. A session is the person's own, or an agent run, which
 * every member sees; the cell answers another person's session as not found.
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

/** What started an agent run, with the parts the pages read: the automation and its pull request. */
function isOrigin(value: unknown): value is CloudSessionOrigin {
  if (!isObject(value) || value.kind !== 'automation') return false;
  const { item } = value;
  return (
    isText(value.factoryId) &&
    isText(value.factoryName) &&
    isText(value.automation) &&
    isText(value.agent) &&
    isObject(item) &&
    item.kind === 'pull_request' &&
    isText(item.repository) &&
    typeof item.number === 'number' &&
    Number.isInteger(item.number) &&
    isText(item.url) &&
    isText(item.title) &&
    isText(item.headSha)
  );
}

const AGENT_RUN_STATES: ReadonlySet<unknown> = new Set<AgentRunState>([
  'working',
  'waiting',
  'done',
  'failed',
]);
const DISPATCHED_STATUSES: ReadonlySet<unknown> = new Set<DispatchedAgentStatus>([
  'working',
  'done',
  'failed',
]);

function dispatchedOf(value: unknown): DispatchedAgent | null {
  if (!isObject(value) || !isText(value.id) || !isText(value.agent)) return null;
  if (!DISPATCHED_STATUSES.has(value.status)) return null;
  const agent: DispatchedAgent = {
    id: value.id,
    agent: value.agent,
    status: value.status as DispatchedAgentStatus,
  };
  if (isText(value.summary)) agent.summary = value.summary;
  return agent;
}

/**
 * The runner's report of an agent run, as far as the page can read it: a report it cannot read
 * (a newer runner's state) is none, and an agent it cannot read is left out, so the session
 * itself still shows.
 */
function reportOf(value: unknown): AgentRunReport | null {
  if (!isObject(value) || !AGENT_RUN_STATES.has(value.state)) return null;
  const report: AgentRunReport = { state: value.state as AgentRunState };
  if (isText(value.summary)) report.summary = value.summary;
  if (Array.isArray(value.agents)) {
    report.agents = value.agents.map(dispatchedOf).filter((agent) => agent !== null);
  }
  return report;
}

/**
 * A body with the shape of a session, the parts the pages read, or null. An agent run's
 * `origin` must be whole, since the page links what it names; its report is read leniently.
 */
function sessionOf(body: unknown): CloudSession | null {
  if (
    !isObject(body) ||
    !isText(body.id) ||
    body.id === '' ||
    !isText(body.repository) ||
    !isHarness(body.harness) ||
    !isSessionStatus(body.status) ||
    !isTextOrNull(body.title) ||
    !isTextOrNull(body.hostUrl) ||
    !isTextOrNull(body.error) ||
    !isTextOrNull(body.errorCode) ||
    !isTime(body.createdAt) ||
    !(body.endedAt === null || isTime(body.endedAt)) ||
    !(body.origin === undefined || body.origin === null || isOrigin(body.origin))
  ) {
    return null;
  }
  return {
    ...(body as CloudSession),
    personId: isText(body.personId) ? body.personId : null,
    runnerId: isText(body.runnerId) ? body.runnerId : null,
    origin: isOrigin(body.origin) ? body.origin : null,
    agentRun: reportOf(body.agentRun),
  };
}

/** Every session of a list, or null when any is not one. */
function sessionsOf(body: unknown): CloudSession[] | null {
  if (!Array.isArray(body)) return null;
  const sessions = body.map(sessionOf);
  return sessions.every((session) => session !== null) ? sessions : null;
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
  /** The person's own sessions in `workspace` and every agent run of it, newest first. */
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
        const sessions = response.status === 200 ? sessionsOf(data) : null;
        if (sessions) return { kind: 'listed', sessions };
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
        const session = response.status === 200 ? sessionOf(data) : null;
        if (session) return { kind: 'found', session };
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
        const session = response.status === 201 ? sessionOf(data) : null;
        if (session) return { kind: 'started', session };
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
        const session = response.status === 202 ? sessionOf(data) : null;
        if (session) return { kind: 'stopped', session };
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
