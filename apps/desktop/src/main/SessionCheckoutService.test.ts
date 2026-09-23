import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionCheckoutService } from './SessionCheckoutService';

let root: string;
let repo: string;
let service: SessionCheckoutService;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-checkout-')));
  repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial');
  service = new SessionCheckoutService(path.join(root, 'worktrees'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('conversation checkouts', () => {
  it('lists branches, detached worktrees and paths with spaces without losing membership', async () => {
    git(repo, 'branch', 'feature/ui');
    git(repo, 'worktree', 'add', '--detach', path.join(root, 'detached folder'));
    const context = await service.list(repo);
    expect(context.branch).toBe('main');
    expect(context.localBranches).toContain('feature/ui');
    expect(context.worktrees).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: repo, branch: 'main', current: true }),
      expect.objectContaining({ path: path.join(root, 'detached folder'), branch: undefined, current: false }),
    ]));
  });

  it('creates a named branch from the selected base and preserves dirty files in the current checkout', async () => {
    fs.writeFileSync(path.join(repo, 'in-progress.txt'), 'keep me');
    const cwd = await service.prepare(repo, { mode: 'new', baseRef: 'main', branchName: 'feature/new-ui' });
    expect(git(cwd, 'branch', '--show-current')).toBe('feature/new-ui');
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'main'));
    expect(git(repo, 'branch', '--show-current')).toBe('main');
    expect(fs.readFileSync(path.join(repo, 'in-progress.txt'), 'utf8')).toBe('keep me');
    expect(fs.existsSync(path.join(cwd, 'in-progress.txt'))).toBe(false);
  });

  it('reuses an existing worktree and an already checked-out branch', async () => {
    const cwd = await service.prepare(repo, { mode: 'new', baseRef: 'main', branchName: 'feature/reuse' });
    expect(await service.prepare(repo, { mode: 'existing', path: cwd })).toBe(cwd);
    expect(await service.prepare(repo, { mode: 'new', baseRef: 'feature/reuse', useExistingBranch: true })).toBe(cwd);
    expect((await service.list(repo)).worktrees).toHaveLength(2);
  });

  it('checks out an unused local branch without creating or resetting it', async () => {
    git(repo, 'branch', 'feature/existing');
    const cwd = await service.prepare(repo, { mode: 'new', baseRef: 'feature/existing', useExistingBranch: true });
    expect(git(cwd, 'branch', '--show-current')).toBe('feature/existing');
  });

  it('rejects invalid refs and duplicate names without adding worktrees', async () => {
    await expect(service.prepare(repo, { mode: 'new', baseRef: '--help' })).rejects.toThrow('valid base branch');
    await expect(service.prepare(repo, { mode: 'new', baseRef: 'missing' })).rejects.toThrow();
    await expect(service.prepare(repo, { mode: 'new', baseRef: 'main', branchName: '../escape' })).rejects.toThrow();
    await expect(service.prepare(repo, { mode: 'new', baseRef: 'main', branchName: 'main' })).rejects.toThrow();
    expect((await service.list(repo)).worktrees).toHaveLength(1);
  });

  it('rejects unrelated and deleted worktrees', async () => {
    await expect(service.prepare(repo, { mode: 'existing', path: root })).rejects.toThrow('no longer available');
    const cwd = await service.prepare(repo, { mode: 'new', baseRef: 'main' });
    fs.rmSync(cwd, { recursive: true, force: true });
    await expect(service.prepare(repo, { mode: 'existing', path: cwd })).rejects.toThrow('no longer available');
  });

  it('supports non-git folders in current checkout mode', async () => {
    expect(await service.prepare(root, { mode: 'current' })).toBe(root);
    await expect(service.prepare(path.join(root, 'missing'), { mode: 'current' })).rejects.toThrow();
  });
});
