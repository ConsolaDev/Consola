import type { components as cell } from './cellApiContract';
import type { FactoryIssue } from './factoryProblems';
import type { Team } from './teams';

/**
 * A workspace's factories as the web app sees them. They live in the workspace's regional cell,
 * which is the authority on every rule here, and on who sees what: owners and admins see every
 * factory, a member the factories of the teams they are in. The page never filters what the
 * cell lists. It keeps its own copy of the name rule, to check a name before sending it, and
 * offers as owners only the teams the cell lists for the person (`GET /api/teams`), which are
 * exactly the teams the cell lets them make or move a factory for.
 */

export type Factory = cell['schemas']['Factory'];

/** Where a factory's files come from, as the cell names it. */
export type FactorySourceKind = Factory['source']['kind'];

/** What the cell names as a problem with a factory's name. */
export type FactoryNameProblem = cell['schemas']['InvalidFactory']['problems'][number];

/** A problem with a new factory: its name's, or no team chosen to own it. */
export type NewFactoryProblem = FactoryNameProblem | 'team_missing';

/** Every problem the cell names; `factoryMessages.ts` has a sentence for each, keyed by the type. */
const NAME_PROBLEMS: Record<FactoryNameProblem, true> = {
  name_missing: true,
  name_too_long: true,
  name_invalid: true,
};

export function isFactoryNameProblem(value: unknown): value is FactoryNameProblem {
  return typeof value === 'string' && Object.hasOwn(NAME_PROBLEMS, value);
}

/** The longest a factory's name may be, in characters, once trimmed. */
export const FACTORY_NAME_MAX = 64;

const CONTROL = /\p{Cc}/u;

/**
 * A factory's name, trimmed, when the cell would take it: 1 to `FACTORY_NAME_MAX` characters
 * with no control character. Every problem is named at once. Whether another factory has the
 * name is the cell's to say (`name-taken`).
 */
export function checkFactoryName(
  name: string,
): { ok: true; name: string } | { ok: false; problems: FactoryNameProblem[] } {
  const trimmed = name.trim();
  if (trimmed === '') return { ok: false, problems: ['name_missing'] };
  const problems: FactoryNameProblem[] = [];
  if ([...trimmed].length > FACTORY_NAME_MAX) problems.push('name_too_long');
  if (CONTROL.test(trimmed)) problems.push('name_invalid');
  return problems.length === 0 ? { ok: true, name: trimmed } : { ok: false, problems };
}

/** The create form as the person has filled it. `teamId` is null until a team is chosen. */
export type FactoryDraft = { name: string; teamId: string | null };

/**
 * A new factory's draft before anything is typed: no name, and the team chosen for the person
 * when there is only one they could choose.
 */
export function newFactoryDraft(teams: readonly Team[]): FactoryDraft {
  const [only, ...others] = teams;
  return { name: '', teamId: only && others.length === 0 ? only.id : null };
}

/**
 * A new factory, when the cell would take it: a good name and one of `teams` to own it. A team
 * the person no longer sees counts as none chosen.
 */
export function checkNewFactory(
  draft: FactoryDraft,
  teams: readonly Team[],
):
  | { ok: true; factory: { name: string; teamId: string } }
  | { ok: false; problems: NewFactoryProblem[] } {
  const name = checkFactoryName(draft.name);
  const problems: NewFactoryProblem[] = name.ok ? [] : [...name.problems];
  const team = teams.find((listed) => listed.id === draft.teamId);
  if (!team) problems.push('team_missing');
  if (!name.ok || !team) return { ok: false, problems };
  return { ok: true, factory: { name: name.name, teamId: team.id } };
}

/**
 * The team that owns `factory`, among those the cell lists for the person, or null. The cell
 * lists every team that owns a factory the person sees, so null is only a list read between a
 * change and the next load.
 */
export function owningTeam(factory: Factory, teams: readonly Team[]): Team | null {
  return teams.find((team) => team.id === factory.teamId) ?? null;
}

/**
 * Whether moving `factory` to `teamId` is a move the page sends: to one of the teams the cell
 * lists for the person, and not the one that owns it now.
 */
export function isMove(factory: Factory, teamId: string, teams: readonly Team[]): boolean {
  return teamId !== factory.teamId && teams.some((team) => team.id === teamId);
}

/**
 * Where a factory's files can come from, in the order the page offers them. Only `stored` is
 * one the cell has; a GitHub repository comes later (9.4), so it is shown, and not offered.
 */
export type SourceOption =
  | { kind: FactorySourceKind; available: true }
  | { kind: 'github'; available: false };

export const SOURCE_OPTIONS: readonly SourceOption[] = [
  { kind: 'stored', available: true },
  { kind: 'github', available: false },
];

/** The factories the page shows, the teams they belong to, and the teams it may offer. */
export type FactoriesState =
  | {
      kind: 'listed';
      /** Exactly what the cell lists for the person, in its order: by name. */
      factories: Factory[];
      /**
       * The teams the cell lists for the person: every team for owners and admins, the teams they
       * are in for a member. They name each factory's team, and they are the teams create and
       * move offer.
       */
      teams: Team[];
    }
  /** The cell does not hold the workspace yet: `cloud-global` is still telling it. */
  | { kind: 'pending' }
  /** The session's workspace is not the one the page shows: another tab switched it. */
  | { kind: 'switched' }
  | { kind: 'signed-out' }
  | { kind: 'unavailable' };

/** What making, renaming or moving a factory came to. */
export type FactoryChange =
  | { kind: 'changed'; factory: Factory }
  | { kind: 'invalid'; problems: FactoryNameProblem[] }
  | { kind: 'name-taken' }
  /** The team is gone, or the person no longer sees it. */
  | { kind: 'team-not-found' }
  /** The factory is gone, or now belongs to a team the person is not in. */
  | { kind: 'factory-not-found' }
  | { kind: 'pending' }
  | { kind: 'switched' }
  | { kind: 'signed-out' }
  | { kind: 'unavailable' };

/** A factory's version of its files, as saved. */
export type FactoryVersion = cell['schemas']['FactoryVersion'];

export type FactoryFile = cell['schemas']['FactoryFile'];

/** What reading one factory with its latest version's files came to. */
export type FactoryRead =
  | { kind: 'found'; factory: Factory; version: FactoryVersion }
  /** The factory is gone, or now belongs to a team the person is not in. */
  | { kind: 'not-found' }
  | { kind: 'pending' }
  | { kind: 'switched' }
  | { kind: 'signed-out' }
  | { kind: 'unavailable' };

/** What saving a factory's files as its next version came to. */
export type FactorySave =
  /** Saved: the version the cell stored. */
  | { kind: 'saved'; version: FactoryVersion }
  /** The cell found the files break the factory schema: every issue. Nothing was saved. */
  | { kind: 'invalid'; issues: FactoryIssue[] }
  /** Someone saved a newer version since the files were read. Nothing was saved. */
  | { kind: 'version-moved'; latestVersion: number }
  /** More than any factory's files can hold. Nothing was saved. */
  | { kind: 'too-large' }
  /** The factory is gone, or now belongs to a team the person is not in. */
  | { kind: 'not-found' }
  | { kind: 'pending' }
  | { kind: 'switched' }
  | { kind: 'signed-out' }
  | { kind: 'unavailable' };

/** The folders a factory's files sit in, in the order a factory folder is read. */
const FOLDER_ORDER = ['automations', 'agents', 'skills'];

/** A factory's files under one folder (null for the folder's own top), each named inside it. */
export type FileGroup = {
  folder: string | null;
  files: { path: string; name: string }[];
};

/**
 * A factory's files grouped as its folder holds them: the files at its top (`factory.yml`)
 * first, then `automations/`, `agents/` and `skills/`, then any other folder by name. Each file
 * is named by its path inside its folder (`release/SKILL.md` under `skills`), and listed by it.
 */
export function fileGroups(files: readonly { path: string }[]): FileGroup[] {
  const byFolder = new Map<string | null, { path: string; name: string }[]>();
  for (const { path } of files) {
    const slash = path.indexOf('/');
    const folder = slash > 0 ? path.slice(0, slash) : null;
    const name = slash > 0 ? path.slice(slash + 1) : path;
    const group = byFolder.get(folder) ?? [];
    group.push({ path, name });
    byFolder.set(folder, group);
  }
  const rank = (folder: string | null) => {
    if (folder === null) return -1;
    const known = FOLDER_ORDER.indexOf(folder);
    return known === -1 ? FOLDER_ORDER.length : known;
  };
  return [...byFolder.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || (a ?? '').localeCompare(b ?? ''))
    .map(([folder, grouped]) => ({
      folder,
      files: grouped.sort((a, b) => a.name.localeCompare(b.name)),
    }));
}

/** Every path in the order the file list shows them (`fileGroups`), folder by folder. */
export function listedPaths(paths: readonly string[]): string[] {
  return fileGroups(paths.map((path) => ({ path }))).flatMap((group) =>
    group.files.map((file) => file.path),
  );
}

/** The file a factory's definition opens on: `factory.yml`, else the first as they are listed. */
export function firstFile(groups: readonly FileGroup[]): string | null {
  const all = groups.flatMap((group) => group.files);
  return (all.find((file) => file.path === 'factory.yml') ?? all[0])?.path ?? null;
}
