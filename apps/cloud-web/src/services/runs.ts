import type { CellRefusal } from '../domain/cell';
import type { paths } from '../domain/cellApiContract';
import type { ApprovalDecision, ApproveAnswer } from '../domain/runApproval';
import type { RunFilters } from '../domain/runFilters';
import type { MembersAnswer, RunAnswer, RunsAnswer } from '../domain/runs';
import type { WorkspaceMember } from '../domain/teams';
import { codeOf, createCellSession, pageCellSession } from './cell';
import type { CellDeps, CellSession } from './cell';

/*
 * A workspace's runs, from its regional cell, reached through `cell.ts` as Teams reaches its
 * teams: the cell's address on the page's own origin, and a cell token for the workspace the page
 * shows with every call. The names of the people who started runs are `cloud-global`'s.
 *
 * Every call answers in domain types and never throws. Only a 401 from `cloud-global` means
 * signed out; anything the calls do not expect, a cell that does not answer included, is
 * `unavailable`. An answer is read defensively, as the contract's types check nothing that
 * arrives.
 */

type RunsQuery = NonNullable<paths['/api/runs']['get']['parameters']['query']>;

/** The cell's query for `filters`, at `cursor` (the page before's `nextCursor`), `limit` runs long. */
export function queryOf(
  filters: RunFilters,
  page: { cursor?: string | null; limit?: number } = {},
): RunsQuery {
  const query: RunsQuery = {};
  if (filters.phases.length > 0) query.phase = [...filters.phases];
  if (filters.triggers.length > 0) query.trigger = [...filters.triggers];
  if (filters.factoryId) query.factoryId = filters.factoryId;
  else if (filters.teamId) query.teamId = filters.teamId;
  if (filters.automation) query.automation = filters.automation;
  if (filters.mine) query.mine = 'true';
  const q = filters.q.trim();
  if (q) query.q = q;
  if (page.cursor) query.cursor = page.cursor;
  if (page.limit !== undefined) query.limit = page.limit;
  return query;
}

const UNAVAILABLE = { kind: 'unavailable' } as const;
const PENDING = { kind: 'pending' } as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A body that has the shape of a page of runs: the parts the page reads before anything else. */
function isRunList(body: unknown): boolean {
  return (
    isObject(body) &&
    Array.isArray(body.runs) &&
    isObject(body.counts) &&
    isObject(body.facets) &&
    Array.isArray(body.facets.factories) &&
    Array.isArray(body.facets.teams) &&
    Array.isArray(body.facets.automations)
  );
}

function isRunDetail(body: unknown): boolean {
  return (
    isObject(body) &&
    isObject(body.run) &&
    Array.isArray(body.steps) &&
    Array.isArray(body.children)
  );
}

/** A body that has the shape of a run's approval: the parts the card reads before anything else. */
function isApproval(body: unknown): boolean {
  return (
    isObject(body) &&
    typeof body.version === 'number' &&
    typeof body.mayAnswer === 'boolean' &&
    isObject(body.team) &&
    isObject(body.will) &&
    Array.isArray(body.will.commands) &&
    Array.isArray(body.will.agents)
  );
}

/** The cell's 409s to an answer, by their code. */
const ANSWER_CONFLICTS: Record<string, ApproveAnswer> = {
  not_waiting: { kind: 'not-waiting' },
  already_answered: { kind: 'already-answered' },
  version_moved: { kind: 'version-moved' },
  workspace_pending: { kind: 'pending' },
};

/** The workspace's cell said it does not hold the workspace yet. */
function pendingOr(status: number, error: unknown): CellRefusal {
  return status === 409 && codeOf(error) === 'workspace_pending' ? PENDING : UNAVAILABLE;
}

export type RunsService = {
  /** A page of the top-level runs the person sees in `workspace`, narrowed by `filters`. */
  loadRuns(
    workspace: { id: string },
    filters: RunFilters,
    page?: { cursor?: string | null; limit?: number },
  ): Promise<RunsAnswer>;
  /** One run, with its steps, a request's facts and the automations it started. */
  loadRun(workspace: { id: string }, runId: string): Promise<RunAnswer>;
  /** The workspace's members, to name who started each run. */
  loadMembers(workspace: { id: string }): Promise<MembersAnswer>;
  /**
   * Answers a run that waits for approval, for the version it asks about: the cell records the
   * first answer for that version, and the run's runner acts on it.
   */
  approveRun(
    workspace: { id: string },
    runId: string,
    answer: { decision: ApprovalDecision; version: number },
  ): Promise<ApproveAnswer>;
};

/**
 * The runs service, holding the token it last minted. The page uses `runsService`; a test builds
 * its own with `cloud-global`'s client and the cell's `fetch` stood in for, as Teams' does.
 */
export function createRunsService(deps: CellDeps & { session?: CellSession } = {}): RunsService {
  const session = deps.session ?? createCellSession(deps);
  const { onCell, api } = session;

  /** The workspace's members from `cloud-global`, or why they could not be had. */
  async function membersOf(): Promise<WorkspaceMember[] | CellRefusal> {
    const { data, error, response } = await api.GET('/api/me/workspace/members');
    if (response.status === 401) return { kind: 'signed-out' };
    if (response.status === 200 && Array.isArray(data?.members)) return data.members;
    const code = codeOf(error);
    if (code === 'no_active_workspace' || code === 'not_a_member') return { kind: 'switched' };
    return UNAVAILABLE;
  }

  return {
    async loadRuns(workspace, filters, page = {}) {
      try {
        const answer = await onCell(workspace.id, (cell) =>
          cell.GET('/api/runs', { params: { query: queryOf(filters, page) } }),
        );
        if ('kind' in answer) return answer;
        const { data, error, response } = answer;
        if (response.status === 200 && data && isRunList(data))
          return { kind: 'listed', list: data };
        if (response.status === 400 && codeOf(error) === 'invalid_request') {
          return { kind: 'invalid' };
        }
        return pendingOr(response.status, error);
      } catch {
        return UNAVAILABLE;
      }
    },

    async loadRun(workspace, runId) {
      try {
        const answer = await onCell(workspace.id, (cell) =>
          cell.GET('/api/runs/{runId}', { params: { path: { runId } } }),
        );
        if ('kind' in answer) return answer;
        const { data, error, response } = answer;
        if (response.status === 200 && data && isRunDetail(data)) {
          return { kind: 'found', detail: data };
        }
        if (response.status === 404 && codeOf(error) === 'run_not_found') {
          return { kind: 'not-found' };
        }
        return pendingOr(response.status, error);
      } catch {
        return UNAVAILABLE;
      }
    },

    async approveRun(workspace, runId, { decision, version }) {
      try {
        const answer = await onCell(workspace.id, (cell) =>
          cell.POST('/api/runs/{runId}/approval', {
            params: { path: { runId } },
            body: { decision, version },
          }),
        );
        if ('kind' in answer) return answer;
        const { data, error, response } = answer;
        if (response.status === 201 && data && isApproval(data)) {
          return { kind: 'answered', approval: data };
        }
        const code = codeOf(error);
        if (response.status === 400 && code === 'invalid_request') return { kind: 'invalid' };
        if (response.status === 403 && code === 'not_allowed') return { kind: 'not-allowed' };
        if (response.status === 404 && code === 'run_not_found') return { kind: 'not-found' };
        if (
          response.status === 409 &&
          typeof code === 'string' &&
          Object.hasOwn(ANSWER_CONFLICTS, code)
        ) {
          return ANSWER_CONFLICTS[code];
        }
        return UNAVAILABLE;
      } catch {
        return UNAVAILABLE;
      }
    },

    async loadMembers() {
      try {
        const members = await membersOf();
        return 'kind' in members ? members : { kind: 'listed', members };
      } catch {
        return UNAVAILABLE;
      }
    },
  };
}

/** The page's runs service. */
export const runsService = createRunsService({ session: pageCellSession });
