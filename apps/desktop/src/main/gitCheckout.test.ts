import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readCheckout } from './gitCheckout';

let root: string;
let repo: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-git-checkout-')));
  repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('readCheckout', () => {
  it("reads a repository's own checkout as main, from its root or a subfolder", async () => {
    fs.mkdirSync(path.join(repo, 'src'));
    const expected = { kind: 'main', root: repo, mainCheckout: repo, branch: 'main' };
    expect(await readCheckout(repo)).toEqual(expected);
    expect(await readCheckout(path.join(repo, 'src'))).toEqual(expected);
  });

  it('reads a linked worktree with its own branch and the checkout it hangs off', async () => {
    const tree = path.join(root, 'trees', 'repo-session-1');
    git(repo, 'worktree', 'add', '-b', 'feature/login', tree);
    expect(await readCheckout(tree)).toEqual({
      kind: 'worktree',
      root: tree,
      mainCheckout: repo,
      branch: 'feature/login',
    });
  });

  it('gives the abbreviated commit instead of a branch when HEAD is detached', async () => {
    const tree = path.join(root, 'detached tree');
    git(repo, 'worktree', 'add', '--detach', tree);
    const info = await readCheckout(tree);
    expect(info).toMatchObject({ kind: 'worktree', root: tree, mainCheckout: repo });
    expect(info).not.toHaveProperty('branch');
    expect(git(repo, 'rev-parse', 'HEAD').startsWith((info as { head: string }).head)).toBe(true);
  });

  it('keeps reading a branch that has no commits yet', async () => {
    const fresh = path.join(root, 'fresh');
    fs.mkdirSync(fresh);
    git(fresh, 'init', '-b', 'trunk');
    expect(await readCheckout(fresh)).toEqual({ kind: 'main', root: fresh, mainCheckout: fresh, branch: 'trunk' });
  });

  it('reads a plain folder or a missing one as no checkout', async () => {
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    expect(await readCheckout(plain)).toEqual({ kind: 'none' });
    expect(await readCheckout(path.join(root, 'gone'))).toEqual({ kind: 'none' });
  });
});
