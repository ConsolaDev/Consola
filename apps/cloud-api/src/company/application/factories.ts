import type { Caller } from '../domain/caller.js';
import {
  checkFactoryFiles,
  checkFactoryName,
  factoriesSeenBy,
  judgeFactoryChange,
} from '../domain/factory.js';
import type {
  Factory,
  FactoryChange,
  FactoryFile,
  FactoryIssue,
  FactoryNameProblem,
  FactoryNotice,
  FactoryVersion,
} from '../domain/factory.js';
import { FACTORY_TEMPLATES } from '../domain/factoryTemplates.js';
import type { FactoryTemplate } from '../domain/factoryTemplates.js';
import { teamsSeenBy } from '../domain/team.js';
import type { FactoryStore, TeamStore } from './ports.js';

/*
 * A workspace's factories, for the caller a request's session names. Every use case reads and
 * writes the caller's workspace alone (`caller.workspaceId`), and judges what the caller sees by
 * their role there (`caller.role`, read for this request), the way the teams' use cases do: a
 * person sees the factories of the teams they see (`factoriesSeenBy`). Whoever sees a factory may
 * save its files and rename it; a factory they do not see is one that is not there (`not-found`),
 * so a member learns nothing of another team's factories.
 *
 * A use case answers in the order it checks: whether what was sent reads, whether the caller sees
 * the team or factory, and only then what the store finds. What the caller sees is read just
 * before the write, not in its transaction: a change applied in between is one write late, never
 * more.
 */

const NOT_FOUND = { kind: 'not-found' } as const;

/** The factory, if the caller sees it now; null when there is none, or it is not theirs to see. */
async function seenFactory(
  teams: TeamStore,
  factories: FactoryStore,
  caller: Caller,
  factoryId: string,
): Promise<Factory | null> {
  const factory = await factories.get(caller.workspaceId, factoryId);
  if (!factory) return null;
  const [seen] = factoriesSeenBy(caller, await teams.list(caller.workspaceId), [factory]);
  return seen ?? null;
}

export type FactoriesList = { kind: 'listed'; factories: Factory[] };

/**
 * The factories the caller sees: every factory for owners and admins, the factories of the
 * teams they are in for a member.
 */
export async function listFactories(
  teams: TeamStore,
  factories: FactoryStore,
  caller: Caller,
): Promise<FactoriesList> {
  const { workspaceId } = caller;
  const seen = factoriesSeenBy(
    caller,
    await teams.list(workspaceId),
    await factories.list(workspaceId),
  );
  return { kind: 'listed', factories: seen };
}

export type FactoryCreation =
  | { kind: 'created'; factory: Factory }
  | { kind: 'invalid'; problems: FactoryNameProblem[] }
  /** The workspace has no team with that id that the caller sees. */
  | { kind: 'team-not-found' }
  | { kind: 'name-taken' };

/**
 * Makes a blank factory in the caller's workspace, owned by `teamId`: its files stored here, its
 * first version holding none. The caller may make one for any team they see: any team for owners
 * and admins, a team they are in for a member.
 */
export async function createFactory(
  teams: TeamStore,
  factories: FactoryStore,
  caller: Caller,
  input: { name: string; teamId: string },
): Promise<FactoryCreation> {
  const name = checkFactoryName(input.name);
  if (!name.ok) return { kind: 'invalid', problems: name.problems };
  const { workspaceId, personId } = caller;
  const seen = teamsSeenBy(caller, await teams.list(workspaceId));
  if (!seen.some((team) => team.id === input.teamId)) return { kind: 'team-not-found' };

  const factory = await factories.create(workspaceId, {
    name: name.name,
    teamId: input.teamId,
    personId,
  });
  if (factory === 'name-taken' || factory === 'team-not-found') return { kind: factory };
  return { kind: 'created', factory };
}

export type FactoryRead =
  | { kind: 'found'; factory: Factory; version: FactoryVersion }
  | { kind: 'not-found' };

/** A factory the caller sees, with its latest version's files. */
export async function readFactory(
  teams: TeamStore,
  factories: FactoryStore,
  caller: Caller,
  factoryId: string,
): Promise<FactoryRead> {
  const factory = await seenFactory(teams, factories, caller, factoryId);
  if (!factory) return NOT_FOUND;
  // A version is never changed once saved, so the latest the factory names is read whole, even
  // if another is saved meanwhile.
  const version = await factories.version(caller.workspaceId, factory.id, factory.latestVersion);
  if (!version) throw new Error(`factory ${factory.id} has no version ${factory.latestVersion}`);
  return { kind: 'found', factory, version };
}

export type FactoryChanging =
  | { kind: 'changed'; factory: Factory }
  | { kind: 'invalid'; problems: FactoryNameProblem[] }
  | { kind: 'not-found' }
  /** The workspace has no team with that id that the caller sees, to move the factory to. */
  | { kind: 'team-not-found' }
  | { kind: 'name-taken' };

/**
 * Renames a factory the caller sees, moves it to another team they see, or both at once
 * (`judgeFactoryChange`): any team for owners and admins, a team they are in for a member. Its
 * versions stay as they are, and so do its latest version and when that was saved. A change that
 * names neither changes nothing, and answers the factory as it is.
 */
export async function changeFactory(
  teams: TeamStore,
  factories: FactoryStore,
  caller: Caller,
  factoryId: string,
  input: { name?: string; teamId?: string },
): Promise<FactoryChanging> {
  let change: FactoryChange = input.teamId === undefined ? {} : { teamId: input.teamId };
  if (input.name !== undefined) {
    const name = checkFactoryName(input.name);
    if (!name.ok) return { kind: 'invalid', problems: name.problems };
    change = { ...change, name: name.name };
  }
  const { workspaceId } = caller;
  const factory = await factories.get(workspaceId, factoryId);
  if (!factory) return NOT_FOUND;
  const judged = judgeFactoryChange(caller, await teams.list(workspaceId), factory, change);
  if (judged !== 'allowed') return { kind: judged };

  const changed = await factories.change(workspaceId, factory.id, change);
  if (typeof changed === 'string') return { kind: changed };
  return { kind: 'changed', factory: changed };
}

export type FactoryVersionRead =
  | { kind: 'found'; version: FactoryVersion }
  | { kind: 'not-found' }
  /** The factory is the caller's to see, and has no version with that number. */
  | { kind: 'version-not-found' };

/** One version of a factory the caller sees, an earlier one or the latest. */
export async function readFactoryVersion(
  teams: TeamStore,
  factories: FactoryStore,
  caller: Caller,
  factoryId: string,
  version: number,
): Promise<FactoryVersionRead> {
  const factory = await seenFactory(teams, factories, caller, factoryId);
  if (!factory) return NOT_FOUND;
  const read = await factories.version(caller.workspaceId, factory.id, version);
  return read ? { kind: 'found', version: read } : { kind: 'version-not-found' };
}

export type FactorySaving =
  | { kind: 'saved'; version: FactoryVersion; notices: FactoryNotice[] }
  /** The files fail the factory schema: every issue, each naming its file. */
  | { kind: 'invalid'; issues: FactoryIssue[] }
  | { kind: 'not-found' }
  /** The factory's latest version is no longer `baseVersion`: someone saved since. */
  | { kind: 'moved'; latestVersion: number };

/**
 * Saves `files` as the next version of a factory the caller sees, if they keep the factory schema
 * (`checkFactoryFiles`) and the factory's latest version is still `baseVersion`, the one they
 * were edited from. So a save never undoes one it did not see: the second of two saves from one
 * version is `moved`, and its files are saved again only from the latest.
 */
export async function saveFactoryFiles(
  teams: TeamStore,
  factories: FactoryStore,
  caller: Caller,
  factoryId: string,
  input: { baseVersion: number; files: readonly FactoryFile[] },
): Promise<FactorySaving> {
  const check = checkFactoryFiles(input.files);
  if (!check.ok) return { kind: 'invalid', issues: check.issues };
  const factory = await seenFactory(teams, factories, caller, factoryId);
  if (!factory) return NOT_FOUND;
  // Asked again by the store's compare-and-set, which a save in between would fail. Asked here
  // first, so a version that cannot be the latest never reaches the database.
  if (input.baseVersion !== factory.latestVersion) {
    return { kind: 'moved', latestVersion: factory.latestVersion };
  }

  const saved = await factories.save(caller.workspaceId, factory.id, {
    baseVersion: input.baseVersion,
    files: input.files,
    personId: caller.personId,
  });
  if (saved.kind !== 'saved') return saved;
  return { kind: 'saved', version: saved.version, notices: check.notices };
}

/**
 * The ready-made factory files a person can start from. Each is offered as it is written, and
 * its files reach a factory only through `saveFactoryFiles`, which checks them as any others.
 */
export function factoryTemplates(): readonly FactoryTemplate[] {
  return FACTORY_TEMPLATES;
}
