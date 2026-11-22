/**
 * `skills/<name>/`: what a skill folder may hold, and its hash.
 *
 * A skill is instructions and files only. It is delivered unchanged to a
 * step's CLI, so everything that would let it do more than that is refused
 * here, each with its reason: hooks (which run even in a read-only session),
 * `allowed-tools` (which would widen what the step may call), any key outside
 * the Agent Skills standard's, a command run when the skill loads (`` !` ``),
 * and anything but regular files and folders.
 */
import { createHash } from 'node:crypto';
import { readFrontmatter, splitFrontmatter } from './frontmatter';
import type { FactorySpecIssue } from './issues';
import { stableStringify } from './run';
import { AUTOMATION_NAME_PATTERN } from './schema';

export const MAX_SKILL_FILES = 100;
export const MAX_SKILL_BYTES = 2 * 1024 * 1024;
const MAX_DESCRIPTION_CHARS = 1024;

/** One entry of a skill's folder, by its path inside the folder: a regular file's bytes, or what it is instead. */
export type SkillFileEntry =
  | { path: string; bytes: Uint8Array }
  | { path: string; kind: 'symlink' | 'special' };

export interface SkillDefinition {
  name: string;
  description: string;
  /** Every file, sorted by path. */
  files: Array<{ path: string; bytes: Uint8Array }>;
  /** `skillHash(files)`. */
  hash: string;
}

const NO_FRONTMATTER =
  'SKILL.md starts with its frontmatter between two `---` lines, holding `name` and `description`.';
const SKILL_KEYS = ['name', 'description', 'license', 'compatibility', 'metadata'];
const REFUSED_SKILL_KEYS: Readonly<Record<string, string>> = {
  hooks:
    "A skill's hooks run even in a read-only session: skills here are instructions and files only.",
  'allowed-tools':
    '`allowed-tools` would widen what the step may call: name servers and tools in the agent file.',
};
/** What a skill's loader runs as a command: the two characters `!` and a backtick. */
const COMMAND_AT_LOAD = '!`';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isFile = (entry: SkillFileEntry): entry is { path: string; bytes: Uint8Array } =>
  'bytes' in entry;
const byPath = (a: { path: string }, b: { path: string }) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/** A path inside the folder, as tokens: no empty, `.` or `..` segment, no `\`, no NUL, not absolute. */
function isInsidePath(path: string): boolean {
  if (path.includes('\\') || path.includes('\0')) return false;
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** The text of a file that is valid UTF-8; `undefined` for any other file, which is copied as it is and not scanned. */
function textOf(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Validate one skill folder. `entries` are its files by path inside the
 * folder (`SKILL.md`, `refs/queries.md`). `skill` is present only when there
 * are no issues. Every issue has `file`: the folder (`skills/<folder>`: its
 * name, counts, sizes, a path that leaves it, a missing `SKILL.md`), one file
 * (`skills/<folder>/<path>`), or `skills/<folder>/SKILL.md` with the key as
 * `path` for a frontmatter problem.
 */
export function parseSkill(
  folder: string,
  entries: readonly SkillFileEntry[],
): { skill?: SkillDefinition; issues: FactorySpecIssue[] } {
  const where = `skills/${folder}`;
  const at = (path: string) => `${where}/${path}`;
  if (!AUTOMATION_NAME_PATTERN.test(folder)) {
    return {
      issues: [
        {
          file: where,
          path: '',
          message: `\`${where}\`: a skill's folder name is its name: lowercase letters, digits and dashes, e.g. skills/incident-triage.`,
        },
      ],
    };
  }

  const issues: FactorySpecIssue[] = [];
  const folderIssue = (message: string) => issues.push({ file: where, path: '', message });

  const files: Array<{ path: string; bytes: Uint8Array }> = [];
  for (const entry of entries) {
    if (!isInsidePath(entry.path)) {
      folderIssue(`\`${entry.path}\` is not a path inside the skill's folder.`);
    } else if (!isFile(entry)) {
      issues.push({
        file: at(entry.path),
        path: '',
        message: `\`${at(entry.path)}\` is a symlink or a special file; a skill holds regular files and folders only.`,
      });
    } else {
      files.push(entry);
    }
  }
  if (entries.length > MAX_SKILL_FILES)
    folderIssue(`A skill holds at most ${MAX_SKILL_FILES} files.`);
  const total = files.reduce((sum, entry) => sum + entry.bytes.length, 0);
  if (total > MAX_SKILL_BYTES) folderIssue('A skill holds at most 2 MB.');

  const skillFile = files.find((entry) => entry.path === 'SKILL.md');
  if (!skillFile) {
    folderIssue(`${where} has no SKILL.md.`);
    return { issues };
  }

  const skillPath = at('SKILL.md');
  const frontIssue = (message: string, path = '', line?: number) =>
    issues.push({ file: skillPath, path, message, ...(line !== undefined ? { line } : {}) });
  // SKILL.md is read as text whatever its bytes: one that is not UTF-8 reads as U+FFFD, and is checked like any other.
  const split = splitFrontmatter(new TextDecoder('utf-8').decode(skillFile.bytes));
  let name: string | undefined;
  let description: string | undefined;
  if (split.kind !== 'ok') {
    frontIssue(NO_FRONTMATTER);
  } else {
    const read = readFrontmatter(split.yaml, split.firstLine);
    if (!read.ok) {
      for (const error of read.errors) frontIssue(error.message, '', error.line);
    } else if (!isRecord(read.value ?? {})) {
      frontIssue(NO_FRONTMATTER);
    } else {
      const front = (read.value ?? {}) as Record<string, unknown>;
      const lineOf = (key: string) => read.lineOf(key) ?? 1;
      for (const key of Object.keys(front)) {
        if (Object.prototype.hasOwnProperty.call(REFUSED_SKILL_KEYS, key)) {
          frontIssue(REFUSED_SKILL_KEYS[key], key, lineOf(key));
        } else if (!SKILL_KEYS.includes(key)) {
          frontIssue(
            `Unrecognized key in a skill: \`${key}\`; skills here are instructions and files only.`,
            key,
            lineOf(key),
          );
        }
      }
      if (front.name !== folder) {
        frontIssue(
          `Expected \`name: ${folder}\`, the skill's folder name.`,
          'name',
          lineOf('name'),
        );
      } else name = folder;
      const given = front.description;
      if (
        typeof given !== 'string' ||
        given.trim() === '' ||
        Array.from(given).length > MAX_DESCRIPTION_CHARS
      ) {
        frontIssue(
          'Expected `description`: 1 to 1,024 characters.',
          'description',
          lineOf('description'),
        );
      } else description = given;
      for (const key of ['license', 'compatibility']) {
        if (key in front && typeof front[key] !== 'string')
          frontIssue(`Expected \`${key}\` to be text.`, key, lineOf(key));
      }
      if (
        'metadata' in front &&
        !(
          isRecord(front.metadata) &&
          Object.values(front.metadata).every((value) => typeof value === 'string')
        )
      ) {
        frontIssue(
          'Expected `metadata` to be a mapping of names to text.',
          'metadata',
          lineOf('metadata'),
        );
      }
    }
  }

  // A command at load: in SKILL.md's body, and in every supporting file that is text.
  for (const entry of [...files].sort(byPath)) {
    const text =
      entry === skillFile ? (split.kind === 'ok' ? split.body : undefined) : textOf(entry.bytes);
    if (text?.includes(COMMAND_AT_LOAD)) {
      issues.push({
        file: at(entry.path),
        path: '',
        message: `A skill may not run commands when it loads: \`${at(entry.path)}\` holds !\`.`,
      });
    }
  }

  if (issues.length > 0 || name === undefined || description === undefined) return { issues };
  const sorted = [...files].sort(byPath);
  return { skill: { name, description, files: sorted, hash: skillHash(sorted) }, issues };
}

/**
 * `sha256(stableStringify([[path, sha256hex(bytes)], …]))` over the files
 * sorted by path, full hex: one byte in any file, a file added, removed or
 * renamed changes it; the order the entries come in does not.
 */
export function skillHash(files: ReadonlyArray<{ path: string; bytes: Uint8Array }>): string {
  const listed = [...files]
    .sort(byPath)
    .map((entry) => [entry.path, createHash('sha256').update(entry.bytes).digest('hex')]);
  return createHash('sha256').update(stableStringify(listed)).digest('hex');
}
