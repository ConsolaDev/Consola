import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorktreeService } from './WorktreeService';

/**
 * The destructive half of WorktreeService, against real git: a bare
 * "origin", a clone of it, and worktrees under a temp Consola root.
 * Real git costs real subprocesses — a dozen per test — so these get more
 * than the default five seconds when the suite runs in parallel.
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const created: string[] = [];
afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  }).trim();
}

function commit(cwd: string, file: string): string {
  fs.writeFileSync(path.join(cwd, file), file);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', file);
  return git(cwd, 'rev-parse', 'HEAD');
}

interface Rig {
  origin: string;
  clone: string;
  root: string;
  service: WorktreeService;
  /** A worktree under the root on a new branch, with one commit. */
  addWorktree(name: string, branch: string): { dir: string; head: string };
}

function rig(): Rig {
  const base = tmp('consola-safety-');
  const origin = path.join(base, 'origin.git');
  const clone = path.join(base, 'app');
  const root = path.join(base, 'worktrees');
  fs.mkdirSync(root);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', clone]);
  git(clone, 'remote', 'add', 'origin', origin);
  commit(clone, 'README');
  git(clone, 'push', '-q', 'origin', 'main');
  git(clone, 'remote', 'set-head', 'origin', 'main');
  const service = new WorktreeService(root);
  return {
    origin,
    clone,
    root,
    service,
    addWorktree(name, branch) {
      const dir = path.join(root, name);
      git(clone, 'worktree', 'add', '-q', '-b', branch, dir);
      return { dir, head: commit(dir, `${name}.txt`) };
    },
  };
}

let r: Rig;
beforeEach(() => {
  r = rig();
});

describe('isManagedPath', () => {
  it('accepts only direct children of the root, by real path', () => {
    const { dir } = r.addWorktree('app-session-1', 'feat-1');
    expect(r.service.isManagedPath(dir)).toBe(true);
    expect(r.service.isManagedPath(r.root)).toBe(false);
    expect(r.service.isManagedPath(path.join(dir, 'nested'))).toBe(false);
    expect(r.service.isManagedPath(r.clone)).toBe(false);
    expect(r.service.isManagedPath(path.join(r.root, '..', 'app'))).toBe(false);
    expect(r.service.isManagedPath(path.join(r.root, 'does-not-exist'))).toBe(false);
  });

  it('is not fooled by a symlink inside the root pointing at a scope folder', () => {
    const link = path.join(r.root, 'sneaky');
    fs.symlinkSync(r.clone, link);
    expect(r.service.isManagedPath(link)).toBe(false);
  });
});

describe('inspect', () => {
  it('describes a linked worktree', async () => {
    const { dir, head } = r.addWorktree('app-session-1', 'feat-1');
    const facts = await r.service.inspect(path.join(dir));
    expect(facts).toEqual({
      toplevel: dir,
      mainRepo: r.clone,
      isLinkedWorktree: true,
      head,
      branch: 'feat-1',
      remoteBranch: 'feat-1',
      originUrl: r.origin,
      dirty: false,
    });
  });

  it('knows a clone’s own checkout is not a linked worktree', async () => {
    expect((await r.service.inspect(r.clone))?.isLinkedWorktree).toBe(false);
  });

  it('reports untracked files and edits as dirty', async () => {
    const { dir } = r.addWorktree('app-session-1', 'feat-1');
    fs.writeFileSync(path.join(dir, 'scratch.txt'), 'wip');
    expect((await r.service.inspect(dir))?.dirty).toBe(true);
  });

  it('reads the remote branch name from tracking config', async () => {
    const { dir } = r.addWorktree('app-session-1', 'local-name');
    git(dir, 'push', '-q', '-u', 'origin', 'local-name:remote-name');
    expect((await r.service.inspect(dir))?.remoteBranch).toBe('remote-name');
  });

  it('answers null for a directory that is gone', async () => {
    expect(await r.service.inspect(path.join(r.root, 'gone'))).toBeNull();
  });
});

describe('commitsArePublished', () => {
  it('against a known PR head: equal or ancestor is published, extra commits are not', async () => {
    const { dir, head } = r.addWorktree('app-session-1', 'feat-1');
    const facts = (await r.service.inspect(dir))!;
    expect(await r.service.commitsArePublished(facts, { knownHead: head }, process.env)).toBe('published');

    // The PR moved on after this checkout (someone pushed a fix-up): still safe.
    const later = commit(dir, 'later.txt');
    git(dir, 'reset', '-q', '--hard', 'HEAD~1');
    const behind = (await r.service.inspect(dir))!;
    expect(await r.service.commitsArePublished(behind, { knownHead: later }, process.env)).toBe('published');

    // A commit made locally after the PR's final head: not safe.
    commit(dir, 'local-only.txt');
    const ahead = (await r.service.inspect(dir))!;
    expect(await r.service.commitsArePublished(ahead, { knownHead: head }, process.env)).toBe(
      'local-commits'
    );
  });

  it('is unverifiable when the PR head commit is unknown and cannot be fetched', async () => {
    const { dir } = r.addWorktree('app-session-1', 'feat-1');
    const facts = (await r.service.inspect(dir))!;
    expect(
      await r.service.commitsArePublished(facts, { knownHead: 'f'.repeat(40) }, process.env)
    ).toBe('unverifiable');
  });

  it('fetches the PR ref once when this clone never saw the head commit', async () => {
    // Someone else's commit, only on origin under the PR ref.
    const other = tmp('consola-other-');
    execFileSync('git', ['clone', '-q', r.origin, other]);
    const theirs = commit(other, 'theirs.txt');
    git(other, 'push', '-q', 'origin', 'HEAD:refs/pull/7/head');

    const { dir } = r.addWorktree('app-session-1', 'feat-1');
    git(dir, 'reset', '-q', '--hard', 'origin/main');
    const facts = (await r.service.inspect(dir))!;
    expect(
      await r.service.commitsArePublished(
        facts,
        { knownHead: theirs, fetchRef: 'pull/7/head' },
        process.env
      )
    ).toBe('published');
  });

  it('without a known head: published only when reachable from a remote ref', async () => {
    const { dir } = r.addWorktree('app-session-1', 'feat-1');
    const unpushed = (await r.service.inspect(dir))!;
    expect(await r.service.commitsArePublished(unpushed, {}, process.env)).toBe('local-commits');
    git(dir, 'push', '-q', 'origin', 'feat-1');
    const pushed = (await r.service.inspect(dir))!;
    expect(await r.service.commitsArePublished(pushed, {}, process.env)).toBe('published');
  });
});

describe('removeWorktree', () => {
  it('removes a clean Consola worktree and unregisters it', async () => {
    const { dir } = r.addWorktree('app-session-1', 'feat-1');
    await r.service.removeWorktree((await r.service.inspect(dir))!);
    expect(fs.existsSync(dir)).toBe(false);
    expect(git(r.clone, 'worktree', 'list')).not.toContain('app-session-1');
  });

  it('lets git refuse a tree that became dirty after inspection', async () => {
    const { dir } = r.addWorktree('app-session-1', 'feat-1');
    const facts = (await r.service.inspect(dir))!;
    fs.writeFileSync(path.join(dir, 'late.txt'), 'wip');
    await expect(r.service.removeWorktree(facts)).rejects.toThrow();
    expect(fs.existsSync(path.join(dir, 'late.txt'))).toBe(true);
  });

  it('refuses a worktree outside the root and a clone’s own checkout', async () => {
    const outside = path.join(tmp('consola-outside-'), 'wt');
    git(r.clone, 'worktree', 'add', '-q', '-b', 'elsewhere', outside);
    await expect(r.service.removeWorktree((await r.service.inspect(outside))!)).rejects.toThrow(
      /not a Consola worktree/
    );
    await expect(r.service.removeWorktree((await r.service.inspect(r.clone))!)).rejects.toThrow(
      /not a Consola worktree/
    );
    expect(fs.existsSync(outside)).toBe(true);
  });
});

describe('deleteBranchAt', () => {
  async function removed(name: string, branch: string) {
    const wt = r.addWorktree(name, branch);
    await r.service.removeWorktree((await r.service.inspect(wt.dir))!);
    return wt.head;
  }

  it('deletes a branch still at the expected commit, squash-merged or not', async () => {
    const head = await removed('app-session-1', 'feat-1');
    expect(await r.service.deleteBranchAt(r.clone, 'feat-1', head)).toEqual({ deleted: true });
    expect(git(r.clone, 'branch', '--list', 'feat-1')).toBe('');
  });

  it('keeps a branch that moved since it was checked', async () => {
    const head = await removed('app-session-1', 'feat-1');
    git(r.clone, 'branch', '-f', 'feat-1', 'main');
    const result = await r.service.deleteBranchAt(r.clone, 'feat-1', head);
    expect(result).toMatchObject({ deleted: false, reason: expect.stringMatching(/no longer points/) });
    expect(git(r.clone, 'branch', '--list', 'feat-1')).toContain('feat-1');
  });

  it('never deletes the default branch or one checked out elsewhere', async () => {
    const main = git(r.clone, 'rev-parse', 'main');
    expect(await r.service.deleteBranchAt(r.clone, 'main', main)).toMatchObject({ deleted: false });
    const { head } = r.addWorktree('app-session-2', 'feat-2');
    expect(await r.service.deleteBranchAt(r.clone, 'feat-2', head)).toMatchObject({
      deleted: false,
      reason: expect.stringMatching(/checked out/),
    });
  });
});

describe('checking a pull request out onto a branch an earlier checkout left behind', () => {
  const pr51 = { provider: 'github', repo: 'sprocket/catalog-portal', type: 'pr', number: 51 } as const;
  // The fixture gh checks out origin's `feature` the way real gh does a
  // same-repo PR: reusing a local `feature` and only fast-forwarding it.
  const env = { ...process.env, STUB_GH_PR_BRANCH: 'feature' };

  beforeEach(() => {
    process.env.CONSOLA_GH_PATH = path.resolve(__dirname, '../../tests/fixtures/stub-gh/gh');
  });
  afterEach(() => {
    delete process.env.CONSOLA_GH_PATH;
  });

  /** The PR author's own clone, which pushes `feature` and can rewrite it. */
  function author() {
    const dir = tmp('consola-author-');
    execFileSync('git', ['clone', '-q', r.origin, dir]);
    git(dir, 'checkout', '-q', '-b', 'feature');
    const push = () => {
      git(dir, 'push', '-q', '-f', 'origin', 'feature');
      return git(dir, 'rev-parse', 'HEAD');
    };
    return {
      open: () => (commit(dir, 'feature.txt'), push()),
      forcePush: () => (git(dir, 'commit', '-q', '--amend', '-m', 'feature, rebased'), push()),
    };
  }

  it('moves the stale branch to the head the author force-pushed', async () => {
    const pr = author();
    pr.open();
    // An earlier review checked the PR out; removing that worktree kept its branch.
    await r.service.prune(await r.service.ensureWorktree(r.clone, pr51, env));
    const rewritten = pr.forcePush();

    const dir = await r.service.ensureWorktree(r.clone, pr51, env);

    expect(git(dir, 'symbolic-ref', '--short', 'HEAD')).toBe('feature');
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(rewritten);
  });

  it('brings an existing worktree to a force-pushed head when the review is requested again', async () => {
    const pr = author();
    pr.open();
    const dir = await r.service.ensureWorktree(r.clone, pr51, env);
    const rewritten = pr.forcePush();

    expect(await r.service.refreshPullRequest(dir, pr51, env)).toBe(true);
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(rewritten);
  });

  it('never resets a branch holding a commit that was never pushed', async () => {
    const pr = author();
    pr.open();
    const first = await r.service.ensureWorktree(r.clone, pr51, env);
    const unpushed = commit(first, 'local-only.txt');
    await r.service.prune(first);
    pr.forcePush();

    await expect(r.service.ensureWorktree(r.clone, pr51, env)).rejects.toThrow(/never pushed/);
    expect(git(r.clone, 'rev-parse', 'feature')).toBe(unpushed);
  });
});
