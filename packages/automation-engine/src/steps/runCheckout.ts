/*
 * A run's own checkout (slice 3-B, *The run-owned checkout*): the engine
 * decides when it is made (once, before the first step), settled (after
 * every step), committed, reset (before a retry) and read; a host does the
 * git work through `RunCheckoutPort`, which the Node adapter
 * (`node/runCheckout.ts`) implements against real git, and answers what only
 * it can: which processes a step left, and which session holds the folder.
 * Pure: types, names and words only.
 */

/** What the engine asks a host to make: a checkout of `repo` for one run, on `branch`. */
export interface RunCheckoutRequest {
  workspaceId: string;
  runId: string;
  automation: string;
  /** `owner/name`, one of the factory's `repos:`. */
  repo: string;
  /** Rendered and cleaned (`renderBranch`): git's own check runs again before it is made. */
  branch: string;
  /** The branch it cuts from; absent, the remote's default branch. */
  from?: string;
}

/** What the run records once it is made. */
export interface MadeRunCheckout {
  cwd: string;
  scopeId: string;
  /** The commit the branch was cut from. */
  base: string;
}

/** What a step leaves, as Consola checks and commits it (Call 9). */
export interface SettleRequest {
  dir: string;
  branch: string;
  base: string;
  /** The commit the step started from. */
  before: string;
  /** The step's id, for the words of a refusal. */
  step: string;
  /** An agent step's commit; null for a command step (checks, no commit) and for a step that failed. */
  commit: { message: string } | null;
  /** Where `changes.patch` goes: the attempt's folder. */
  attemptDir: string;
  /** A failed or cut-off attempt: the patch is `before` to the working tree, untracked included, and nothing is committed. */
  keepOnly?: boolean;
}

export type SettleResult =
  | { ok: true; after: string; files: number; flagged: string[] }
  | { ok: false; error: string };

/** What a step left running, as the host found it (Call 8, review B6). */
export type StepProcesses =
  | { kind: 'clear' }
  /** The step's own, alive after SIGKILL. */
  | { kind: 'survivors'; count: number }
  /** Not Consola's: never signalled. */
  | { kind: 'strangers'; processes: Array<{ pid: number; command: string }> }
  | { kind: 'unknown'; why: string };

export interface RunCheckoutPort {
  /** Where a run's checkout of `repo` lives, made or not: `<worktree root>/<runOwnedDirName>`. */
  pathFor(runId: string, repo: string): string;
  /** Make it (steps 1–8 of *How it is made*); throws a `RunCheckoutError` saying where it stopped. */
  make(request: RunCheckoutRequest): Promise<MadeRunCheckout>;
  settle(request: SettleRequest): Promise<SettleResult>;
  /** Between steps: a person's session's leftovers; never ends a process; the git folder checked first (review NB1); null when nothing changed and the folder is as made. */
  settleBetween(request: {
    dir: string;
    branch: string;
    base: string;
    before: string;
    message: string;
    session?: string;
  }): Promise<SettleResult | null>;
  reset(dir: string, before: string): Promise<void>;
  changes(
    dir: string,
    base: string,
    head: string,
    maxBytes: number,
  ): Promise<{ text: string; truncated: boolean; bytes: number }>;
  showAt(
    dir: string,
    commit: string,
    path: string,
    maxBytes: number,
  ): Promise<
    { ok: true; text: string } | { ok: false; reason: 'missing' | 'not-a-file' | 'too-large' }
  >;
  /**
   * Call 9 (review NB1): the node adapter's `gitFolderProblem(dir)`, asked before every spawn in a run-owned checkout,
   * since no git variable reaches a step and its git finds the folder through the pointer. Null when the pointer and
   * the git folder are as Consola made them.
   */
  folderProblem(dir: string): string | null;
  /**
   * Call 8 (review B6): end the step's own processes, then look in `dir` with every live Consola terminal's tree
   * excluded. `sessionId` names an agent step's session (its CLI's group and the descendants recorded at its turn's
   * end); a command step passes none (its group is the adapter's, `node/runCommand.ts`). Never signals anything else.
   */
  endStepProcesses(request: { dir: string; sessionId?: string }): Promise<StepProcesses>;
  /** Call 12: the first session whose `cwd` or `agentCwd` is `dir` and whose CLI is running, else null. */
  holder(dir: string): { sessionId: string; name: string } | null;
}

/** Where making a run's checkout stopped: the words a failed run says, `(<stage>): <why>`. */
export type RunCheckoutStage =
  | 'resolve'
  | 'clone'
  | 'origin'
  | 'fetch'
  | 'branch'
  | 'identity'
  | 'exclude';

/** Thrown by `make` (the node adapter and a host's port), so the core can word it without importing the adapter. */
export class RunCheckoutError extends Error {
  readonly stage: RunCheckoutStage;
  constructor(stage: RunCheckoutStage, why: string) {
    super(why);
    this.name = 'RunCheckoutError';
    this.stage = stage;
  }
}

/** `<repo basename>-run-<run id's first 8>`: one folder per run, so two runs of an entry never share one. */
export function runOwnedDirName(repo: string, runId: string): string {
  const name = repo.split('/').pop() ?? repo;
  return `${name}-run-${runId.slice(0, 8)}`;
}

/** Consola's commit of what a step left: `<step> (attempt <n>) of <automation> on <item key or run id>`. */
export function commitMessage(
  step: string,
  attempt: number,
  automation: string,
  itemKeyOrRun: string,
): string {
  return `${step} (attempt ${attempt}) of ${automation} on ${itemKeyOrRun}`;
}

/**
 * Files that tell an agent CLI, git or CI what to do, compared case-folded
 * (the Mac's file system reads `claude.md` as `CLAUDE.md`): each agent CLI
 * Consola drives has its own instructions file (Claude's `CLAUDE.md` and
 * `CLAUDE.local.md`, Codex's `AGENTS.md` and `AGENTS.override.md`, Gemini's
 * and Antigravity's `GEMINI.md`), Claude its `.mcp.json`, and git reads
 * `.gitattributes` (filters and drivers), `.gitmodules` and `.lfsconfig`.
 * Flagged at any depth: the CLIs and git read nested ones too.
 */
export const FLAGGED_FILE_NAMES: readonly string[] = [
  'claude.md',
  'claude.local.md',
  'agents.md',
  'agents.override.md',
  'gemini.md',
  '.mcp.json',
  '.gitattributes',
  '.gitmodules',
  '.lfsconfig',
];

/**
 * Folders the same: each agent CLI's own (the drivers' `.claude`, `.codex`,
 * `.gemini`, the shared `.agents`, a plugin's `.claude-plugin`), and the
 * hooks and CI a merge runs (`.husky`, `.github`). Flagged at any depth.
 */
export const FLAGGED_FOLDER_NAMES: readonly string[] = [
  '.claude',
  '.claude-plugin',
  '.codex',
  '.gemini',
  '.agents',
  '.husky',
  '.github',
];

/**
 * The changed paths a person should look at before a branch is pushed: what
 * changes how an agent, git or CI behaves once merged. A path is flagged when
 * a part of it, case-folded, is one of `FLAGGED_FILE_NAMES` (its last part)
 * or `FLAGGED_FOLDER_NAMES` (a folder on its way), and, so that a new kind is
 * never missed silently, whenever it starts with a dotfile or dot-folder at
 * the repository's root.
 */
export function flaggedPaths(paths: readonly string[]): string[] {
  return paths.filter((file) => {
    const parts = file.split('/').map((part) => part.toLowerCase());
    const name = parts[parts.length - 1];
    return (
      parts[0].startsWith('.') ||
      FLAGGED_FILE_NAMES.includes(name) ||
      parts.slice(0, -1).some((folder) => FLAGGED_FOLDER_NAMES.includes(folder))
    );
  });
}
