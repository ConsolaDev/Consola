import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Files a worktree removal would destroy that git does not count as changes.
 *
 * `git worktree remove` refuses a dirty tree, but ignored files are not dirt
 * to git: a hand-edited `.env`, a local database, a notes file someone put in
 * `.gitignore`. Ported from Orca's `worktree-at-risk-local-files.ts`: an
 * ignored file is safe only when the main checkout has an identical copy,
 * rebuildable folders never count, and a check cut short by its budget is an
 * answer of "unknown", which keeps the worktree.
 */

/** Folders a package manager or build recreates. Never a reason to keep a worktree. */
export const REGENERABLE_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  'bower_components',
  '.pnpm-store',
  '.yarn',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.angular',
  '.expo',
  '.output',
  '.vite',
  '.turbo',
  '.parcel-cache',
  '.cache',
  'target',
  '.gradle',
  '.dart_tool',
  'Pods',
  'vendor',
  '_build',
  '.terraform',
  'DerivedData',
  '.build',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  'coverage',
  '.nyc_output',
  // A run's own checkout's package caches (slice 3-B): Consola points npm and pnpm there.
  '.consola-cache',
]);

/** Files the OS or a tool drops and nobody misses. */
const DISPOSABLE_FILE_NAMES: ReadonlySet<string> = new Set([
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  '.eslintcache',
]);
const DISPOSABLE_FILE_SUFFIXES = ['.pyc', '.pyo', '.tsbuildinfo', '.log'];

export interface LocalFileBudget {
  deadlineMs: number;
  /** Paths `git ls-files` may list before the listing counts as incomplete. */
  listedPaths: number;
  /** Files and folders looked at, across every listed path. */
  visitedEntries: number;
  comparedBytes: number;
  comparedFileBytes: number;
}

export const DEFAULT_LOCAL_FILE_BUDGET: LocalFileBudget = {
  deadlineMs: 8_000,
  listedPaths: 5_000,
  visitedEntries: 1_000,
  comparedBytes: 32 * 1024 * 1024,
  comparedFileBytes: 4 * 1024 * 1024,
};

/** What would be lost. `complete: false` means the check ran out of budget: keep. */
export interface AtRiskFiles {
  count: number;
  /** Up to 200, `.env` files first, then shallowest. */
  paths: string[];
  complete: boolean;
}

export type GitRun = (
  cwd: string,
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

type Verdict = 'saved' | 'unsaved' | 'unknown';

export async function ignoredAtRisk(
  git: GitRun,
  tree: string,
  mainRepo: string | null,
  budget: LocalFileBudget = DEFAULT_LOCAL_FILE_BUDGET,
  now: () => number = Date.now,
): Promise<AtRiskFiles> {
  const deadline = now() + budget.deadlineMs;
  const listed = await git(tree, [
    'ls-files',
    '-z',
    '--others',
    '--ignored',
    '--exclude-standard',
    '--directory',
    '--no-empty-directory',
  ]);
  if (listed.code !== 0) return { count: 0, paths: [], complete: false };
  const all = listed.stdout
    .split('\0')
    .filter(Boolean)
    .map((entry) => entry.replace(/\/$/, ''))
    .filter((entry) => !entry.split('/').some((part) => REGENERABLE_DIRECTORY_NAMES.has(part)));
  let complete = all.length <= budget.listedPaths;
  const entries = all.slice(0, budget.listedPaths);
  if (entries.length === 0) return { count: 0, paths: [], complete };

  const atRisk: string[] = [];
  if (!mainRepo || mainRepo === tree) {
    return finish(entries, complete);
  }

  let visited = 0;
  let bytes = 0;
  const realTree = realpathOr(tree);

  const judgeFile = async (relative: string, stats: fs.Stats): Promise<Verdict> => {
    if (isDisposable(relative)) return 'saved';
    const copy = path.join(mainRepo, relative);
    let copyStats: fs.Stats;
    try {
      copyStats = await fs.promises.lstat(copy);
    } catch {
      return 'unsaved';
    }
    if (copyStats.isSymbolicLink()) {
      // A main-checkout link that points back into the worktree is no copy at all.
      const target = realpathOr(copy);
      if (isWithin(target, realTree)) return 'unsaved';
      try {
        copyStats = await fs.promises.stat(copy);
      } catch {
        return 'unsaved';
      }
    }
    if (!copyStats.isFile() || copyStats.size !== stats.size) return 'unsaved';
    if (stats.size > budget.comparedFileBytes || bytes + stats.size > budget.comparedBytes) {
      return 'unknown';
    }
    bytes += stats.size;
    return (await sameBytes(path.join(tree, relative), copy)) ? 'saved' : 'unsaved';
  };

  /** Every unsaved path below `relative` goes into `atRisk`. */
  const judge = async (relative: string): Promise<Verdict> => {
    if (now() > deadline || ++visited > budget.visitedEntries) return 'unknown';
    let stats: fs.Stats;
    try {
      stats = await fs.promises.lstat(path.join(tree, relative));
    } catch {
      return 'saved'; // Gone since the listing: nothing left to lose.
    }
    // Removal unlinks a symlink and leaves what it points at alone.
    if (stats.isSymbolicLink()) return 'saved';
    if (stats.isDirectory()) {
      let children: fs.Dirent[];
      try {
        children = await fs.promises.readdir(path.join(tree, relative), { withFileTypes: true });
      } catch {
        return 'unknown';
      }
      let verdict: Verdict = 'saved';
      for (const child of children) {
        if (child.isDirectory() && REGENERABLE_DIRECTORY_NAMES.has(child.name)) continue;
        const childVerdict = await judge(path.join(relative, child.name));
        if (childVerdict === 'unknown') return 'unknown';
        if (childVerdict === 'unsaved') verdict = 'unsaved';
      }
      return verdict;
    }
    if (!stats.isFile()) return 'unsaved';
    const verdict = await judgeFile(relative, stats);
    if (verdict === 'unsaved') atRisk.push(relative);
    return verdict;
  };

  for (const entry of entries) {
    const verdict = await judge(entry);
    if (verdict === 'unknown') {
      complete = false;
      break;
    }
  }
  return finish(atRisk, complete);
}

function finish(paths: string[], complete: boolean): AtRiskFiles {
  const sorted = [...paths].sort((a, b) => {
    const envA = isEnvFile(a) ? 0 : 1;
    const envB = isEnvFile(b) ? 0 : 1;
    if (envA !== envB) return envA - envB;
    const depth = a.split(path.sep).length - b.split(path.sep).length;
    return depth !== 0 ? depth : a.localeCompare(b);
  });
  return { count: sorted.length, paths: sorted.slice(0, 200), complete };
}

function isEnvFile(relative: string): boolean {
  return path.basename(relative).startsWith('.env');
}

function isDisposable(relative: string): boolean {
  const name = path.basename(relative);
  return (
    DISPOSABLE_FILE_NAMES.has(name) ||
    DISPOSABLE_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix))
  );
}

async function sameBytes(a: string, b: string): Promise<boolean> {
  try {
    const [left, right] = await Promise.all([fs.promises.readFile(a), fs.promises.readFile(b)]);
    return left.equals(right);
  } catch {
    return false;
  }
}

/** Repositories inside the tree: a `.git` file or folder below its root. */
export interface NestedRepos {
  paths: string[];
  complete: boolean;
}

/**
 * A bounded walk for `.git` entries below the root. A repository nested in a
 * worktree holds its own history and changes, which nothing in the outer
 * repository knows about (T3 Code lost uncommitted work in one).
 */
export async function nestedRepos(
  tree: string,
  limits: { directories: number; deadlineMs: number } = { directories: 20_000, deadlineMs: 5_000 },
  now: () => number = Date.now,
): Promise<NestedRepos> {
  const deadline = now() + limits.deadlineMs;
  const found: string[] = [];
  const queue: string[] = [''];
  let visited = 0;
  while (queue.length > 0) {
    if (now() > deadline || ++visited > limits.directories)
      return { paths: found, complete: false };
    const relative = queue.shift()!;
    let children: fs.Dirent[];
    try {
      children = await fs.promises.readdir(path.join(tree, relative), { withFileTypes: true });
    } catch {
      if (relative === '') return { paths: found, complete: false };
      continue;
    }
    for (const child of children) {
      if (child.name === '.git') {
        if (relative !== '') found.push(relative);
        continue;
      }
      if (child.isDirectory() && !REGENERABLE_DIRECTORY_NAMES.has(child.name)) {
        queue.push(path.join(relative, child.name));
      }
    }
  }
  return { paths: found, complete: true };
}

function realpathOr(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
