import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { parseLsofFields } from '../lsofFields';

/** A process whose working directory was read. */
export interface ProcessEntry {
  pid: number;
  ppid?: number;
  command: string;
  cwd: string;
}

/** Every process's working directory at one moment, or `unknown` when it could not be read. */
export type ProcessSnapshot = { kind: 'ok'; entries: ProcessEntry[] } | { kind: 'unknown' };

/** What a snapshot says about one folder. `unknown` keeps a worktree, like any fact Consola cannot read. */
export type ProcessesInTree =
  | { kind: 'none' }
  | { kind: 'present'; processes: Array<Pick<ProcessEntry, 'pid' | 'command'>> }
  | { kind: 'unknown' };

const SNAPSHOT_TIMEOUT_MS = 10_000;

type Run = (
  binary: string,
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * Which processes run inside a folder: one `lsof` of every process's working
 * directory per sweep, filtered per tree.
 *
 * A removal must never pull a folder out from under a dev server, a watcher or
 * an agent's background job (T3 Code lost a running job this way). `lsof` is
 * how macOS and Linux answer that cheaply. Anything that stops it answering —
 * a missing binary, a timeout, Windows — reads as `unknown`, and an unknown
 * keeps the worktree.
 */
export class ProcessCwdIndex {
  constructor(
    private readonly run: Run = runCommand,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  public async snapshot(): Promise<ProcessSnapshot> {
    if (this.platform === 'win32') return { kind: 'unknown' };
    const [cwds, parents] = await Promise.all([
      this.run('lsof', ['-a', '-d', 'cwd', '-F', 'pcn']),
      this.run('ps', ['-A', '-o', 'pid=,ppid=']),
    ]);
    // lsof exits 1 when it could not read some process it was not allowed
    // to: what it did list is still true. No output at all is no answer.
    if ((cwds.code !== 0 && cwds.code !== 1) || cwds.stdout.trim() === '') {
      return { kind: 'unknown' };
    }
    const ppids = parents.code === 0 ? parsePs(parents.stdout) : new Map<number, number>();
    const entries = parseLsof(cwds.stdout).map((entry) => {
      const ppid = ppids.get(entry.pid);
      return ppid === undefined ? entry : { ...entry, ppid };
    });
    return { kind: 'ok', entries };
  }

  /**
   * The processes working in `tree` or below it, by real path. `exclude`
   * names processes to leave out with every descendant they have — the
   * sessions' agent CLIs, which a removal stops before it checks again —
   * and `excludeAlone` processes left out without their descendants: a
   * session's idle shell is expected there, a dev server started in it is
   * not.
   */
  public static inTree(
    snapshot: ProcessSnapshot,
    tree: string,
    exclude: ReadonlySet<number> = new Set(),
    excludeAlone: ReadonlySet<number> = new Set(),
  ): ProcessesInTree {
    if (snapshot.kind === 'unknown') return { kind: 'unknown' };
    const parents = new Map<number, number>();
    for (const entry of snapshot.entries) {
      if (entry.ppid !== undefined) parents.set(entry.pid, entry.ppid);
    }
    const excluded = (pid: number): boolean => {
      const seen = new Set<number>();
      let current: number | undefined = pid;
      while (current !== undefined && current > 1 && !seen.has(current)) {
        if (exclude.has(current)) return true;
        seen.add(current);
        current = parents.get(current);
      }
      return false;
    };
    const inside = snapshot.entries.filter(
      (entry) =>
        isWithin(entry.cwd, tree) &&
        entry.pid !== process.pid &&
        !excludeAlone.has(entry.pid) &&
        !excluded(entry.pid),
    );
    if (inside.length === 0) return { kind: 'none' };
    return {
      kind: 'present',
      processes: inside.map(({ pid, command }) => ({ pid, command })),
    };
  }
}

/** `lsof -F pcn`: a `p` line opens a process, `c` is its command, `n` its cwd. */
export function parseLsof(output: string): ProcessEntry[] {
  return parseLsofFields(output).map(({ pid, command, name }) => ({ pid, command, cwd: name }));
}

function parsePs(output: string): Map<number, number> {
  const parents = new Map<number, number>();
  for (const line of output.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (Number.isFinite(pid) && Number.isFinite(ppid)) parents.set(pid, ppid);
  }
  return parents;
}

/** Whether `child` is `parent` or lies below it. Both already resolved. */
export function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function runCommand(
  binary: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      binary,
      args,
      { maxBuffer: 32 * 1024 * 1024, timeout: SNAPSHOT_TIMEOUT_MS },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
        // A timeout kills the child: whatever it printed is a partial answer.
        resolve({
          code: error?.killed ? -1 : code,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}
