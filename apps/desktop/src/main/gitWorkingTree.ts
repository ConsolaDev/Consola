import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { countUntrackedLines, readUntrackedFile } from './untrackedLines';

/**
 * A checkout's working tree as the explorer, header and review panel see it:
 * status, per-file diffs, staging and committing.
 *
 * File names come from the repository and commit messages from the person, so
 * neither may ever reach a shell. Every git call here passes an argument list,
 * and paths are literal, never patterns.
 */

export type GitFileStatus = 'staged' | 'modified' | 'untracked' | 'deleted';

export interface GitStatusResult {
  files: Array<{ path: string; status: GitFileStatus }>;
  stats: { modifiedCount: number; addedLines: number; removedLines: number };
  isGitRepo: boolean;
  branch: string | null;
}

export interface GitDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: Array<{
    type: 'context' | 'add' | 'remove';
    content: string;
    oldLineNumber?: number;
    newLineNumber?: number;
  }>;
}

export interface GitDiffResult {
  filePath: string;
  staged: boolean;
  oldContent: string;
  newContent: string;
  hunks: GitDiffHunk[];
  isBinary: boolean;
  isNew: boolean;
  isDeleted: boolean;
}

/** Node's own default, kept for everything but file contents. */
const DEFAULT_OUTPUT = 1024 * 1024;
const CONTENT_OUTPUT = 10 * 1024 * 1024;

interface GitRun {
  error: Error | null;
  stdout: string;
  stderr: string;
}

/**
 * git with an argument list, run without a shell, so `$(…)`, backticks and
 * quotes in a name or message stay text. `--literal-pathspecs` makes every
 * path mean that one file: otherwise git reads `app/[slug]/page.tsx` as a
 * pattern, and staging it also stages `app/s/page.tsx`.
 */
function git(cwd: string, args: string[], maxBuffer = DEFAULT_OUTPUT): Promise<GitRun> {
  return new Promise((resolve) => {
    execFile('git', ['--literal-pathspecs', ...args], { cwd, maxBuffer }, (error, stdout, stderr) =>
      resolve({ error, stdout, stderr })
    );
  });
}

/** What to tell the person when git refuses: its own words, wherever it put them. */
function gitError(run: GitRun & { error: Error }): string {
  return run.stderr.trim() || run.stdout.trim() || run.error.message;
}

/**
 * `git status --porcelain -z` output, read as the panel's four statuses.
 *
 * -z rather than line output: that quotes any name holding a space, a quote
 * or a non-ASCII letter (`"caf\303\251.md"`), and writes a rename as
 * `old -> new`, so names read from it are not the names on disk. With -z each
 * entry is `XY <path>`, verbatim, and a rename or copy is followed by one more
 * field holding the path it came from.
 */
export function parseStatus(output: string): GitStatusResult['files'] {
  const files: GitStatusResult['files'] = [];
  const fields = output.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    const indexStatus = entry[0];
    const workingStatus = entry[1];
    const filePath = entry.slice(3);
    if ('RC'.includes(indexStatus) || 'RC'.includes(workingStatus)) i++;

    // First column = index (staged), second column = working tree.
    if (indexStatus === '?' && workingStatus === '?') {
      files.push({ path: filePath, status: 'untracked' });
    } else if (indexStatus === 'D' || workingStatus === 'D') {
      files.push({ path: filePath, status: 'deleted' });
    } else if (indexStatus !== ' ' && indexStatus !== '?') {
      // Staged changes (A, M, R, C in index)
      files.push({ path: filePath, status: 'staged' });
    } else if (workingStatus === 'M') {
      files.push({ path: filePath, status: 'modified' });
    }
  }
  return files;
}

export async function readStatus(rootPath: string): Promise<GitStatusResult> {
  if (!fs.existsSync(path.join(rootPath, '.git'))) {
    return { files: [], stats: { modifiedCount: 0, addedLines: 0, removedLines: 0 }, isGitRepo: false, branch: null };
  }

  const head = await git(rootPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = !head.error && head.stdout ? head.stdout.trim() : null;

  const status = await git(rootPath, ['status', '--porcelain', '-z', '-uall']);
  const files = status.error ? [] : parseStatus(status.stdout);

  let addedLines = 0;
  let removedLines = 0;
  for (const args of [['diff', '--numstat'], ['diff', '--cached', '--numstat']]) {
    const diff = await git(rootPath, args);
    if (diff.error) continue;
    for (const line of diff.stdout.split('\n').filter(Boolean)) {
      const [added, removed] = line.split('\t').map((n) => parseInt(n, 10));
      if (!isNaN(added)) addedLines += added;
      if (!isNaN(removed)) removedLines += removed;
    }
  }
  // Neither diff above sees untracked files, which the file list does include.
  const untracked = files.filter((f) => f.status === 'untracked').map((f) => f.path);
  addedLines += await countUntrackedLines(rootPath, untracked);

  return { files, stats: { modifiedCount: files.length, addedLines, removedLines }, isGitRepo: true, branch };
}

export async function readDiff(rootPath: string, filePath: string, staged: boolean): Promise<GitDiffResult> {
  const absolutePath = path.join(rootPath, filePath);
  const fileExists = fs.existsSync(absolutePath);
  const nothing = { filePath, staged, oldContent: '', newContent: '', hunks: [], isBinary: false };

  if (!staged) {
    const tracked = await git(rootPath, ['ls-files', '--error-unmatch', '--', filePath]);
    if (tracked.error) {
      if (!fileExists) return { ...nothing, isNew: true, isDeleted: true };
      // Read in full, unless binary by the rules the header's line count
      // uses. One that exists but cannot be read shows as binary.
      const file = await readUntrackedFile(rootPath, filePath);
      return {
        ...nothing,
        newContent: file?.content ?? '',
        isBinary: file?.isBinary ?? true,
        isNew: true,
        isDeleted: false,
      };
    }
  }

  const diff = await git(rootPath, ['diff', ...(staged ? ['--cached'] : []), '--', filePath], CONTENT_OUTPUT);
  if (diff.error || !diff.stdout) return { ...nothing, isNew: false, isDeleted: !fileExists };
  if (diff.stdout.includes('Binary files')) return { ...nothing, isBinary: true, isNew: false, isDeleted: false };

  // Old content from HEAD for a staged diff, from the index otherwise.
  const old = await git(rootPath, ['show', staged ? `HEAD:${filePath}` : `:${filePath}`], CONTENT_OUTPUT);
  let newContent = '';
  if (staged) {
    const indexed = await git(rootPath, ['show', `:${filePath}`], CONTENT_OUTPUT);
    newContent = indexed.error ? '' : indexed.stdout;
  } else if (fileExists) {
    newContent = await fs.promises.readFile(absolutePath, 'utf-8').catch(() => '');
  }

  return {
    filePath,
    staged,
    oldContent: old.error ? '' : old.stdout,
    newContent,
    hunks: parseDiffHunks(diff.stdout),
    isBinary: false,
    isNew: old.error !== null,
    isDeleted: !fileExists,
  };
}

export async function stageFile(rootPath: string, filePath: string): Promise<void> {
  const add = await git(rootPath, ['add', '--', filePath]);
  if (add.error) throw new Error(gitError({ ...add, error: add.error }));
}

export async function unstageFile(rootPath: string, filePath: string): Promise<void> {
  const reset = await git(rootPath, ['reset', 'HEAD', '--', filePath]);
  if (!reset.error) return;
  // Before the first commit there is no HEAD to reset to: drop it from the index.
  const remove = await git(rootPath, ['rm', '--cached', '--', filePath]);
  if (remove.error) throw new Error(remove.stderr.trim() || gitError({ ...reset, error: reset.error }));
}

export async function commit(rootPath: string, message: string): Promise<{ success: boolean; error?: string }> {
  const run = await git(rootPath, ['commit', '-m', message]);
  return run.error ? { success: false, error: gitError({ ...run, error: run.error }) } : { success: true };
}

function parseDiffHunks(diffOutput: string): GitDiffHunk[] {
  const hunks: GitDiffHunk[] = [];
  let currentHunk: GitDiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of diffOutput.split('\n')) {
    // Parse hunk header: @@ -oldStart,oldLines +newStart,newLines @@
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      if (currentHunk) hunks.push(currentHunk);
      currentHunk = {
        oldStart: parseInt(hunkMatch[1], 10),
        oldLines: parseInt(hunkMatch[2] || '1', 10),
        newStart: parseInt(hunkMatch[3], 10),
        newLines: parseInt(hunkMatch[4] || '1', 10),
        lines: [],
      };
      oldLine = currentHunk.oldStart;
      newLine = currentHunk.newStart;
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith('+') && !line.startsWith('+++')) {
      currentHunk.lines.push({ type: 'add', content: line.slice(1), newLineNumber: newLine++ });
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      currentHunk.lines.push({ type: 'remove', content: line.slice(1), oldLineNumber: oldLine++ });
    } else if (line.startsWith(' ')) {
      currentHunk.lines.push({
        type: 'context',
        content: line.slice(1),
        oldLineNumber: oldLine++,
        newLineNumber: newLine++,
      });
    }
  }

  if (currentHunk) hunks.push(currentHunk);
  return hunks;
}
