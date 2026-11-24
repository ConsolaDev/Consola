import type { WorkspaceRole } from '@consola/cloud-contract';
import type { Caller } from '../domain/caller.js';
import type { Automation } from '@consola/factory-spec';
import { automationsOf, factoriesSeenBy } from '../domain/factory.js';
import type { Factory } from '../domain/factory.js';
import { checkRun, decodeCursor, encodeCursor, NO_RUNS, stepDefinitionOf } from '../domain/run.js';
import type {
  Phase,
  PhaseCounts,
  RunProblem,
  RunSummary,
  RunTrigger,
  RunWrite,
  StepSummary,
} from '../domain/run.js';
import { approvalOf, DECISION_OF, judgeAnswer } from '../domain/runApproval.js';
import type { ApprovalChoice, ApprovalRun, RunApproval } from '../domain/runApproval.js';
import { sourceOf } from '../domain/runSource.js';
import type { RunSource } from '../domain/runSource.js';
import { actingRole, teamsSeenBy } from '../domain/team.js';
import type { Team } from '../domain/team.js';
import type {
  FactoryStore,
  RunFilter,
  RunFound,
  RunRecording,
  RunStore,
  TeamStore,
} from './ports.js';

/*
 * A workspace's runs, for the caller a cell token names. Every use case reads the caller's
 * workspace alone (`caller.workspaceId`), and a caller sees the runs of the factories they see
 * (`factoriesSeenBy`, by the role they act with, `actingRole`), as factories' use cases judge
 * it: owners and admins every run, a member the runs of their teams' factories. A run the caller
 * does not see is never listed, counted or offered as a facet, and its id is not found.
 *
 * The order of the checks: what was sent (the cursor), whether the cell holds the workspace yet,
 * then what the caller sees, then what the store finds.
 */

type Pending = { kind: 'workspace-pending' };
const WORKSPACE_PENDING = { kind: 'workspace-pending' } as const;

/** What the caller sees now: the teams and factories, or none when the copy does not hold them. */
async function seenBy(
  teams: TeamStore,
  factories: FactoryStore,
  caller: Caller,
): Promise<{ teams: Team[]; factories: Factory[] }> {
  const { workspaceId, personId } = caller;
  const role: WorkspaceRole | null = actingRole(
    caller.role,
    await teams.roleInCopy(workspaceId, personId),
  );
  if (role === null) return { teams: [], factories: [] };
  const viewer = { personId, role };
  const all = await teams.list(workspaceId);
  return {
    teams: teamsSeenBy(viewer, all),
    factories: factoriesSeenBy(viewer, all, await factories.list(workspaceId)),
  };
}

/** The list's query, as the route read it. */
export type RunsQuery = {
  /** Only runs in one of these phases; empty: any. */
  phases: readonly Phase[];
  /** Only runs started one of these ways; empty: any. */
  triggers: readonly RunTrigger[];
  factoryId: string | null;
  teamId: string | null;
  automation: string | null;
  /** Only runs the caller started. */
  mine: boolean;
  q: string | null;
  /** The page before's `nextCursor`. */
  cursor: string | null;
  limit: number;
};

/** What the filters offer: what the caller sees, whatever the query's filters. */
export type RunFacets = {
  factories: Array<{ id: string; name: string; teamId: string; latestVersion: number }>;
  teams: Array<{ id: string; name: string }>;
  automations: Array<{ factoryId: string; name: string }>;
};

export type RunsListing =
  | {
      kind: 'listed';
      runs: RunSummary[];
      nextCursor: string | null;
      counts: PhaseCounts;
      facets: RunFacets;
    }
  | Pending
  /** The cursor is not one the list handed out. */
  | { kind: 'invalid-cursor' };

/**
 * A page of the top-level runs the caller sees, newest first, with how many each phase holds
 * under the same filters (but the phases, the cursor and the limit) and what the filters offer.
 * A factory or team the caller does not see narrows the page to nothing, never to an error.
 */
export async function listRuns(
  teams: TeamStore,
  factories: FactoryStore,
  runs: RunStore,
  caller: Caller,
  query: RunsQuery,
): Promise<RunsListing> {
  const after = query.cursor === null ? null : decodeCursor(query.cursor);
  if (query.cursor !== null && after === null) return { kind: 'invalid-cursor' };
  const { workspaceId } = caller;
  if (!(await teams.holdsWorkspace(workspaceId))) return WORKSPACE_PENDING;

  const seen = await seenBy(teams, factories, caller);
  const facets: RunFacets = {
    factories: seen.factories.map(({ id, name, teamId, latestVersion }) => ({
      id,
      name,
      teamId,
      latestVersion,
    })),
    teams: seen.teams.map(({ id, name }) => ({ id, name })),
    automations:
      seen.factories.length === 0
        ? []
        : await runs.automations(
            workspaceId,
            seen.factories.map((factory) => factory.id),
          ),
  };

  const factoryIds = seen.factories
    .filter((factory) => query.factoryId === null || factory.id === query.factoryId)
    .filter((factory) => query.teamId === null || factory.teamId === query.teamId)
    .map((factory) => factory.id);
  if (factoryIds.length === 0) {
    return { kind: 'listed', runs: [], nextCursor: null, counts: NO_RUNS, facets };
  }

  const filter: RunFilter = {
    factoryIds,
    triggers: query.triggers,
    automation: query.automation,
    startedBy: query.mine ? caller.personId : null,
    q: query.q === null || query.q.trim() === '' ? null : query.q.trim(),
  };
  const page = await runs.list(workspaceId, filter, {
    phases: query.phases,
    after,
    limit: query.limit,
  });
  return {
    kind: 'listed',
    runs: page.runs,
    nextCursor: page.next === null ? null : encodeCursor(page.next),
    counts: await runs.count(workspaceId, filter),
    facets,
  };
}

export type RunRead =
  | ({ kind: 'found' } & Omit<RunFound, 'steps'> & {
        steps: StepSummary[];
        source: RunSource | null;
        approval: RunApproval | null;
      })
  | Pending
  | { kind: 'not-found' };

/** A run the caller sees, with its factory as they see it now, or why there is none for them. */
type Seen = { found: RunFound; factory: Factory; team: Team };

/**
 * The run, if the caller sees it: its factory is one they see. Its factory's owning team is the
 * one that may answer its approval.
 */
async function seenRun(
  teams: TeamStore,
  factories: FactoryStore,
  runs: RunStore,
  caller: Caller,
  runId: string,
): Promise<Seen | null> {
  const found = await runs.get(caller.workspaceId, runId);
  if (!found) return null;
  const seen = await seenBy(teams, factories, caller);
  const factory = seen.factories.find((candidate) => candidate.id === found.run.factory.id);
  const team = factory && seen.teams.find((candidate) => candidate.id === factory.teamId);
  return factory && team ? { found, factory, team } : null;
}

/**
 * The automation an automation run ran, as the factory version it executed defines it, and the
 * file behind it; null for a request (its orchestrator has no file in the cell yet), and when the
 * version does not define the automation (a run recorded against files it did not come from).
 */
async function automationOf(
  factories: FactoryStore,
  workspaceId: string,
  seen: Seen,
): Promise<{ automation: Automation; file: ReturnType<typeof sourceOf> } | null> {
  const { run } = seen.found;
  if (run.automation === null) return null;
  const version = await factories.version(workspaceId, run.factory.id, run.factory.version);
  const automation = version
    ? automationsOf(version.files).find((candidate) => candidate.name === run.automation)
    : undefined;
  if (!version || !automation) return null;
  const file = sourceOf(automation, version.files, version.version, seen.factory.latestVersion);
  return { automation, file };
}

/** The run's approval, as `approvalOf` words it, with the answer its version has. */
async function approvalFor(
  runs: RunStore,
  workspaceId: string,
  seen: Seen,
  automation: Automation | null,
  personId: string,
): Promise<RunApproval | null> {
  const { run } = seen.found;
  return approvalOf({
    run: approvalRunOf(run),
    automation,
    team: seen.team,
    personId,
    answer: await runs.answerOf(workspaceId, run.id, run.factory.version),
  });
}

const approvalRunOf = (run: RunSummary): ApprovalRun => ({
  kind: run.kind,
  status: run.status,
  automation: run.automation,
  version: run.factory.version,
});

/**
 * One run the caller sees, with its steps, each with what it was asked and its lines in the file
 * behind the run, that file, its approval while it waits for one or once it is answered, and a
 * request's facts and the runs it started.
 */
export async function readRun(
  teams: TeamStore,
  factories: FactoryStore,
  runs: RunStore,
  caller: Caller,
  runId: string,
): Promise<RunRead> {
  const { workspaceId } = caller;
  if (!(await teams.holdsWorkspace(workspaceId))) return WORKSPACE_PENDING;
  const seen = await seenRun(teams, factories, runs, caller, runId);
  if (!seen) return { kind: 'not-found' };
  const { found } = seen;
  const read = await automationOf(factories, workspaceId, seen);
  const steps = found.steps.map((step) => ({
    ...step,
    definition: read
      ? stepDefinitionOf(
          read.automation,
          step.id,
          found.run.factory.version,
          read.file?.stepLines.get(step.id) ?? null,
        )
      : null,
  }));
  return {
    kind: 'found',
    ...found,
    steps,
    source: read?.file?.source ?? null,
    approval: await approvalFor(runs, workspaceId, seen, read?.automation ?? null, caller.personId),
  };
}

export type ApprovalAnswering =
  | { kind: 'answered'; approval: RunApproval }
  | Pending
  | { kind: 'not-found' }
  /** The caller sees the run, but is not on its factory's owning team. */
  | { kind: 'not-allowed' }
  /** The run is not waiting for approval. */
  | { kind: 'not-waiting' }
  /** The version the caller answers is not the run's. */
  | { kind: 'version-moved' }
  /** The run's version has an answer: the first one stands. */
  | { kind: 'already-answered' };

/**
 * Records the caller's answer to a run waiting for approval, at the version they were shown.
 * Anyone on the run's factory's owning team may answer (`mayAnswer`), and the first answer for a
 * version stands. The cell records it and does not change the run: its runner acts on it.
 *
 * In the order it checks: whether the cell holds the workspace, whether the caller sees the run
 * (`not-found`, so a member of another team learns nothing), whether they are on its team, then
 * `judgeAnswer`'s waiting and version, then the store's first answer.
 */
export async function answerRunApproval(
  teams: TeamStore,
  factories: FactoryStore,
  runs: RunStore,
  caller: Caller,
  runId: string,
  input: { decision: ApprovalChoice; version: number },
): Promise<ApprovalAnswering> {
  const { workspaceId, personId } = caller;
  if (!(await teams.holdsWorkspace(workspaceId))) return WORKSPACE_PENDING;
  const seen = await seenRun(teams, factories, runs, caller, runId);
  if (!seen) return { kind: 'not-found' };
  const judged = judgeAnswer(approvalRunOf(seen.found.run), seen.team, personId, input.version);
  if (judged !== 'allowed') return { kind: judged };

  const answer = await runs.answer(workspaceId, runId, {
    version: input.version,
    decision: DECISION_OF[input.decision],
    personId,
  });
  if (typeof answer === 'string') return { kind: answer };
  const read = await automationOf(factories, workspaceId, seen);
  const approval = approvalOf({
    run: approvalRunOf(seen.found.run),
    automation: read?.automation ?? null,
    team: seen.team,
    personId,
    answer,
  });
  if (!approval) throw new Error(`run ${runId} was answered but asks for no approval`);
  return { kind: 'answered', approval };
}

export type RunRecordAnswer =
  | { kind: 'recorded' }
  | { kind: 'invalid'; problems: RunProblem[] }
  | { kind: Exclude<RunRecording, 'recorded'> };

/**
 * Records a run a runner reports for a workspace, if `checkRun` finds nothing wrong with it. No
 * person calls it: the seed and the tests do now, and a runner's connection will.
 */
export async function recordRun(
  runs: RunStore,
  workspaceId: string,
  run: RunWrite,
): Promise<RunRecordAnswer> {
  const checked = checkRun(run);
  if (!checked.ok) return { kind: 'invalid', problems: checked.problems };
  return { kind: await runs.record(workspaceId, checked.run) };
}
