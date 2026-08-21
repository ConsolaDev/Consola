import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Scope, Workspace } from '../shared/workspace';
import { WorktreeService, normalizeRemote, worktreeDirName } from './WorktreeService';

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

function makeWorkspace(scopes: Scope[]): Workspace {
  const now = Date.now();
  return {
    id: 'ws-1',
    name: 'Sympower',
    defaultHarnessId: 'default',
    scopes,
    groups: [],
    github: { accountLogin: 'SymJavi', org: 'sympower' },
    sessions: [],
    createdAt: now,
    updatedAt: now,
  } as Workspace;
}

describe('normalizeRemote', () => {
  it('parses scp-style ssh remotes', () => {
    expect(normalizeRemote('git@github.com:Sympower/Controller-App.git')).toBe(
      'sympower/controller-app'
    );
  });

  it('parses https remotes with and without .git', () => {
    expect(normalizeRemote('https://github.com/sympower/flex-portal.git')).toBe(
      'sympower/flex-portal'
    );
    expect(normalizeRemote('https://github.com/sympower/flex-portal')).toBe(
      'sympower/flex-portal'
    );
  });

  it('parses ssh:// remotes', () => {
    expect(normalizeRemote('ssh://git@github.com/sympower/flextools.git')).toBe(
      'sympower/flextools'
    );
  });

  it('returns null for remotes it cannot read', () => {
    expect(normalizeRemote('/some/local/path')).toBeNull();
    expect(normalizeRemote('')).toBeNull();
  });
});

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
    const service = new WorktreeService(tmpDir('consola-wt-root-'), async () => 'gh');
    const workspace = makeWorkspace([makeScope(repoScope, true)]);
    expect(service.resolveRepo(workspace, 'sympower/controller-app')).toBe(repoScope);
  });

  it('scans a container scope one level deep', () => {
    const service = new WorktreeService(tmpDir('consola-wt-root-'), async () => 'gh');
    const workspace = makeWorkspace([makeScope(containerScope, false)]);
    expect(service.resolveRepo(workspace, 'sympower/flex-portal')).toBe(childClone);
  });

  it('returns null when no scope holds the repo', () => {
    const service = new WorktreeService(tmpDir('consola-wt-root-'), async () => 'gh');
    const workspace = makeWorkspace([makeScope(repoScope, true), makeScope(containerScope, false)]);
    expect(service.resolveRepo(workspace, 'sympower/msa-resource-bff')).toBeNull();
  });

  it('caches remote lookups until invalidate()', () => {
    const service = new WorktreeService(tmpDir('consola-wt-root-'), async () => 'gh');
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
    const service = new WorktreeService(tmpDir('consola-wt-root-'), async () => 'gh');
    const missing = path.join(tmpDir('consola-wt-missing-'), 'moved-away');
    const workspace = makeWorkspace([makeScope(missing, false)]);

    expect(service.resolveRepo(workspace, 'sympower/controller-app')).toBeNull();
  });
});

const STUB_GH = path.resolve(__dirname, '../../tests/fixtures/stub-gh/gh');

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

describe('WorktreeService.ensureWorktree', () => {
  const pr51 = { provider: 'github', repo: 'sympower/controller-app', type: 'pr', number: 51 } as const;
  const issue87 = { provider: 'github', repo: 'sympower/controller-app', type: 'issue', number: 87 } as const;

  function setup() {
    const clone = path.join(tmpDir('consola-wt-clone-'), 'controller-app');
    initCloneWithCommit(clone, 'git@github.com:sympower/controller-app.git');
    const root = tmpDir('consola-wt-worktrees-');
    const service = new WorktreeService(root, async () => STUB_GH);
    return { clone, root, service };
  }

  it('creates a PR worktree under the spec name and checks the PR out via gh', async () => {
    const { clone, root, service } = setup();

    const dir = await service.ensureWorktree(clone, pr51, { ...process.env });

    expect(dir).toBe(path.join(root, 'controller-app-pr-51'));
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(true);
    expect(currentBranch(dir)).toBe('stub-pr-51'); // the stub's checkout branch
  });

  it('is idempotent — a second call returns the same directory untouched', async () => {
    const { clone, service } = setup();

    const first = await service.ensureWorktree(clone, pr51, { ...process.env });
    fs.writeFileSync(path.join(first, 'wip.txt'), 'uncommitted');
    const second = await service.ensureWorktree(clone, pr51, { ...process.env });

    expect(second).toBe(first);
    expect(fs.readFileSync(path.join(first, 'wip.txt'), 'utf8')).toBe('uncommitted');
  });

  it('recreates a worktree whose directory was deleted', async () => {
    const { clone, service } = setup();

    const dir = await service.ensureWorktree(clone, pr51, { ...process.env });
    fs.rmSync(dir, { recursive: true, force: true });

    const again = await service.ensureWorktree(clone, pr51, { ...process.env });
    expect(again).toBe(dir);
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(true);
  });

  it('creates issue worktrees on a consola/issue-<n> branch, reusing it if present', async () => {
    const { clone, root, service } = setup();

    const dir = await service.ensureWorktree(clone, issue87, { ...process.env });
    expect(dir).toBe(path.join(root, 'controller-app-issue-87'));
    expect(currentBranch(dir)).toBe('consola/issue-87');

    fs.rmSync(dir, { recursive: true, force: true });
    const again = await service.ensureWorktree(clone, issue87, { ...process.env });
    expect(currentBranch(again)).toBe('consola/issue-87');
  });

  it('rejects with git stderr when the clone cannot host a worktree', async () => {
    const empty = path.join(tmpDir('consola-wt-empty-'), 'empty');
    initRepo(empty, 'git@github.com:sympower/empty.git'); // no commits: worktree add fails
    const service = new WorktreeService(tmpDir('consola-wt-root-'), async () => STUB_GH);

    await expect(
      service.ensureWorktree(empty, pr51, { ...process.env })
    ).rejects.toThrow(/./); // the git message travels up verbatim
  });
});

describe('WorktreeService.prune', () => {
  const pr51 = { provider: 'github', repo: 'sympower/controller-app', type: 'pr', number: 51 } as const;

  it('refuses while the worktree holds uncommitted changes', async () => {
    const clone = path.join(tmpDir('consola-wt-prune-'), 'controller-app');
    initCloneWithCommit(clone, 'git@github.com:sympower/controller-app.git');
    const service = new WorktreeService(tmpDir('consola-wt-root-'), async () => STUB_GH);
    const dir = await service.ensureWorktree(clone, pr51, { ...process.env });

    fs.writeFileSync(path.join(dir, 'wip.txt'), 'uncommitted');
    await expect(service.prune(dir)).rejects.toThrow(/uncommitted/);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('removes a clean worktree and unregisters it', async () => {
    const clone = path.join(tmpDir('consola-wt-prune-'), 'controller-app');
    initCloneWithCommit(clone, 'git@github.com:sympower/controller-app.git');
    const service = new WorktreeService(tmpDir('consola-wt-root-'), async () => STUB_GH);
    const dir = await service.ensureWorktree(clone, pr51, { ...process.env });

    await service.prune(dir);

    expect(fs.existsSync(dir)).toBe(false);
    const list = execFileSync('git', ['-C', clone, 'worktree', 'list'], { encoding: 'utf8' });
    expect(list).not.toContain('controller-app-pr-51');
  });
});
