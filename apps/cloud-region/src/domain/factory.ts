import type { WorkspaceRole } from '@consola/cloud-contract';
import { MAX_FACTORY_TEXT_BYTES, parseFactory, storedFactoryFiles } from '@consola/factory-spec';
import type { Automation, FactoryNotice, FactorySpecIssue } from '@consola/factory-spec';
import { teamsSeenBy } from './team.js';
import type { Team } from './team.js';

/**
 * A workspace's factories, held in its region's cell: a name, the team that owns it, where its
 * files come from, and its files, versioned. Each save of the files is a new version, numbered
 * from 1, and every earlier version stays readable. A factory is made blank: its first version
 * holds no files.
 *
 * The files are the factory folder's, in the format `packages/factory-spec` defines
 * (`factory.yml`, `automations/<name>.yaml`, `agents/<name>.md`, `skills/<name>/…`), each a path
 * inside the folder and its text. A set is stored only when factory-spec's parser finds no issue
 * in it, so the cell holds no version a runner would refuse to load.
 *
 * Who sees a factory follows its team (decided 2026-11-21): a person sees the factories of the
 * teams they see (`teamsSeenBy`), so owners and admins see every factory and a member the
 * factories of the teams they are in. Whoever sees a factory may save its files and rename it, and
 * may make one for any team they see, or move one they see to it.
 */

/** Where a factory's files come from. Only stored here, for now; a repo's comes with 9.4. */
export type FactorySource = { kind: 'stored' };

/** A factory as the cell holds it, without its files. */
export type Factory = {
  /** The factory's id, which the cell gives it. */
  readonly id: string;
  readonly name: string;
  /** The team that owns it, which always exists: a team that owns a factory is not deleted. */
  readonly teamId: string;
  readonly source: FactorySource;
  /** Its latest version's number: 1 for a factory whose files were never saved. */
  readonly latestVersion: number;
  /** When its latest version was saved, as an ISO 8601 time. */
  readonly updatedAt: string;
};

/** One file of a factory: its path inside the factory's folder, and its text. */
export type FactoryFile = { readonly path: string; readonly content: string };

/** One version of a factory's files, as saved. */
export type FactoryVersion = {
  readonly factoryId: string;
  readonly version: number;
  /** When it was saved, as an ISO 8601 time. */
  readonly savedAt: string;
  /** The global id of the person who saved it. */
  readonly savedBy: string;
  /** Its files, by path. */
  readonly files: FactoryFile[];
};

/** A problem with a set of files, in factory-spec's shape: `file` names the file it is in. */
export type FactoryIssue = FactorySpecIssue;

export type { FactoryNotice };

/** The longest a factory's name may be, in characters, once trimmed. */
export const FACTORY_NAME_MAX = 64;

export const FACTORY_NAME_PROBLEMS = ['name_missing', 'name_too_long', 'name_invalid'] as const;

/** Why a factory's name is refused. */
export type FactoryNameProblem = (typeof FACTORY_NAME_PROBLEMS)[number];

/** A control character: a line break, a tab, an escape. */
const CONTROL = /\p{Cc}/u;

/**
 * A factory's name, trimmed, when it is one: between 1 and `FACTORY_NAME_MAX` characters, with no
 * control character in it. Every problem is named at once. Names are unique in a workspace
 * whatever their case, which the cell's store holds (`name-taken`).
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

/** The most files a factory holds. */
export const FACTORY_FILES_MAX = 500;

/** The most a factory's files hold together, in bytes of UTF-8. */
export const FACTORY_BYTES_MAX = 8 * 1024 * 1024;

/** The longest a file's path may be, in characters. */
export const FACTORY_PATH_MAX = 256;

/** A UTF-16 surrogate with no partner, which no UTF-8 text can hold. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * A path inside a factory's folder: segments joined by `/`, none empty, `.` or `..` (so it neither
 * starts nor ends with `/`), no `\`, no control character, at most `FACTORY_PATH_MAX` characters.
 */
function isFactoryPath(path: string): boolean {
  if (path.length > FACTORY_PATH_MAX || path.includes('\\') || CONTROL.test(path)) return false;
  if (LONE_SURROGATE.test(path)) return false;
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

const utf8 = new TextEncoder();

const MEGABYTE = 1024 * 1024;

const setIssue = (message: string): FactoryIssue => ({ message, path: '' });
const fileIssue = (file: string, message: string): FactoryIssue => ({ message, file, path: '' });

/**
 * What is wrong with the set itself, before any file is parsed: too many files or bytes, a path
 * that is no path inside a factory or is given twice, and a file the cell cannot store as it was
 * sent (over `MAX_FACTORY_TEXT_BYTES`, the most factory-spec reads of one file; a NUL, which a
 * database text cannot hold; or a lone surrogate, which no UTF-8 can).
 */
function setIssues(files: readonly FactoryFile[]): FactoryIssue[] {
  if (files.length > FACTORY_FILES_MAX) {
    return [setIssue(`A factory holds at most ${FACTORY_FILES_MAX} files.`)];
  }
  const issues: FactoryIssue[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const { path, content } of files) {
    const bytes = utf8.encode(content).length;
    total += bytes;
    if (!isFactoryPath(path)) {
      issues.push(
        fileIssue(
          path,
          `\`${path}\` is not a path inside a factory: name it like \`agents/reviewer.md\`, with no empty, \`.\` or \`..\` part.`,
        ),
      );
      continue;
    }
    if (seen.has(path)) {
      issues.push(fileIssue(path, `\`${path}\` is given twice.`));
      continue;
    }
    seen.add(path);
    if (bytes > MAX_FACTORY_TEXT_BYTES) {
      const most = MAX_FACTORY_TEXT_BYTES / MEGABYTE;
      issues.push(fileIssue(path, `\`${path}\` is over ${most} MB, the most a file may hold.`));
    } else if (content.includes('\u0000')) {
      issues.push(fileIssue(path, `\`${path}\` holds a NUL character, which text cannot hold.`));
    } else if (LONE_SURROGATE.test(content)) {
      issues.push(fileIssue(path, `\`${path}\` is not valid text: it holds a lone surrogate.`));
    }
  }
  if (total > FACTORY_BYTES_MAX) {
    issues.unshift(
      setIssue(`A factory holds at most ${FACTORY_BYTES_MAX / MEGABYTE} MB of files.`),
    );
  }
  return issues;
}

/** What checking a set of files found. */
export type FilesCheck =
  /** The set may be stored. `notices` are what factory-spec tells about it that refuses nothing. */
  | { ok: true; notices: FactoryNotice[] }
  /** It may not: every issue found, each naming its file where it has one. */
  | { ok: false; issues: FactoryIssue[] };

/**
 * Whether a set of files may be stored as a version of a factory. The set itself is checked
 * first (`setIssues`); only a set with no problem of its own is parsed, with factory-spec's
 * `parseFactory`, which checks every file and the references across them (a step's agent, an
 * agent's skills, a name defined twice). Any issue refuses the set. No files at all is a set too:
 * a blank factory.
 */
export function checkFactoryFiles(files: readonly FactoryFile[]): FilesCheck {
  const issues = setIssues(files);
  if (issues.length > 0) return { ok: false, issues };
  const parsed = parseFactory(storedFactoryFiles(files));
  if (parsed.issues.length > 0) return { ok: false, issues: parsed.issues };
  return { ok: true, notices: parsed.notices };
}

/**
 * The factories a person sees: those of the teams they see (`teamsSeenBy`), so every factory for
 * owners and admins, and for a member the factories of the teams they are in.
 */
export function factoriesSeenBy(
  person: { personId: string; role: WorkspaceRole },
  teams: readonly Team[],
  factories: readonly Factory[],
): Factory[] {
  const seen = new Set(teamsSeenBy(person, teams).map((team) => team.id));
  return factories.filter((factory) => seen.has(factory.teamId));
}

/** A change to a factory: a new name, a new owning team, or both. What it leaves out stays. */
export type FactoryChange = { readonly name?: string; readonly teamId?: string };

/**
 * Whether a person may make a change to a factory, as making one is judged: they must see the
 * factory (`not-found` when not, so a member learns nothing of another team's), and a move must
 * be to a team they see as well (`team-not-found` when not), so owners and admins may move it to
 * any team and a member only to a team they are in. Whoever sees a factory may rename it.
 */
export function judgeFactoryChange(
  person: { personId: string; role: WorkspaceRole },
  teams: readonly Team[],
  factory: Factory,
  change: FactoryChange,
): 'allowed' | 'not-found' | 'team-not-found' {
  const seen = new Set(teamsSeenBy(person, teams).map((team) => team.id));
  if (!seen.has(factory.teamId)) return 'not-found';
  if (change.teamId !== undefined && !seen.has(change.teamId)) return 'team-not-found';
  return 'allowed';
}

/**
 * The automations a stored version's files define, wherever each is written (`factory.yml` or
 * `automations/<name>.yaml`, named in its `file`), as factory-spec's parser reads the folder.
 * A version was stored only once it parsed clean, so this finds what was checked then.
 */
export function automationsOf(files: readonly FactoryFile[]): Automation[] {
  return parseFactory(storedFactoryFiles(files)).automations;
}
