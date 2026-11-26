import type { components as cell } from './cellApiContract';

/**
 * What is wrong with a factory's files, wherever it was found: by the page's own check as the
 * person edits (`factoryCheck.ts`, factory-spec's parser in the browser) or in the cell's answer
 * to a save (`invalid_files`). Both speak factory-spec's issues, so they read alike. This module
 * is light on purpose: it does not import the parser, so the page can say a cell's answer
 * without loading it.
 */

/** A problem with the files, as the factory schema words it. */
export type FactoryProblem = {
  message: string;
  /** The file it is in, as the folder names it (`agents/reviewer.md`); null for the set itself. */
  file: string | null;
  /** Its line in that file, from 1; null when it is not known. */
  line: number | null;
  /**
   * The file, or skill's folder, whose own problem this one only shows through: a step naming an
   * agent with problems, an agent naming such a skill. It is counted there, never here.
   */
  cause: string | null;
};

/** An issue as the cell answers one. */
export type FactoryIssue = cell['schemas']['FactoryIssue'];

/** A problem, from an issue in factory-spec's shape (the parser's or the cell's). */
export function problemOf(issue: {
  message: string;
  file?: string;
  path?: string;
  line?: number;
  cause?: string;
}): FactoryProblem {
  return {
    message: issue.message,
    file: issue.file ?? null,
    line: typeof issue.line === 'number' && issue.line >= 1 ? issue.line : null,
    cause: issue.cause ?? null,
  };
}

/**
 * The file among `paths` a problem shows on: its own file, or, for a skill's folder
 * (`skills/release`), that skill's `SKILL.md`, else its first file. Null for a problem with the
 * set itself, or one about a file the set does not hold.
 */
export function problemPath(problem: FactoryProblem, paths: readonly string[]): string | null {
  const { file } = problem;
  if (file === null) return null;
  if (paths.includes(file)) return file;
  const folder = `${file.replace(/\/+$/, '')}/`;
  const inside = paths.filter((path) => path.startsWith(folder));
  return inside.find((path) => path === `${folder}SKILL.md`) ?? inside[0] ?? null;
}

/**
 * How many problems each file has of its own, by path. A problem that only shows another file's
 * (`cause`) is not counted on the file it shows on, as factory-spec counts it at its cause.
 */
export function problemCounts(
  problems: readonly FactoryProblem[],
  paths: readonly string[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const problem of problems) {
    if (problem.cause !== null) continue;
    const path = problemPath(problem, paths);
    if (path !== null) counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  return counts;
}

/** The problems a person has to fix before saving: every one but those shown through another's. */
export function ownProblems(problems: readonly FactoryProblem[]): FactoryProblem[] {
  return problems.filter((problem) => problem.cause === null);
}

/**
 * The problems as the panel lists them: the set's own first, then by file in the order `paths`
 * lists the files, then by line (a problem with no line first in its file).
 */
export function sortedProblems(
  problems: readonly FactoryProblem[],
  paths: readonly string[],
): FactoryProblem[] {
  const rank = (problem: FactoryProblem) => {
    const path = problemPath(problem, paths);
    return path === null ? -1 : paths.indexOf(path);
  };
  return [...problems].sort(
    (a, b) =>
      rank(a) - rank(b) || (a.line ?? 0) - (b.line ?? 0) || (a.cause ? 1 : 0) - (b.cause ? 1 : 0),
  );
}

/** A problem's words as text and code: what sits between backticks is code. */
export type MessagePart = { text: string; code: boolean };

/** Splits a problem's message on its backticks, so the page can set code as code. */
export function messageParts(message: string): MessagePart[] {
  const parts = message.split('`');
  if (parts.length % 2 === 0) {
    // An odd number of backticks leaves the last one unmatched: it, and what follows, is text.
    const rest = parts.pop() ?? '';
    parts[parts.length - 1] += `\`${rest}`;
  }
  return parts
    .map((text, index) => ({ text, code: index % 2 === 1 }))
    .filter((part) => part.text !== '');
}
