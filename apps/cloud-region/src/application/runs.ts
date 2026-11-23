import type { WorkspaceRole } from '@consola/cloud-contract';
import type { Caller } from '../domain/caller.js';
import { automationsOf, type Factory, factoriesSeenBy } from '../domain/factory.js';
import {
  checkRun,
  decodeCursor,
  encodeCursor,
  NO_RUNS,
  type Phase,
  type PhaseCounts,
  type RunProblem,
  type RunSummary,
  type RunTrigger,
  type RunWrite,
  type StepDefinition,
  type StepSummary,
  stepDefinitionOf,
} from '../domain/run.js';
import { actingRole, type Team, teamsSeenBy } from '../domain/team.js';
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
  factories: { id: string; name: string; teamId: string; latestVersion: number }[];
  teams: { id: string; name: string }[];
  automations: { factoryId: string; name: string }[];
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
  | ({ kind: 'found' } & Omit<RunFound, 'steps'> & { steps: StepSummary[] })
  | Pending
  | { kind: 'not-found' };

/**
 * What each of an automation run's steps was asked, by step id: its definition in the factory
 * version the run executed. None for a request (its orchestrator's step is no automation's), nor
 * when the version holds no such automation (a run recorded against files it did not come from),
 * and a step the automation does not define has none.
 */
async function definitionsOf(
  factories: FactoryStore,
  workspaceId: string,
  run: RunFound['run'],
): Promise<Map<string, StepDefinition>> {
  const definitions = new Map<string, StepDefinition>();
  if (run.automation === null) return definitions;
  const version = await factories.version(workspaceId, run.factory.id, run.factory.version);
  const automation = version
    ? automationsOf(version.files).find((candidate) => candidate.name === run.automation)
    : undefined;
  for (const step of automation?.steps ?? []) {
    const definition = stepDefinitionOf(
      automation as NonNullable<typeof automation>,
      step.id,
      run.factory.version,
    );
    if (definition) definitions.set(step.id, definition);
  }
  return definitions;
}

/**
 * One run the caller sees, with its steps, each with what it was asked, and a request's facts
 * and the runs it started.
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
  const found = await runs.get(workspaceId, runId);
  if (!found) return { kind: 'not-found' };
  const seen = await seenBy(teams, factories, caller);
  if (!seen.factories.some((factory) => factory.id === found.run.factory.id)) {
    return { kind: 'not-found' };
  }
  const definitions = await definitionsOf(factories, workspaceId, found.run);
  const steps = found.steps.map((step) => ({
    ...step,
    definition: definitions.get(step.id) ?? null,
  }));
  return { kind: 'found', ...found, steps };
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
