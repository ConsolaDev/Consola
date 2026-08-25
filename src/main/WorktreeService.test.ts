import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitProviderId } from '../shared/providers';
import type { WorkItemRef } from '../shared/workItems';
import type { Scope, Workspace } from '../shared/workspace';
import { getProviderDriver, type GitProviderDriver } from './providers';
import { WorktreeService, worktreeDirName } from './WorktreeService';

const STUB_GH = path.resolve(__dirname, '../../tests/fixtures/stub-gh/gh');

// The service resolves its driver from the registry, and the GitHub driver
// resolves `gh` through CONSOLA_GH_PATH on every call — so pointing that at
// the fixture is the whole test seam, exactly as the Playwright rig does it.
beforeEach(() => {
  process.env.CONSOLA_GH_PATH = STUB_GH;
});

afterEach(() => {
  delete process.env.CONSOLA_GH_PATH;
});

// Every dir handed out by tmpDir(), swept in one afterAll — these tests spin
// up several independent roots and repos rather than sharing one temp dir.
const createdDirs: string[] = [];

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of createdDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function initRepo(dir: string, origin?: string): void {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  if (origin) execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', origin]);
}

function makeScope(dir: string, isGitRepo: boolean): Scope {
  return { id: `scope-${path.basename(dir)}`, name: path.basename(dir), path: dir, isGitRepo, createdAt: Date.now() };
}

function makeWorkspace(scopes: Scope[], overrides: Partial<Workspace> = {}): Workspace {
  const now = Date.now();
  return {
    id: 'ws-1',
    name: 'Sympower',
    defaultHarnessId: 'default',
    scopes,
    groups: [],
    provider: { id: 'github', accountLogin: 'SymJavi', org: 'sympower' },
    actions: [],
    sectionDefaults: {},
    sessions: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('worktreeDirName', () => {
  it('is <repo-basename>-<type>-<number>', () => {
    expect(
      worktreeDirName({ provider: 'github', repo: 'sympower/controller-app', type: 'pr', number: 51 })
    ).toBe('controller-app-pr-51');
    expect(
      worktreeDirName({ provider: 'github', repo: 'sympower/msa-resource-bff', type: 'issue', number: 87 })
    ).toBe('msa-resource-bff-issue-87');
  });
});

describe('WorktreeService.resolveRepo', () => {
  let repoScope: string;
  let containerScope: string;
  let childClone: string;

  beforeAll(() => {
    repoScope = path.join(tmpDir('consola-wt-repo-'), 'controller-app');
    initRepo(repoScope, 'git@github.com:sympower/controller-app.git');

    containerScope = tmpDir('consola-wt-container-');
    childClone = path.join(containerScope, 'flex-portal');
    initRepo(childClone, 'https://github.com/sympower/flex-portal.git');
    // A non-repo child, to prove the scan skips it quietly.
    fs.mkdirSync(path.join(containerScope, 'notes'), { recursive: true });
  });

  it('matches a repo scope on its origin remote', () => {
    const service = new WorktreeService(tmpDir('consola-wt-root-'));
    const workspace = makeWorkspace([makeScope(repoScope, true)]);
    expect(service.resolveRepo(workspace, 'sympower/controller-app')).toBe(repoScope);
  });

  it('scans a container scope one level deep', () => {
    const service = new WorktreeService(tmpDir('consola-wt-root-'));
    const workspace = makeWorkspace([makeScope(containerScope, false)]);
    expect(service.resolveRepo(workspace, 'sympower/flex-portal')).toBe(childClone);
  });

  it('returns null when no scope holds the repo', () => {
    const service = new WorktreeService(tmpDir('consola-wt-root-'));
    const workspace = makeWorkspace([makeScope(repoScope, true), makeScope(containerScope, false)]);
    expect(service.resolveRepo(workspace, 'sympower/msa-resource-bff')).toBeNull();
  });

  it('caches remote lookups until invalidate()', () => {
    const service = new WorktreeService(tmpDir('consola-wt-root-'));
    const dir = path.join(tmpDir('consola-wt-cache-'), 'renamed');
    initRepo(dir, 'git@github.com:sympower/old-name.git');
    const workspace = makeWorkspace([makeScope(dir, true)]);

    expect(service.resolveRepo(workspace, 'sympower/old-name')).toBe(dir);

    execFileSync('git', ['-C', dir, 'remote', 'set-url', 'origin', 'git@github.com:sympower/new-name.git']);
    // Stale until told otherwise — scope changes are what invalidate it.
    expect(service.resolveRepo(workspace, 'sympower/new-name')).toBeNull();

    service.invalidate();
    expect(service.resolveRepo(workspace, 'sympower/new-name')).toBe(dir);
  });

  it('resolves to null rather than throwing when a scope path no longer exists', () => {
    const service = new WorktreeService(tmpDir('consola-wt-root-'));
    const missing = path.join(tmpDir('consola-wt-missing-'), 'moved-away');
    const workspace = makeWorkspace([makeScope(missing, false)]);

    expect(service.resolveRepo(workspace, 'sympower/controller-app')).toBeNull();
  });

  it('resolves nothing for a workspace without a provider binding', () => {
    const service = new WorktreeService(tmpDir('consola-wt-root-'));
    const workspace = makeWorkspace([makeScope(repoScope, true)], { provider: undefined });

    // Which URLs count as this repo is the provider's call; with no
    // provider there is nothing to match against.
    expect(service.resolveRepo(workspace, 'sympower/controller-app')).toBeNull();
  });

  it('resolves nothing, rather than throwing, when the provider is unknown to this build', () => {
    const service = new WorktreeService(tmpDir('consola-wt-root-'), () => {
      throw new Error('Unknown git provider "gitlab".');
    });
    const workspace = makeWorkspace([makeScope(repoScope, true)]);

    expect(service.resolveRepo(workspace, 'sympower/controller-app')).toBeNull();
  });
});

function initCloneWithCommit(dir: string, origin: string): void {
  initRepo(dir, origin);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@consola.test']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Consola Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture');
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
}

function currentBranch(dir: string): string {
  return execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
}

// These tests spawn real `git worktree add/remove` and `gh` processes, which can
// exceed 5 seconds under parallel suite load. Using a per-test timeout instead
// of raising the global default documents which tests need the allowance and why.
describe('WorktreeService.ensureWorktree', () => {
  const pr51 = { provider: 'github', repo: 'sympower/controller-app', type: 'pr', number: 51 } as const;
  const issue87 = { provider: 'github', repo: 'sympower/controller-app', type: 'issue', number: 87 } as const;

  /**
   * The real GitHub driver with its checkout counted. Every method is
   * forwarded explicitly: spreading a class instance would drop its
   * prototype methods.
   */
  function countingDriver(): { driver: GitProviderDriver; checkout: ReturnType<typeof vi.fn> } {
    const real = getProviderDriver('github');
    const checkout = vi.fn((dir: string, ref: WorkItemRef, env: NodeJS.ProcessEnv) =>
      real.checkout(dir, ref, env)
    );
    const driver: GitProviderDriver = {
      id: real.id,
      tokenEnvVar: real.tokenEnvVar,
      probe: () => real.probe(),
      token: (login) => real.token(login),
      fetchInbox: (binding, env) => real.fetchInbox(binding, env),
      checkout,
      cloneRepo: (repo, destination, env) => real.cloneRepo(repo, destination, env),
      matchesRemote: (url, repo) => real.matchesRemote(url, repo),
      workItemUrl: (ref) => real.workItemUrl(ref),
      seedHeader: (ref, item) => real.seedHeader(ref, item),
    };
    return { driver, checkout };
  }

  function setup(resolveDriver?: (id: GitProviderId) => GitProviderDriver) {
    const clone = path.join(tmpDir('consola-wt-clone-'), 'controller-app');
    initCloneWithCommit(clone, 'git@github.com:sympower/controller-app.git');
    const root = tmpDir('consola-wt-worktrees-');
    const service = new WorktreeService(root, resolveDriver);
    return { clone, root, service };
  }

  it('creates a PR worktree under the spec name and checks the PR out via gh', async () => {
    const { clone, root, service } = setup();

    const dir = await service.ensureWorktree(clone, pr51, { ...process.env });

    expect(dir).toBe(path.join(root, 'controller-app-pr-51'));
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(true);
    expect(currentBranch(dir)).toBe('stub-pr-51'); // the stub's checkout branch
  }, 30_000);

  it('is idempotent — a second call returns the same directory untouched', async () => {
    const { clone, service } = setup();

    const first = await service.ensureWorktree(clone, pr51, { ...process.env });
    fs.writeFileSync(path.join(first, 'wip.txt'), 'uncommitted');
    const second = await service.ensureWorktree(clone, pr51, { ...process.env });

    expect(second).toBe(first);
    expect(fs.readFileSync(path.join(first, 'wip.txt'), 'utf8')).toBe('uncommitted');
  }, 30_000);

  it('a second launch on the same item returns the same directory without a second checkout', async () => {
    const { driver, checkout } = countingDriver();
    const { clone, service } = setup(() => driver);

    const first = await service.ensureWorktree(clone, pr51, { ...process.env });
    const second = await service.ensureWorktree(clone, pr51, { ...process.env });

    // Shared by every session on the item: the fast path must not re-run the
    // provider's checkout, which would reset a branch someone is working on.
    expect(second).toBe(first);
    expect(checkout).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('recreates a worktree whose directory was deleted', async () => {
    const { clone, service } = setup();

    const dir = await service.ensureWorktree(clone, pr51, { ...process.env });
    fs.rmSync(dir, { recursive: true, force: true });

    const again = await service.ensureWorktree(clone, pr51, { ...process.env });
    expect(again).toBe(dir);
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(true);
  }, 30_000);

  it('creates issue worktrees on a consola/issue-<n> branch, reusing it if present', async () => {
    const { clone, root, service } = setup();

    const dir = await service.ensureWorktree(clone, issue87, { ...process.env });
    expect(dir).toBe(path.join(root, 'controller-app-issue-87'));
    expect(currentBranch(dir)).toBe('consola/issue-87');

    fs.rmSync(dir, { recursive: true, force: true });
    const again = await service.ensureWorktree(clone, issue87, { ...process.env });
    expect(currentBranch(again)).toBe('consola/issue-87');
  }, 30_000);

  it('rejects with git stderr when the clone cannot host a worktree', async () => {
    const empty = path.join(tmpDir('consola-wt-empty-'), 'empty');
    initRepo(empty, 'git@github.com:sympower/empty.git'); // no commits: worktree add fails
    const service = new WorktreeService(tmpDir('consola-wt-root-'));

    // git's own message for "worktree add on a repo with no commits yet" —
    // asserting this exact substring, not just "something was thrown",
    // proves the real stderr travels up rather than a generic wrapper.
    await expect(service.ensureWorktree(empty, pr51, { ...process.env })).rejects.toThrow(
      /invalid reference: HEAD/
    );
  }, 30_000);

  it('cleans up a worktree it created when the gh checkout step fails, so a later call retries', async () => {
    const { clone, root, service } = setup();
    const failEnv = { ...process.env, STUB_GH_FAIL: '1' };

    await expect(service.ensureWorktree(clone, pr51, failEnv)).rejects.toThrow(
      /gh: canned failure \(STUB_GH_FAIL=1\)/
    );

    const dir = path.join(root, 'controller-app-pr-51');
    // The half-created worktree must not survive the failed checkout, or the
    // next call's fast path would treat it as already done and never retry.
    expect(fs.existsSync(dir)).toBe(false);

    const again = await service.ensureWorktree(clone, pr51, { ...process.env });
    expect(again).toBe(dir);
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(true);
    expect(currentBranch(dir)).toBe('stub-pr-51');
  }, 30_000);

  it('refuses a worktree-name collision between two repos with the same basename', async () => {
    // Two different clones — different orgs, same basename "controller-app" —
    // land in the same worktrees root, so `worktreeDirName` collides:
    // both would compute "controller-app-pr-51".
    const root = tmpDir('consola-wt-worktrees-');
    const service = new WorktreeService(root);

    const cloneA = path.join(tmpDir('consola-wt-clone-a-'), 'controller-app');
    initCloneWithCommit(cloneA, 'git@github.com:sympower/controller-app.git');
    const dirA = await service.ensureWorktree(cloneA, pr51, { ...process.env });
    expect(dirA).toBe(path.join(root, 'controller-app-pr-51'));

    const cloneB = path.join(tmpDir('consola-wt-clone-b-'), 'controller-app');
    initCloneWithCommit(cloneB, 'git@github.com:javier/controller-app.git');

    // cloneB's work item hashes to the exact same directory name as cloneA's,
    // which the fast path must recognise as belonging to cloneA and refuse —
    // never silently hand back cloneA's worktree for cloneB's PR.
    await expect(service.ensureWorktree(cloneB, pr51, { ...process.env })).rejects.toThrow(
      /different repository/
    );
    // Refusing must not touch cloneA's worktree.
    expect(fs.existsSync(path.join(dirA, '.git'))).toBe(true);
  }, 30_000);
});

describe('WorktreeService.prune', () => {
  const pr51 = { provider: 'github', repo: 'sympower/controller-app', type: 'pr', number: 51 } as const;

  it('refuses while the worktree holds uncommitted changes', async () => {
    const clone = path.join(tmpDir('consola-wt-prune-'), 'controller-app');
    initCloneWithCommit(clone, 'git@github.com:sympower/controller-app.git');
    const service = new WorktreeService(tmpDir('consola-wt-root-'));
    const dir = await service.ensureWorktree(clone, pr51, { ...process.env });

    fs.writeFileSync(path.join(dir, 'wip.txt'), 'uncommitted');
    await expect(service.prune(dir)).rejects.toThrow(/uncommitted/);
    expect(fs.existsSync(dir)).toBe(true);
  }, 30_000);

  it('removes a clean worktree and unregisters it', async () => {
    const clone = path.join(tmpDir('consola-wt-prune-'), 'controller-app');
    initCloneWithCommit(clone, 'git@github.com:sympower/controller-app.git');
    const service = new WorktreeService(tmpDir('consola-wt-root-'));
    const dir = await service.ensureWorktree(clone, pr51, { ...process.env });

    await service.prune(dir);

    expect(fs.existsSync(dir)).toBe(false);
    const list = execFileSync('git', ['-C', clone, 'worktree', 'list'], { encoding: 'utf8' });
    expect(list).not.toContain('controller-app-pr-51');
  }, 30_000);
});
