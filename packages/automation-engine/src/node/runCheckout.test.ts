import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunCheckoutError } from '../steps/runCheckout';
import { makeRunClone, runCloneGitDirFor } from './runCheckout';

/*
 * A run's own checkout (slice 3-B), against real git in temporary folders: a
 * `--shared` clone of the person's clone whose git folder is outside the
 * checkout (Call 9), on a branch cut from the remote's default branch.
 *
 * The person's own git configuration stays out of every row (review M1):
 * these tests run outside `safe.sh`, so `~/.gitconfig`'s signing, templates
 * or hooks would otherwise reach their setup commits. Each row points git at
 * a global config of its own (`<tmp>/gitconfig`, holding only what a row
 * sets) and turns the system one off.
 */

let tmp: string;
let remote: string;
let source: string;
let dir: string;

/** git in `cwd`, as the person runs it. */
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: process.env }).trim();
/** git in the run clone, its git folder named: never discovered from the checkout. */
const run = (checkout: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd: checkout,
    encoding: 'utf8',
    env: { ...process.env, GIT_DIR: runCloneGitDirFor(checkout), GIT_WORK_TREE: checkout },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

/** sha256 of every regular file under `root`, by relative path; a link read as its target's text. */
function hashTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (relative: string) => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const inside = relative === '' ? entry.name : `${relative}/${entry.name}`;
      const full = path.join(root, inside);
      if (entry.isSymbolicLink()) out[inside] = `link:${fs.readlinkSync(full)}`;
      else if (entry.isDirectory()) walk(inside);
      else if (entry.isFile())
        out[inside] = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk('');
  return out;
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-run-checkout-')));
  fs.writeFileSync(path.join(tmp, 'gitconfig'), '');
  vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(tmp, 'gitconfig'));
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  remote = path.join(tmp, 'remote.git');
  source = path.join(tmp, 'catalog-portal');
  git(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
  git(tmp, 'clone', '-q', remote, source);
  git(source, 'config', 'user.name', 'alice');
  git(source, 'config', 'user.email', 'alice@sprocket.example');
  fs.writeFileSync(path.join(source, 'README.md'), 'catalog-portal\n');
  git(source, 'add', '-A');
  git(source, 'commit', '-q', '-m', 'first');
  git(source, 'push', '-q', 'origin', 'HEAD:main');
  git(source, 'checkout', '-q', '-b', 'release');
  fs.writeFileSync(path.join(source, 'RELEASE.md'), 'v1\n');
  git(source, 'add', '-A');
  git(source, 'commit', '-q', '-m', 'release');
  git(source, 'push', '-q', 'origin', 'HEAD:release');
  git(source, 'checkout', '-q', 'main');
  // The remote moves on after the person's clone last fetched: the run cuts from the remote, not the clone.
  const other = path.join(tmp, 'other');
  git(tmp, 'clone', '-q', remote, other);
  fs.writeFileSync(path.join(other, 'NEWER.md'), 'newer\n');
  git(other, 'add', '-A');
  git(
    other,
    '-c',
    'user.name=bob',
    '-c',
    'user.email=bob@sprocket.example',
    'commit',
    '-q',
    '-m',
    'newer',
  );
  git(other, 'push', '-q', 'origin', 'HEAD:main');
  fs.mkdirSync(path.join(tmp, 'worktrees'));
  dir = path.join(tmp, 'worktrees', 'catalog-portal-run-3f2a91c0');
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('runCloneGitDirFor', () => {
  it('is the checkout name under run-git, beside the worktree root (Call 9)', () => {
    expect(runCloneGitDirFor('/home/alice/.consola/worktrees/catalog-portal-run-3f2a91c0')).toBe(
      '/home/alice/.consola/run-git/catalog-portal-run-3f2a91c0.git',
    );
  });
});

describe('makeRunClone', () => {
  it('makes a clone of its own, on the branch, at the remote default branch', async () => {
    const { base } = await makeRunClone({
      source,
      dir,
      branch: 'fix/SHOP-42',
      runId: '3f2a91c0aa',
      fetchEnv: process.env,
    });
    const gitDir = runCloneGitDirFor(dir);
    expect(gitDir).toBe(path.join(tmp, 'run-git', 'catalog-portal-run-3f2a91c0.git'));
    expect(path.relative(dir, gitDir).startsWith('..')).toBe(true);
    expect(fs.lstatSync(path.join(dir, '.git')).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(dir, '.git'), 'utf8')).toBe(`gitdir: ${gitDir}\n`);
    expect(fs.readFileSync(path.join(gitDir, 'objects/info/alternates'), 'utf8').trim()).toBe(
      fs.realpathSync(path.join(source, '.git/objects')),
    );
    expect(run(dir, 'remote', 'get-url', 'origin')).toBe(
      git(source, 'remote', 'get-url', 'origin'),
    );
    expect(run(dir, 'symbolic-ref', 'HEAD')).toBe('refs/heads/fix/SHOP-42');
    expect(run(dir, 'rev-parse', 'HEAD')).toBe(base);
    expect(base).toBe(git(remote, 'rev-parse', 'main'));
    // The remote's newer commit, not the person's clone's older main.
    expect(base).not.toBe(git(source, 'rev-parse', 'main'));
    expect(fs.readFileSync(path.join(dir, 'NEWER.md'), 'utf8')).toBe('newer\n');
    expect(run(dir, 'status', '--porcelain')).toBe('');
    const config = (key: string) =>
      git(gitDir, 'config', '--file', path.join(gitDir, 'config'), key);
    expect(config('user.name')).toBe('alice');
    expect(config('user.email')).toBe('alice@sprocket.example');
    expect(config('consola.run')).toBe('3f2a91c0aa');
    expect(config('consola.source')).toBe(source);
    expect(config('consola.alternates')).toBe(fs.realpathSync(path.join(source, '.git/objects')));
    expect(fs.readFileSync(path.join(gitDir, 'info/exclude'), 'utf8')).toContain('.consola-cache/');
    expect(() => run(dir, 'rev-parse', '--abbrev-ref', '@{upstream}')).toThrow();
    // Nothing points the folder pair at each other but the path: no core.worktree.
    expect(() => config('core.worktree')).toThrow();
  });

  it('cuts from the branch from: names', async () => {
    const { base } = await makeRunClone({
      source,
      dir,
      branch: 'fix/a',
      from: 'release',
      runId: 'r',
      fetchEnv: process.env,
    });
    expect(base).toBe(git(remote, 'rev-parse', 'release'));
    expect(fs.existsSync(path.join(dir, 'RELEASE.md'))).toBe(true);
  });

  it("runs no hook of the person's clone or of their template folder (review M11)", async () => {
    const marker = path.join(tmp, 'hook-ran');
    for (const hook of ['post-checkout', 'reference-transaction', 'post-index-change']) {
      fs.writeFileSync(path.join(source, '.git/hooks', hook), `#!/bin/sh\ntouch '${marker}'\n`, {
        mode: 0o755,
      });
    }
    git(source, 'config', 'core.hooksPath', path.join(source, '.git/hooks'));
    fs.mkdirSync(path.join(tmp, 'template/hooks'), { recursive: true });
    for (const hook of ['post-checkout', 'reference-transaction'])
      fs.writeFileSync(path.join(tmp, 'template/hooks', hook), `#!/bin/sh\ntouch '${marker}'\n`, {
        mode: 0o755,
      });
    // The person's global config names the template folder, as `init.templateDir` would.
    git(
      tmp,
      'config',
      '--file',
      path.join(tmp, 'gitconfig'),
      'init.templateDir',
      path.join(tmp, 'template'),
    );
    git(
      tmp,
      'config',
      '--file',
      path.join(tmp, 'gitconfig'),
      'core.hooksPath',
      path.join(tmp, 'template/hooks'),
    );
    // The setup itself runs a hook, so the marker is real.
    git(source, 'checkout', '-q', 'release');
    git(source, 'checkout', '-q', 'main');
    expect(fs.existsSync(marker)).toBe(true);
    fs.rmSync(marker);
    await makeRunClone({
      source,
      dir,
      branch: 'fix/SHOP-42',
      runId: '3f2a91c0aa',
      fetchEnv: process.env,
    });
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(path.join(runCloneGitDirFor(dir), 'hooks'))).toBe(false);
  });

  it("runs no filter the person's global config names for the repository's .gitattributes", async () => {
    const marker = path.join(tmp, 'filter-ran');
    const other = path.join(tmp, 'other');
    fs.writeFileSync(path.join(other, '.gitattributes'), '* filter=mark\n');
    git(other, 'add', '-A');
    git(
      other,
      '-c',
      'user.name=bob',
      '-c',
      'user.email=bob@sprocket.example',
      'commit',
      '-q',
      '-m',
      'attributes',
    );
    git(other, 'push', '-q', 'origin', 'HEAD:main');
    git(
      tmp,
      'config',
      '--file',
      path.join(tmp, 'gitconfig'),
      'filter.mark.smudge',
      `touch '${marker}'; cat`,
    );
    await makeRunClone({ source, dir, branch: 'fix/SHOP-42', runId: 'r', fetchEnv: process.env });
    expect(fs.existsSync(path.join(dir, '.gitattributes'))).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('names the git folder as Consola names it, and the alternates by their real path, through linked folders', async () => {
    // `~/.consola` reached through a link: git itself would write the real path into the pointer.
    fs.mkdirSync(path.join(tmp, 'home/worktrees'), { recursive: true });
    const linkedHome = path.join(tmp, 'home-link');
    fs.symlinkSync(path.join(tmp, 'home'), linkedHome);
    const linkedSource = path.join(tmp, 'source-link');
    fs.symlinkSync(source, linkedSource);
    const linkedDir = path.join(linkedHome, 'worktrees', 'catalog-portal-run-3f2a91c0');
    await makeRunClone({
      source: linkedSource,
      dir: linkedDir,
      branch: 'fix/a',
      runId: 'r',
      fetchEnv: process.env,
    });
    const gitDir = runCloneGitDirFor(linkedDir);
    expect(gitDir).toBe(path.join(linkedHome, 'run-git', 'catalog-portal-run-3f2a91c0.git'));
    expect(fs.readFileSync(path.join(linkedDir, '.git'), 'utf8')).toBe(`gitdir: ${gitDir}\n`);
    expect(fs.readFileSync(path.join(gitDir, 'objects/info/alternates'), 'utf8').trim()).toBe(
      path.join(source, '.git/objects'),
    );
  });

  it.each<[string, () => void, string]>([
    ['fetch', () => fs.rmSync(remote, { recursive: true }), 'fetch'],
    ['identity', () => git(source, 'config', '--unset', 'user.email'), 'identity'],
    ['origin', () => git(source, 'remote', 'remove', 'origin'), 'origin'],
  ])('fails at %s and leaves nothing', async (_what, breakIt, stage) => {
    breakIt();
    const made = makeRunClone({
      source,
      dir,
      branch: 'fix/SHOP-42',
      runId: 'r',
      fetchEnv: process.env,
    });
    await expect(made).rejects.toBeInstanceOf(RunCheckoutError);
    await expect(made).rejects.toMatchObject({ stage });
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(runCloneGitDirFor(dir))).toBe(false);
  });

  it('a branch git refuses fails at branch and leaves nothing', async () => {
    const made = makeRunClone({
      source,
      dir,
      branch: 'fix/..x',
      runId: 'r',
      fetchEnv: process.env,
    });
    await expect(made).rejects.toMatchObject({ stage: 'branch' });
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(runCloneGitDirFor(dir))).toBe(false);
  });

  it('the identity words say what to set', async () => {
    git(source, 'config', '--unset', 'user.name');
    await expect(
      makeRunClone({ source, dir, branch: 'fix/a', runId: 'r', fetchEnv: process.env }),
    ).rejects.toThrow('set user.name and user.email in git');
  });

  it('never touches a folder that is already there and not empty, and says so', async () => {
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'theirs.txt'), 'keep me');
    await expect(
      makeRunClone({ source, dir, branch: 'fix/a', runId: 'r', fetchEnv: process.env }),
    ).rejects.toMatchObject({ stage: 'clone' });
    expect(fs.readFileSync(path.join(dir, 'theirs.txt'), 'utf8')).toBe('keep me');
    fs.rmSync(dir, { recursive: true });
    const gitDir = runCloneGitDirFor(dir);
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'HEAD'), 'theirs');
    await expect(
      makeRunClone({ source, dir, branch: 'fix/a', runId: 'r', fetchEnv: process.env }),
    ).rejects.toMatchObject({ stage: 'clone' });
    expect(fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8')).toBe('theirs');
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("leaves the person's clone's refs, packed-refs and HEAD as they were", async () => {
    const watched = () => ({
      refs: hashTree(path.join(source, '.git/refs')),
      packed: fs.existsSync(path.join(source, '.git/packed-refs'))
        ? fs.readFileSync(path.join(source, '.git/packed-refs'), 'utf8')
        : null,
      head: fs.readFileSync(path.join(source, '.git/HEAD'), 'utf8'),
      config: fs.readFileSync(path.join(source, '.git/config'), 'utf8'),
    });
    const before = watched();
    await makeRunClone({ source, dir, branch: 'fix/SHOP-42', runId: 'r', fetchEnv: process.env });
    expect(watched()).toEqual(before);
  });

  it('ignores a GIT_DIR or GIT_WORK_TREE the login environment exports', async () => {
    const elsewhere = path.join(tmp, 'elsewhere');
    git(tmp, 'init', '-q', '-b', 'main', elsewhere);
    const env = { ...process.env, GIT_DIR: path.join(elsewhere, '.git'), GIT_WORK_TREE: elsewhere };
    await makeRunClone({ source, dir, branch: 'fix/SHOP-42', runId: 'r', fetchEnv: env });
    expect(run(dir, 'symbolic-ref', 'HEAD')).toBe('refs/heads/fix/SHOP-42');
    expect(fs.readdirSync(path.join(elsewhere, '.git/refs/heads'))).toEqual([]);
  });
});
