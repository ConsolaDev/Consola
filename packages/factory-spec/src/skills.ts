/**
 * `skills/<name>/`: what a skill folder may hold, and its hash.
 *
 * A skill is instructions and files only. It is delivered unchanged to a
 * step's CLI, so everything that would let it do more than that is refused
 * here, each with its reason: hooks (which run even in a read-only session),
 * `allowed-tools` (which would widen what the step may call), any key outside
 * the Agent Skills standard's, a command run when the skill loads (`` !` ``, or
 * a fenced block that opens with `!`, in `SKILL.md` or any supporting file
 * that is text), two paths that are one file where case or accents are
 * ignored, and anything but regular files and folders.
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
const SKILL_KEYS = new Set(['name', 'description', 'license', 'compatibility', 'metadata']);
const REFUSED_SKILL_KEYS: Readonly<Record<string, string>> = {
  hooks:
    "A skill's hooks run even in a read-only session: skills here are instructions and files only.",
  'allowed-tools':
    '`allowed-tools` would widen what the step may call: name servers and tools in the agent file.',
};
/**
 * What a skill's loader runs as a command, in either form: inline, the two
 * characters `!` and a backtick; or a fenced block whose opening fence (three
 * or more backticks or tildes) is followed on its line by `!`.
 */
const INLINE_COMMAND = '!`';
const FENCED_COMMAND = /^[ \t]*(?:`{3,}|~{3,})[ \t]*!/m;

/**
 * The extensions that make a supporting file text whatever its bytes, so it
 * is scanned for a command at load even when it is not valid UTF-8. Compared
 * lowercased. A file with none of them is scanned when it is valid UTF-8; one
 * that is neither is a binary (an image, a PDF, a font), which no CLI loads
 * as instructions, and is not scanned.
 */
export const SKILL_TEXT_EXTENSIONS: readonly string[] = [
  'md',
  'markdown',
  'mdx',
  'txt',
  'text',
  'rst',
  'adoc',
  'sh',
  'bash',
  'zsh',
  'fish',
  'ps1',
  'bat',
  'cmd',
  'py',
  'rb',
  'pl',
  'php',
  'lua',
  'r',
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'mts',
  'cts',
  'tsx',
  'go',
  'rs',
  'java',
  'kt',
  'swift',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'cs',
  'sql',
  'json',
  'jsonc',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'env',
  'xml',
  'html',
  'htm',
  'css',
  'svg',
  'csv',
  'tsv',
  'tex',
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isFile = (entry: SkillFileEntry): entry is { path: string; bytes: Uint8Array } =>
  'bytes' in entry;
const byPath = (a: { path: string }, b: { path: string }) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/**
 * A path as a filesystem that ignores case and accents (macOS's, by default)
 * sees it: NFC, then case-folded. Upper- then lower-casing also folds `ß`
 * into `ss` and a final sigma into `σ`, as full case folding does.
 */
const foldPath = (path: string) =>
  path.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');

/** A path inside the folder, as tokens: no empty, `.` or `..` segment, no `\`, no NUL, not absolute. */
function isInsidePath(path: string): boolean {
  if (path.includes('\\') || path.includes('\0')) return false;
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

const isValidUtf8 = (bytes: Uint8Array): boolean => {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
};

/** Its extension, lowercased, is one of `SKILL_TEXT_EXTENSIONS`. */
const hasTextExtension = (path: string): boolean => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 && SKILL_TEXT_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase());
};

/**
 * Whether a file of the skill is scanned for a command at load: one with a
 * text extension (`SKILL.md` always, by its own), or one that is valid
 * UTF-8. Only a binary, invalid UTF-8 with no text extension, is not.
 */
function scannedAsText(path: string, bytes: Uint8Array): boolean {
  return hasTextExtension(path) || isValidUtf8(bytes);
}

/**
 * Why a file would run a command when the skill loads, or `undefined`. A
 * file that is scanned is read as text leniently (a byte that is not UTF-8
 * reads as U+FFFD), so no text file escapes the scan by holding one.
 */
function commandAtLoad(path: string, bytes: Uint8Array): string | undefined {
  const text = new TextDecoder('utf-8').decode(bytes);
  if (text.includes(INLINE_COMMAND)) {
    return `A skill may not run commands when it loads: \`${path}\` holds !\`.`;
  }
  if (FENCED_COMMAND.test(text)) {
    return `A skill may not run commands when it loads: \`${path}\` has a fenced block that opens with !.`;
  }
  return undefined;
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

  // Paths are compared as a filesystem that ignores case and accents sees them, so the file a
  // CLI loads is always the one checked here: two spellings of one file, or a file where another
  // entry puts a folder, are refused rather than either one taken.
  const folded = new Map<string, string>();
  let skillNamed = 0;
  const files: Array<{ path: string; bytes: Uint8Array }> = [];
  for (const entry of entries) {
    if (!isInsidePath(entry.path)) {
      folderIssue(`\`${entry.path}\` is not a path inside the skill's folder.`);
      continue;
    }
    const key = foldPath(entry.path);
    if (key === 'skill.md') skillNamed += 1;
    const earlier = folded.get(key);
    if (earlier !== undefined) {
      folderIssue(
        `\`${at(earlier)}\` and \`${at(entry.path)}\` name the same file where case or accents are ignored, as on macOS: rename one.`,
      );
      continue;
    }
    folded.set(key, entry.path);
    if (isFile(entry)) files.push(entry);
    else {
      issues.push({
        file: at(entry.path),
        path: '',
        message: `\`${at(entry.path)}\` is a symlink or a special file; a skill holds regular files and folders only.`,
      });
    }
  }
  if (entries.length > MAX_SKILL_FILES) {
    folderIssue(`A skill holds at most ${MAX_SKILL_FILES} files.`);
  }
  const total = files.reduce((sum, entry) => sum + entry.bytes.length, 0);
  if (total > MAX_SKILL_BYTES) folderIssue('A skill holds at most 2 MB.');

  for (const [key, path] of folded) {
    const segments = key.split('/');
    for (let length = 1; length < segments.length; length++) {
      const file = folded.get(segments.slice(0, length).join('/'));
      if (file !== undefined) {
        folderIssue(
          `\`${at(file)}\` is a file, and \`${at(path)}\` puts a folder in its place: rename one.`,
        );
      }
    }
  }

  // Exactly one entry is SKILL.md however case is read, and it is spelled so. Nothing is read from
  // SKILL.md otherwise: with two, which one a CLI would load is not known.
  const spelled = folded.get('skill.md');
  if (spelled === undefined) {
    folderIssue(`${where} has no SKILL.md.`);
    return { issues };
  }
  if (skillNamed > 1) return { issues };
  if (spelled !== 'SKILL.md') {
    folderIssue(`\`${at(spelled)}\` is SKILL.md spelled another way: name it \`SKILL.md\`.`);
    return { issues };
  }
  const skillFile = files.find((entry) => entry.path === 'SKILL.md');
  // A SKILL.md that is a symlink or a special file is refused above, once.
  if (!skillFile) return { issues };

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
        } else if (!SKILL_KEYS.has(key)) {
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
        if (key in front && typeof front[key] !== 'string') {
          frontIssue(`Expected \`${key}\` to be text.`, key, lineOf(key));
        }
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

  // A command at load: anywhere in SKILL.md, its frontmatter included, and in every supporting text file.
  for (const entry of [...files].sort(byPath)) {
    if (!scannedAsText(entry.path, entry.bytes)) continue;
    const problem = commandAtLoad(at(entry.path), entry.bytes);
    if (problem) issues.push({ file: at(entry.path), path: '', message: problem });
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
