import type { Refusal } from './refusal';
import type { components } from './apiContract';
import type { FactoryIssue } from './factoryProblems';
import type { Team } from './teams';

/**
 * A workspace's factories as the web app sees them. They live in the API,
 * which is the authority on every rule here, and on who sees what: owners and admins see every
 * factory, a member the factories of the teams they are in. The page never filters what the
 * API lists. It keeps its own copy of the name rule, to check a name before sending it, and
 * offers as owners only the teams the API lists for the person (`GET /api/teams`), which are
 * exactly the teams the API lets them make or move a factory for.
 */

export type Factory = components['schemas']['Factory'];

/** Where a factory's files come from, as the API names it. */
export type FactorySourceKind = Factory['source']['kind'];

/** What the API names as a problem with a factory's name. */
export type FactoryNameProblem = components['schemas']['InvalidFactory']['problems'][number];

/** A problem with a new factory: its name's, or no team chosen to own it. */
export type NewFactoryProblem = FactoryNameProblem | 'team_missing';

/** Every problem the API names; `factoryMessages.ts` has a sentence for each, keyed by the type. */
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
 * A factory's name, trimmed, when the API would take it: 1 to `FACTORY_NAME_MAX` characters
 * with no control character. Every problem is named at once. Whether another factory has the
 * name is the API's to say (`name-taken`).
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
 * A new factory, when the API would take it: a good name and one of `teams` to own it. A team
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
 * The team that owns `factory`, among those the API lists for the person, or null. The API
 * lists every team that owns a factory the person sees, so null is only a list read between a
 * change and the next load.
 */
export function owningTeam(factory: Factory, teams: readonly Team[]): Team | null {
  return teams.find((team) => team.id === factory.teamId) ?? null;
}

/**
 * Whether moving `factory` to `teamId` is a move the page sends: to one of the teams the API
 * lists for the person, and not the one that owns it now.
 */
export function isMove(factory: Factory, teamId: string, teams: readonly Team[]): boolean {
  return teamId !== factory.teamId && teams.some((team) => team.id === teamId);
}

/**
 * Where a factory's files can come from, in the order the page offers them. Only `stored` is
 * one the API has; a GitHub repository comes later (9.4), so it is shown, and not offered.
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
      /** Exactly what the API lists for the person, in its order: by name. */
      factories: Factory[];
      /**
       * The teams the API lists for the person: every team for owners and admins, the teams they
       * are in for a member. They name each factory's team, and they are the teams create and
       * move offer.
       */
      teams: Team[];
    }
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
  | { kind: 'switched' }
  | { kind: 'signed-out' }
  | { kind: 'unavailable' };

/** A factory's version of its files, as saved. */
export type FactoryVersion = components['schemas']['FactoryVersion'];

export type FactoryFile = components['schemas']['FactoryFile'];

/**
 * Ready-made factory files a person can start from (`GET /api/factory-templates`), such as the
 * code review team: they join a factory's files as unsaved changes (`withFiles`), and reach the
 * API only through the ordinary save, which checks them as any other files.
 */
export type FactoryTemplate = components['schemas']['FactoryTemplate'];

/** What reading the templates came to. */
export type TemplatesAnswer = { kind: 'listed'; templates: FactoryTemplate[] } | Refusal;

/** What reading one factory with its latest version's files came to. */
export type FactoryRead =
  | { kind: 'found'; factory: Factory; version: FactoryVersion }
  /** The factory is gone, or now belongs to a team the person is not in. */
  | { kind: 'not-found' }
  | { kind: 'switched' }
  | { kind: 'signed-out' }
  | { kind: 'unavailable' };

/** What saving a factory's files as its next version came to. */
export type FactorySave =
  /** Saved: the version the API stored. */
  | { kind: 'saved'; version: FactoryVersion }
  /** The API found the files break the factory schema: every issue. Nothing was saved. */
  | { kind: 'invalid'; issues: FactoryIssue[] }
  /** Someone saved a newer version since the files were read. Nothing was saved. */
  | { kind: 'version-moved'; latestVersion: number }
  /** More than any factory's files can hold. Nothing was saved. */
  | { kind: 'too-large' }
  /** The factory is gone, or now belongs to a team the person is not in. */
  | { kind: 'not-found' }
  | { kind: 'switched' }
  | { kind: 'signed-out' }
  | { kind: 'unavailable' };

/** The folders a factory's files sit in, in the order a factory folder is read. */
const FOLDER_ORDER = ['automations', 'agents', 'skills'];

/** A file in the tree, named inside its folder (or its skill). */
export type FileEntry = { path: string; name: string };

/** A skill's files, under its folder's name: its `SKILL.md` first, then the rest by name. */
export type SkillGroup = { skill: string; files: FileEntry[] };

/**
 * A factory's files under one folder (null for the folder's own top), each named inside it. A
 * skill's files sit one level deeper, under their skill (`skills`).
 */
export type FileGroup = {
  folder: string | null;
  files: FileEntry[];
  skills: SkillGroup[];
};

/**
 * A factory's files grouped as its folder holds them: the files at its top (`factory.yml`)
 * first, then `automations/`, `agents/` and `skills/`, then any other folder by name. Each file
 * is named by its path inside its folder, a skill's inside its skill (`refs/queries.md` under
 * `triage`), and listed by it. With `formatFolders`, the format's three folders are listed even
 * when they hold nothing, so the tree shows where each kind of file goes.
 */
export function fileGroups(
  files: ReadonlyArray<{ path: string }>,
  { formatFolders = false }: { formatFolders?: boolean } = {},
): FileGroup[] {
  const byFolder = new Map<string | null, FileGroup>();
  const groupOf = (folder: string | null) => {
    const group = byFolder.get(folder) ?? { folder, files: [], skills: [] };
    byFolder.set(folder, group);
    return group;
  };
  if (formatFolders) for (const folder of FOLDER_ORDER) groupOf(folder);
  for (const { path } of files) {
    const slash = path.indexOf('/');
    const folder = slash > 0 ? path.slice(0, slash) : null;
    const name = slash > 0 ? path.slice(slash + 1) : path;
    const group = groupOf(folder);
    const inSkill = folder === 'skills' ? /^([^/]+)\/(.+)$/.exec(name) : null;
    if (!inSkill?.[1] || !inSkill[2]) {
      group.files.push({ path, name });
      continue;
    }
    const skillName = inSkill[1];
    let skill = group.skills.find((candidate) => candidate.skill === skillName);
    if (!skill) {
      skill = { skill: skillName, files: [] };
      group.skills.push(skill);
    }
    skill.files.push({ path, name: inSkill[2] });
  }
  const rank = (folder: string | null) => {
    if (folder === null) return -1;
    const known = FOLDER_ORDER.indexOf(folder);
    return known === -1 ? FOLDER_ORDER.length : known;
  };
  const byName = (a: FileEntry, b: FileEntry) => a.name.localeCompare(b.name);
  const skillFirst = (a: FileEntry, b: FileEntry) =>
    Number(b.name === 'SKILL.md') - Number(a.name === 'SKILL.md') || byName(a, b);
  return [...byFolder.values()]
    .sort(
      (a, b) => rank(a.folder) - rank(b.folder) || (a.folder ?? '').localeCompare(b.folder ?? ''),
    )
    .map((group) => ({
      folder: group.folder,
      files: group.files.sort(byName),
      skills: group.skills
        .sort((a, b) => a.skill.localeCompare(b.skill))
        .map((skill) => ({ skill: skill.skill, files: skill.files.sort(skillFirst) })),
    }));
}

/** Every file of the groups, in the order the tree lists them. */
export function listedFiles(groups: readonly FileGroup[]): FileEntry[] {
  return groups.flatMap((group) => [
    ...group.files,
    ...group.skills.flatMap((skill) => skill.files),
  ]);
}

/** The file a factory's definition opens on: `factory.yml`, else the first as they are listed. */
export function firstFile(groups: readonly FileGroup[]): string | null {
  const all = listedFiles(groups);
  return (all.find((file) => file.path === 'factory.yml') ?? all[0])?.path ?? null;
}
