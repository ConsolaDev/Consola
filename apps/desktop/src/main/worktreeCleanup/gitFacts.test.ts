import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_WORKTREE_CLEANUP_RULES } from '../../shared/worktreeCleanup';
import type { TreeVerdict, WorktreeCleanupRules } from '../../shared/worktreeCleanup';
import { WorktreeService } from '../WorktreeService';
import type { GatherOptions } from './FactGatherer';
import { ignoredAtRisk } from './localFiles';
import { runCloneGitDirFor } from '@consola/automation-engine';
import { BRANCH, RUN_ID, RunOwnedRig } from './runOwned.test-helpers';

/**
 * The facts that decide whether a removal could lose something git does not
 * count as a change, against real git.
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const created: string[] = [];
afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();
}

function write(dir: string, file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
}

let clone: string;
let tree: string;
let service: WorktreeService;

beforeEach(() => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-facts-')));
  created.push(base);
  clone = path.join(base, 'app');
  const root = path.join(base, 'worktrees');
  fs.mkdirSync(root);
  execFileSync('git', ['init', '-q', '-b', 'main', clone]);
  write(clone, '.gitignore', '.env\n*.local\nnode_modules/\ndist/\nnotes/\n*.log\n');
  write(clone, 'README', 'hello');
  git(clone, 'add', '.');
  git(clone, 'commit', '-q', '-m', 'init');
  tree = path.join(root, 'app-session-1');
  git(clone, 'worktree', 'add', '-q', '-b', 'consola/session-1', tree);
  service = new WorktreeService(root);
});

describe('ignoredAtRisk', () => {
  it('passes a file the main checkout has an identical copy of', async () => {
    write(clone, '.env', 'TOKEN=1');
    write(tree, '.env', 'TOKEN=1');
    expect(await service.ignoredAtRisk(tree, clone)).toEqual({
      count: 0,
      paths: [],
      complete: true,
    });
  });

  it('blocks a modified copy, and a file with no copy at all', async () => {
    write(clone, '.env', 'TOKEN=1');
    write(tree, '.env', 'TOKEN=2');
    write(tree, 'settings.local', 'mine');
    const found = await service.ignoredAtRisk(tree, clone);
    expect(found).toMatchObject({ count: 2, complete: true });
    expect(found.paths[0]).toBe('.env');
  });

  it('looks inside an ignored folder that is not rebuildable', async () => {
    write(tree, 'notes/today.md', 'ideas');
    expect((await service.ignoredAtRisk(tree, clone)).paths).toEqual([
      path.join('notes', 'today.md'),
    ]);
  });

  it('never counts rebuildable folders or disposable files', async () => {
    write(tree, 'node_modules/pkg/index.js', 'x');
    write(tree, 'dist/app.js', 'x');
    write(tree, 'debug.log', 'x');
    expect(await service.ignoredAtRisk(tree, clone)).toEqual({
      count: 0,
      paths: [],
      complete: true,
    });
  });

  it('reads a check cut short by its budget as incomplete', async () => {
    for (let index = 0; index < 5; index++) write(tree, `notes/${index}.md`, 'x');
    const found = await ignoredAtRisk(
      async (cwd, args) => {
        try {
          return {
            code: 0,
            stdout: execFileSync('git', ['-C', cwd, ...args]).toString(),
            stderr: '',
          };
        } catch {
          return { code: 1, stdout: '', stderr: '' };
        }
      },
      tree,
      clone,
      {
        deadlineMs: 8_000,
        listedPaths: 5_000,
        visitedEntries: 3,
        comparedBytes: 1024,
        comparedFileBytes: 1024,
      },
    );
    expect(found.complete).toBe(false);
  });
});

describe('nestedRepos', () => {
  it('finds a repository below the root, and none in a plain tree', async () => {
    expect(await service.nestedRepos(tree)).toEqual({ paths: [], complete: true });
    execFileSync('git', ['init', '-q', path.join(tree, 'tools', 'inner')]);
    expect(await service.nestedRepos(tree)).toEqual({
      paths: [path.join('tools', 'inner')],
      complete: true,
    });
  });

  it('skips rebuildable folders', async () => {
    execFileSync('git', ['init', '-q', path.join(tree, 'node_modules', 'dep')]);
    expect((await service.nestedRepos(tree)).paths).toEqual([]);
  });
});

describe('hiddenChanges', () => {
  it('sees through skip-worktree and assume-unchanged, but not an unedited flag', async () => {
    expect(await service.hiddenChanges(tree)).toEqual({ kind: 'none' });
    git(tree, 'update-index', '--skip-worktree', 'README');
    expect(await service.hiddenChanges(tree)).toEqual({ kind: 'none' });
    write(tree, 'README', 'edited where status cannot see');
    expect(await service.hiddenChanges(tree)).toEqual({ kind: 'some', paths: ['README'] });

    git(tree, 'update-index', '--no-skip-worktree', 'README');
    git(tree, 'checkout', '--', 'README');
    git(tree, 'update-index', '--assume-unchanged', '.gitignore');
    write(tree, '.gitignore', 'changed\n');
    expect(await service.hiddenChanges(tree)).toEqual({ kind: 'some', paths: ['.gitignore'] });
    // git status hides it all the same.
    expect(git(tree, 'status', '--porcelain')).toBe('');
  });
});

describe('inspect', () => {
  it('sees an untracked file even when git is told not to show them', async () => {
    git(clone, 'config', 'status.showUntrackedFiles', 'no');
    write(tree, 'new-file.ts', 'never added');
    expect(git(tree, 'status', '--porcelain')).toBe('');
    expect(await service.inspect(tree)).toMatchObject({ dirty: true, dirtyFiles: 1 });
  });
});

describe('isLocked', () => {
  it('reads git’s lock', async () => {
    expect(await service.isLocked(clone, tree)).toBe(false);
    git(clone, 'worktree', 'lock', tree);
    expect(await service.isLocked(clone, tree)).toBe(true);
  });
});

describe('managedTreeOf', () => {
  it('maps a folder inside a worktree to the worktree, and nothing outside', () => {
    fs.mkdirSync(path.join(tree, 'src'));
    expect(service.managedTreeOf(path.join(tree, 'src'))).toBe(tree);
    expect(service.managedTreeOf(tree)).toBe(tree);
    expect(service.managedTreeOf(clone)).toBeNull();
    expect(service.managedTreeOf(path.dirname(tree))).toBeNull();
    expect(service.managedTreeOf(path.join(path.dirname(tree), 'gone'))).toBeNull();
  });
});

describe("a run's own checkout, as the cleanup reads it (slice 3-B Task 19)", () => {
  const rigs: RunOwnedRig[] = [];
  afterAll(() => {
    for (const made of rigs) made.dispose();
  });
  const SWEEP: GatherOptions = {
    request: { trigger: 'sweep', targets: new Set(), now: Date.now() },
  };
  const ON: WorktreeCleanupRules = {
    ...DEFAULT_WORKTREE_CLEANUP_RULES,
    runFinished: { enabled: true, afterMinutes: 60 },
  };
  async function rigged(): Promise<RunOwnedRig> {
    const made = await new RunOwnedRig().make();
    rigs.push(made);
    made.rules = ON;
    return made;
  }
  const blockersOf = (verdict: TreeVerdict) =>
    verdict.decision === 'keep' ? verdict.blockers.map((blocker) => blocker.detail) : [];

  it('is recognised by its run record, and once history drops it, by its own config', async () => {
    const rig = await rigged();
    rig.push();
    const known = await rig.service().evaluateTree(rig.dir, SWEEP);
    expect(known.facts.disk).toMatchObject({
      managed: true,
      run: { endedAt: rig.record!.endedAt },
      gitFolder: null,
    });
    expect(known.inspection).toMatchObject({
      mainRepo: rig.source,
      runOwned: { runId: RUN_ID },
      branch: BRANCH,
      head: rig.head,
    });
    expect(known.verdict).toMatchObject({ decision: 'remove', trigger: 'run-finished' });
    rig.record = null;
    const dropped = await rig.service().evaluateTree(rig.dir, SWEEP);
    expect(dropped.facts.disk).toMatchObject({ managed: true, run: { endedAt: undefined } });
    expect(dropped.facts.disk.run).toHaveProperty('endedAt', undefined);
  });

  it("a plain clone, or one whose config names another run, stays a clone's own checkout", async () => {
    const rig = await rigged();
    const plain = path.join(rig.root, 'catalog-portal-run-0badc0de');
    rig.git(rig.base, 'clone', '-q', rig.source, plain);
    const clone = await rig.service().evaluateTree(plain, SWEEP);
    expect(clone.facts.disk.managed).toBe(false);
    expect(blockersOf(clone.verdict)[0]).toBe('it is not a worktree Consola created');

    // A copy under a name that is not its run's: its run record names it, its config the run.
    const misnamed = path.join(rig.root, 'catalog-portal-run-aaaaaaaa');
    fs.cpSync(rig.dir, misnamed, { recursive: true });
    fs.cpSync(rig.gitDir, runCloneGitDirFor(misnamed), { recursive: true });
    const anyTree = rig.ruleSources();
    const copied = await rig
      .service({
        rules: {
          ...anyTree,
          runOwnedOf: () => ({
            runId: RUN_ID,
            source: rig.source,
            endedAt: rig.record!.endedAt,
            workspaceId: 'ws',
          }),
        },
      })
      .evaluateTree(misnamed, SWEEP);
    expect(copied.facts.disk.managed).toBe(false);
    expect(blockersOf(copied.verdict)[0]).toBe('it is not a worktree Consola created');

    rig.git(
      rig.base,
      'config',
      '--file',
      path.join(rig.gitDir, 'config'),
      'consola.run',
      '99999999',
    );
    for (const record of [rig.record, null]) {
      rig.record = record;
      const other = await rig.service().evaluateTree(rig.dir, SWEEP);
      expect(other.facts.disk.managed).toBe(false);
      expect(blockersOf(other.verdict)[0]).toBe('it is not a worktree Consola created');
    }
  });

  it("the run record's source wins: a git folder whose consola.source names another clone is not managed (review M6)", async () => {
    const rig = await rigged();
    rig.push();
    rig.git(
      rig.base,
      'config',
      '--file',
      path.join(rig.gitDir, 'config'),
      'consola.source',
      '/elsewhere/clone',
    );
    const read = await rig.service().evaluateTree(rig.dir, SWEEP);
    expect(read.facts.disk.managed).toBe(false);
    expect(read.verdict.decision).toBe('keep');
  });

  it('keeps one with unpushed commits, and one whose run is open', async () => {
    const rig = await rigged();
    rig.record = { endedAt: null };
    const open = await rig.service().evaluateTree(rig.dir, SWEEP);
    expect(blockersOf(open.verdict)).toContain('its automation run is still open');
    rig.record = { endedAt: Date.now() - 2 * 60 * 60_000 };
    const ended = await rig.service().evaluateTree(rig.dir, SWEEP);
    expect(blockersOf(ended.verdict)).toContain('it has commits that exist only locally');
  });

  it("Consola's git there reads none of the person's global config: an fsmonitor in it never runs (Call 9)", async () => {
    const rig = await rigged();
    rig.push();
    const marker = path.join(rig.base, 'global-fsmonitor-ran');
    const global = path.join(rig.base, 'global-with-fsmonitor');
    fs.writeFileSync(global, `[core]\n\tfsmonitor = "touch '${marker}'; false"\n`);
    // The same config runs it for git in the person's own clone: the row's marker is real.
    execFileSync('git', ['ls-files', '-v'], {
      cwd: rig.source,
      env: { ...rig.env, GIT_CONFIG_GLOBAL: global },
      stdio: 'ignore',
    });
    expect(fs.existsSync(marker)).toBe(true);
    fs.rmSync(marker);
    vi.stubEnv('GIT_CONFIG_GLOBAL', global);
    try {
      const read = await rig.service().evaluateTree(rig.dir, SWEEP);
      expect(read.verdict.decision).toBe('remove');
      expect(read.facts.disk).toMatchObject({ hidden: { kind: 'none' }, published: 'published' });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("its package caches (`.consola-cache/`, ignored by its git folder's exclude) never keep it", async () => {
    const rig = await rigged();
    rig.push();
    fs.mkdirSync(path.join(rig.dir, '.consola-cache', 'npm'), { recursive: true });
    fs.writeFileSync(path.join(rig.dir, '.consola-cache', 'npm', 'index-v5'), 'cache');
    const read = await rig.service().evaluateTree(rig.dir, SWEEP);
    expect(read.facts.disk.ignored).toEqual({ count: 0, paths: [], complete: true });
    expect(read.verdict.decision).toBe('remove');
  });

  it('a run-owned folder whose pointer was rewritten is kept as unknown, and no git runs in it (review NS1)', async () => {
    const rig = await rigged();
    rig.push();
    const marker = path.join(rig.base, 'fsmonitor-ran');
    const evil = path.join(rig.dir, 'evil');
    fs.mkdirSync(evil);
    fs.cpSync(path.join(rig.gitDir, 'objects'), path.join(evil, 'objects'), { recursive: true });
    fs.cpSync(path.join(rig.gitDir, 'refs'), path.join(evil, 'refs'), { recursive: true });
    fs.copyFileSync(path.join(rig.gitDir, 'HEAD'), path.join(evil, 'HEAD'));
    fs.writeFileSync(
      path.join(evil, 'config'),
      `[core]\n\trepositoryformatversion = 0\n\tfsmonitor = "touch '${marker}'; false"\n`,
    );
    fs.writeFileSync(path.join(rig.dir, '.git'), `gitdir: ${evil}\n`);
    // A git that follows the pointer runs the planted config: the row's marker is real.
    execFileSync('git', ['status', '--porcelain'], { cwd: rig.dir, env: rig.env, stdio: 'ignore' });
    expect(fs.existsSync(marker)).toBe(true);
    fs.rmSync(marker);

    const read = await rig.service().evaluateTree(rig.dir, SWEEP);
    expect(blockersOf(read.verdict)).toContain(
      "its git folder changed (.git in the checkout is not Consola's pointer), so Consola did not read it",
    );
    expect(read.facts.disk.head).toBeUndefined();
    expect(read.inspection).toBeNull();
    // And `inspect` on its own reads nothing there either.
    expect(await rig.worktrees.inspect(rig.dir)).toBeNull();
    expect(fs.existsSync(marker)).toBe(false);
  });
});
