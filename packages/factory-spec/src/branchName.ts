import { sha256Hex } from './sha256';

/**
 * A branch name from an item key someone else wrote (slice 3, *The
 * run-owned checkout › The branch*; the spike's §3). A run cuts its branch
 * from `checkout.branch`, a template whose placeholders take an item's key
 * or number, or the run's id. The value is cleaned by an allow-list, never
 * escaped, and a clean that lost anything gets a hash of the original, so
 * two different keys never share a branch. The template must start with a
 * literal folder (`fix/`), so a key is only ever the last part of a name:
 * never `HEAD`, `main` or an option. Validation cannot run git (this
 * package does no I/O), so `refFormatProblem` is a pure copy of `git
 * check-ref-format --branch`'s rules, and its test asks the real git on
 * every row; the host runs git's own check again before it makes the
 * branch.
 */

/** What a branch template may name. */
export const BRANCH_PLACEHOLDERS = ['item.key', 'item.number', 'run.id'] as const;

/** The longest a cleaned value may be before its hash is added. */
const MAX_PART = 60;

/**
 * A placeholder as a template writes it, spaces allowed inside the braces,
 * which `nameOf` trims. Everything between the braces is one group, so no
 * space can be matched two ways (a lazy group beside `\s*` backtracks
 * quadratically over a long run of spaces).
 */
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

/** A placeholder's name, as written between its braces. */
const nameOf = (inside: string): string => inside.trim();

/** `part` without the dashes and dots at either end. A loop: `[-.]+$` backtracks quadratically. */
function withoutEdgeDashesAndDots(part: string): string {
  let start = 0;
  let end = part.length;
  while (start < end && (part[start] === '-' || part[start] === '.')) start++;
  while (end > start && (part[end - 1] === '-' || part[end - 1] === '.')) end--;
  return part.slice(start, end);
}

/** `part` without every `.lock` it ends with. */
function withoutLockSuffixes(part: string): string {
  let rest = part;
  while (rest.endsWith('.lock')) rest = rest.slice(0, -'.lock'.length);
  return rest;
}

function shortHash(value: string): string {
  return sha256Hex(value).slice(0, 8);
}

/** Trim `-` and `.` from both ends and strip `.lock` endings, until nothing changes. */
function trimmed(part: string): string {
  let current = part;
  for (;;) {
    const next = withoutLockSuffixes(withoutEdgeDashesAndDots(current));
    if (next === current) return current;
    current = next;
  }
}

/**
 * NFKC; runs outside `[A-Za-z0-9._-]` become `-`; `..` becomes `.` and `--`
 * becomes `-`; `-` and `.` are trimmed from both ends and `.lock` endings
 * stripped (repeatedly); cut at 60 and trimmed again. Empty: `item-<8 hex of
 * sha256(value)>`. Changed at all: `<clean>-<8 hex of sha256(value)>`.
 */
export function cleanBranchPart(value: string): string {
  const allowed = value
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-');
  const clean = trimmed(trimmed(allowed).slice(0, MAX_PART));
  if (clean === '') return `item-${shortHash(value)}`;
  return clean === value ? clean : `${clean}-${shortHash(value)}`;
}

export interface BranchValues {
  itemKey?: string;
  itemNumber?: number;
  runId: string;
}

/**
 * The branch a run cuts: each placeholder's value through `cleanBranchPart`
 * (`{{run.id}}`: its first 8 characters), the literal text as written.
 * Throws on a placeholder it has no value for, which `branchTemplateProblem`
 * and the entry's checks keep from reaching a run.
 */
export function renderBranch(template: string, values: BranchValues): string {
  return template.replace(PLACEHOLDER, (_whole, inside: string) => {
    const name = nameOf(inside);
    if (name === 'item.key') {
      if (values.itemKey === undefined) throw new Error('This run has no item.key for its branch.');
      return cleanBranchPart(values.itemKey);
    }
    if (name === 'item.number') {
      if (values.itemNumber === undefined) {
        throw new Error('This run has no item.number for its branch.');
      }
      return cleanBranchPart(String(values.itemNumber));
    }
    if (name === 'run.id') return cleanBranchPart(values.runId.slice(0, 8));
    throw new Error(`A branch takes no {{${name}}}.`);
  });
}

/** Characters no ref may hold (`git check-ref-format`, rules 4, 5 and 10). */
const REFUSED_CHARACTERS = /[\u0000-\u0020\u007f~^:?*[\\]/;

/**
 * `git check-ref-format --branch`'s rules, pure: null when git would take
 * `name` as a branch, else why not. A branch is not `HEAD`, does not start
 * with `-` and is not `@`; no component is empty (nor is the name),
 * starts with `.` or ends with `.lock`; no `..`, `@{`, control character,
 * space, `~ ^ : ? * [ \`; it does not end with `/` or `.`.
 */
export function refFormatProblem(name: string): string | null {
  if (name === 'HEAD') return '`HEAD` is not a branch name';
  if (name === '@') return '`@` alone is not a ref';
  if (name.startsWith('-')) return 'it starts with `-`';
  if (REFUSED_CHARACTERS.test(name)) {
    return 'it holds a space, a control character or one of `~ ^ : ? * [ \\`';
  }
  if (name.includes('..')) return 'it holds `..`';
  if (name.includes('@{')) return 'it holds `@{`';
  if (name.endsWith('.')) return 'it ends with `.`';
  for (const component of name.split('/')) {
    if (component === '') return 'it has an empty folder (a leading, trailing or double `/`)';
    if (component.startsWith('.')) return 'a part of it starts with `.`';
    if (component.endsWith('.lock')) return 'a part of it ends with `.lock`';
  }
  return null;
}

/** The placeholders a template names, in order (`item.key`, …), as written between the braces. */
export function branchPlaceholderNames(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((match) => nameOf(match[1]));
}

/** The values a template is checked with: an item `SHOP-42`, number 42, run `3f2a91c0`. */
const SAMPLE: BranchValues = { itemKey: 'SHOP-42', itemNumber: 42, runId: '3f2a91c0' };

const ONLY_PLACEHOLDERS = 'A branch takes only `{{item.key}}`, `{{item.number}}` and `{{run.id}}`.';

/**
 * Why `checkout.branch` is refused, in the words the format says, or null:
 * its placeholders only `{{item.key}}`, `{{item.number}}` and `{{run.id}}`
 * (no stray braces); the text before the first placeholder holds a `/`
 * after at least one character, so the name starts with a literal folder;
 * and a sample render passes `refFormatProblem`.
 */
export function branchTemplateProblem(template: string): string | null {
  const names = branchPlaceholderNames(template);
  const rest = template.replace(PLACEHOLDER, '');
  if (rest.includes('{{') || rest.includes('}}')) return ONLY_PLACEHOLDERS;
  if (names.some((name) => !(BRANCH_PLACEHOLDERS as readonly string[]).includes(name))) {
    return ONLY_PLACEHOLDERS;
  }
  const first = template.search(PLACEHOLDER);
  const literal = first === -1 ? template : template.slice(0, first);
  if (literal.indexOf('/') < 1) {
    return "A branch starts with a literal folder, e.g. `fix/{{item.key}}`, so an item's key is only ever its last part.";
  }
  const sample = renderBranch(template, SAMPLE);
  return refFormatProblem(sample) === null
    ? null
    : `\`${template}\` makes a branch name git refuses (\`${sample}\`).`;
}
