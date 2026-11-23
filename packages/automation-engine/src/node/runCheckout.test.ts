import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunCheckoutError } from '../steps/runCheckout';
import {
  deleteRunClone,
  fetchKeepRef,
  gitFolderProblem,
  makeRunClone,
  rebuildRunClone,
  resetRunClone,
  runCloneChanges,
  runCloneGit,
  runCloneGitDirFor,
  runCloneGitEnv,
  runCloneShowAt,
  settleBetweenSteps,
  settleRunClone,
  stageByDescriptor,
  stageChecked,
  treeProblem,
} from './runCheckout';

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

  describe("a quit while the checkout was made: made again when the run's record claims it (3-B code review F10)", () => {
    const RUN = '3f2a91c0aa';
    const make = (again?: true) =>
      makeRunClone({
        source,
        dir,
        branch: 'fix/SHOP-42',
        runId: RUN,
        fetchEnv: process.env,
        ...(again ? { again } : {}),
      });
    /** What `config --file` says of a key in the git folder's config, '' when unset. */
    const configured = (key: string) => {
      try {
        return git(tmp, 'config', '--file', path.join(runCloneGitDirFor(dir), 'config'), key);
      } catch {
        return '';
      }
    };
    /** The pair as a quit at each point of `buildRunClone` leaves it, from a whole one taken back. */
    const QUIT_AT: Array<[string, () => Promise<void>]> = [
      [
        'during the clone: a pointer and part of a git folder',
        async () => {
          const gitDir = runCloneGitDirFor(dir);
          fs.mkdirSync(path.join(gitDir, 'objects', 'pack'), { recursive: true });
          fs.writeFileSync(path.join(gitDir, 'config'), '[core]\n\trepositoryformatversion = 0\n');
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${gitDir}\n`);
        },
      ],
      [
        'after the clone, the fetch and the branch, before the identity',
        async () => {
          await make();
          const gitDir = runCloneGitDirFor(dir);
          git(tmp, 'config', '--file', path.join(gitDir, 'config'), '--remove-section', 'consola');
          fs.rmSync(path.join(gitDir, 'info', 'attributes'));
          fs.rmSync(`${gitDir}.consola.json`);
        },
      ],
      [
        'after the identity, before the exclude, the attributes and the record',
        async () => {
          await make();
          const gitDir = runCloneGitDirFor(dir);
          fs.rmSync(path.join(gitDir, 'info', 'attributes'));
          fs.rmSync(`${gitDir}.consola.json`);
        },
      ],
      ['once it was made, before the run recorded it', async () => make().then(() => {})],
      [
        'a checkout folder only, its git folder never begun',
        async () => {
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${runCloneGitDirFor(dir)}\n`);
        },
      ],
    ];

    it.each(QUIT_AT)('%s', async (_, leave) => {
      await leave();
      // As before, a make the record does not vouch for touches none of it.
      await expect(make()).rejects.toMatchObject({ stage: 'clone' });
      const { base } = await make(true);
      expect(base).toBe(git(remote, 'rev-parse', 'main'));
      expect(gitFolderProblem(dir)).toBeNull();
      expect(run(dir, 'symbolic-ref', 'HEAD')).toBe('refs/heads/fix/SHOP-42');
      expect(configured('consola.run')).toBe(RUN);
      expect(run(dir, 'status', '--porcelain')).toBe('');
    });

    it('refuses a git folder that names another run, and leaves both folders as they are', async () => {
      await make();
      const gitDir = runCloneGitDirFor(dir);
      git(tmp, 'config', '--file', path.join(gitDir, 'config'), 'consola.run', 'another-run');
      const before = hashTree(gitDir);
      await expect(make(true)).rejects.toThrow(/names another run/);
      expect(hashTree(gitDir)).toEqual(before);
      expect(fs.existsSync(path.join(dir, '.git'))).toBe(true);
    });

    it.each<[string, () => string]>([
      [
        'the checkout folder',
        () => {
          const elsewhere = path.join(tmp, 'elsewhere');
          fs.mkdirSync(elsewhere);
          fs.writeFileSync(path.join(elsewhere, 'theirs.txt'), 'keep me');
          fs.symlinkSync(elsewhere, dir);
          return path.join(elsewhere, 'theirs.txt');
        },
      ],
      [
        'the git folder',
        () => {
          const elsewhere = path.join(tmp, 'elsewhere.git');
          fs.mkdirSync(elsewhere);
          fs.writeFileSync(path.join(elsewhere, 'HEAD'), 'keep me');
          fs.mkdirSync(path.dirname(runCloneGitDirFor(dir)), { recursive: true });
          fs.symlinkSync(elsewhere, runCloneGitDirFor(dir));
          return path.join(elsewhere, 'HEAD');
        },
      ],
    ])('refuses %s when it is a link, and leaves what it leads to', async (_, plant) => {
      const kept = plant();
      await expect(make(true)).rejects.toThrow(/is not a folder/);
      expect(fs.readFileSync(kept, 'utf8')).toBe('keep me');
    });
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

describe("checking, committing and resetting a run's checkout (Task 11)", () => {
  const BRANCH = 'fix/SHOP-42';
  let base: string;
  let gitDir: string;
  let attemptDir: string;
  let REQ: Parameters<typeof settleRunClone>[0];

  const writeFile = (root: string, file: string, text: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  const patchText = () =>
    fs.existsSync(path.join(attemptDir, 'changes.patch'))
      ? fs.readFileSync(path.join(attemptDir, 'changes.patch'), 'utf8')
      : '';

  beforeEach(async () => {
    ({ base } = await makeRunClone({
      source,
      dir,
      branch: BRANCH,
      runId: '3f2a91c0aa',
      fetchEnv: process.env,
    }));
    gitDir = runCloneGitDirFor(dir);
    attemptDir = path.join(tmp, 'attempt');
    fs.mkdirSync(attemptDir);
    REQ = {
      dir,
      branch: BRANCH,
      base,
      before: base,
      commit: { message: 'fix (attempt 1) of ui-bug-to-pr on SHOP-42' },
      attemptDir,
      step: 'fix',
    };
  });

  it('runCloneGitEnv names the git folder and keeps every outside setting out', () => {
    const env = runCloneGitEnv(dir, {
      PATH: '/usr/bin',
      GIT_DIR: '/elsewhere',
      GIT_INDEX_FILE: '/x',
    });
    expect(env).toMatchObject({
      PATH: '/usr/bin',
      GIT_DIR: gitDir,
      GIT_WORK_TREE: dir,
      GIT_COMMON_DIR: gitDir,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_GRAFT_FILE: '/dev/null',
    });
    expect(env.GIT_INDEX_FILE).toBeUndefined();
    const pairs = Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [
      env[`GIT_CONFIG_KEY_${i}`],
      env[`GIT_CONFIG_VALUE_${i}`],
    ]);
    expect(pairs).toEqual(
      expect.arrayContaining([
        ['core.hooksPath', '/dev/null'],
        ['core.fsmonitor', 'false'],
        ['commit.gpgsign', 'false'],
        ['core.untrackedCache', 'false'],
        ['core.attributesFile', '/dev/null'],
      ]),
    );
  });

  it("commits what a step left, with Consola's message and the clone's identity, and records it", async () => {
    writeFile(dir, 'src/app.ts', 'fixed');
    writeFile(dir, '.github/workflows/ci.yml', 'x');
    const r = await settleRunClone(REQ);
    expect(r).toMatchObject({ ok: true, files: 2, flagged: ['.github/workflows/ci.yml'] });
    expect(run(dir, 'log', '-1', '--format=%s|%ae')).toBe(
      'fix (attempt 1) of ui-bug-to-pr on SHOP-42|alice@sprocket.example',
    );
    expect(r.ok && r.after).toBe(run(dir, 'rev-parse', 'HEAD'));
    expect(run(dir, 'rev-parse', 'HEAD~1')).toBe(base);
    expect(patchText()).toContain('+fixed');
  });

  it('a step that left nothing commits nothing: after is where it is', async () => {
    expect(await settleRunClone(REQ)).toEqual({ ok: true, after: base, files: 0, flagged: [] });
    expect(run(dir, 'rev-parse', 'HEAD')).toBe(base);
  });

  it("keeps an agent's own commit on host when it descends from before, and adds its own on top (M11)", async () => {
    writeFile(dir, 'a.txt', 'agent');
    run(dir, 'add', '-A');
    run(dir, 'commit', '-qm', 'agent fix');
    const agentCommit = run(dir, 'rev-parse', 'HEAD');
    writeFile(dir, 'b.txt', 'left');
    expect(await settleRunClone(REQ)).toMatchObject({ ok: true, files: 2 });
    expect(run(dir, 'rev-parse', 'HEAD~1')).toBe(agentCommit);
    expect(run(dir, 'log', '--format=%s', `${base}..HEAD`).split('\n')).toEqual([
      'fix (attempt 1) of ui-bug-to-pr on SHOP-42',
      'agent fix',
    ]);
  });

  it('a moved HEAD fails the step and commits nothing', async () => {
    run(dir, 'checkout', '-q', '--detach');
    writeFile(dir, 'src/app.ts', 'x');
    expect(await settleRunClone(REQ)).toEqual({
      ok: false,
      error: 'the step moved `HEAD` off fix/SHOP-42',
    });
    expect(run(dir, 'rev-parse', 'HEAD')).toBe(base);
  });

  it('a branch moved off where the step started fails the step', async () => {
    const first = git(remote, 'rev-list', '--max-parents=0', 'main');
    run(dir, 'update-ref', `refs/heads/${BRANCH}`, first);
    expect(await settleRunClone(REQ)).toEqual({
      ok: false,
      error: `the step moved fix/SHOP-42 off the commit it started from (${base.slice(0, 7)})`,
    });
  });

  it.each<[string, () => void]>([
    [
      'commondir',
      () => fs.writeFileSync(path.join(gitDir, 'commondir'), path.join(source, '.git')),
    ],
    ['gitdir', () => fs.writeFileSync(path.join(gitDir, 'gitdir'), path.join(dir, '.git'))],
    [
      'a link in refs',
      () => {
        fs.rmSync(path.join(gitDir, 'refs/tags'), { recursive: true, force: true });
        fs.symlinkSync(path.join(source, '.git/refs/tags'), path.join(gitDir, 'refs/tags'));
      },
    ],
    [
      'alternates',
      () => fs.writeFileSync(path.join(gitDir, 'objects/info/alternates'), '/tmp/elsewhere\n'),
    ],
    ['a replace ref', () => run(dir, 'update-ref', `refs/replace/${base}`, base)],
    [
      'a packed replace ref',
      () => fs.appendFileSync(path.join(gitDir, 'packed-refs'), `${base} refs/replace/${base}\n`),
    ],
    ['a graft', () => fs.writeFileSync(path.join(gitDir, 'info/grafts'), `${base}\n`)],
    [
      "the pointer rewritten to the person's clone",
      () => fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${path.join(source, '.git')}\n`),
    ],
    [
      'the pointer replaced by a folder',
      () => {
        fs.rmSync(path.join(dir, '.git'));
        fs.mkdirSync(path.join(dir, '.git'));
      },
    ],
    [
      'the git folder replaced by a link',
      () => {
        fs.renameSync(gitDir, `${gitDir}.moved`);
        fs.symlinkSync(`${gitDir}.moved`, gitDir);
      },
    ],
  ])(
    "a changed git folder or pointer (%s) fails the step, and the person's clone is byte-identical",
    async (_what, change) => {
      const before = hashTree(path.join(source, '.git'));
      change();
      writeFile(dir, 'src/app.ts', 'x');
      expect(await settleRunClone(REQ)).toEqual({
        ok: false,
        error: expect.stringMatching(
          /^the step changed this checkout's git folder \(.+\), so Consola will not commit in it$/,
        ),
      });
      expect(hashTree(path.join(source, '.git'))).toEqual(before);
    },
  );

  it("gitFolderProblem's words, one per layer", () => {
    expect(gitFolderProblem(dir)).toBeNull();
    fs.writeFileSync(path.join(gitDir, 'commondir'), 'x');
    expect(gitFolderProblem(dir)).toBe('it holds `commondir`');
    fs.rmSync(path.join(gitDir, 'commondir'));
    fs.writeFileSync(path.join(gitDir, 'info/grafts'), 'x');
    expect(gitFolderProblem(dir)).toBe('it holds `info/grafts`');
    fs.rmSync(path.join(gitDir, 'info/grafts'));
    fs.writeFileSync(path.join(gitDir, 'objects/info/alternates'), '/tmp/elsewhere\n');
    expect(gitFolderProblem(dir)).toBe('`objects/info/alternates` changed');
  });

  it("Consola's git never follows a pointer to a git folder the step planted (review N1)", async () => {
    const marker = path.join(tmp, 'fsmonitor-ran');
    fs.mkdirSync(path.join(dir, 'evil'));
    fs.cpSync(path.join(gitDir, 'objects'), path.join(dir, 'evil/objects'), { recursive: true });
    fs.cpSync(path.join(gitDir, 'refs'), path.join(dir, 'evil/refs'), { recursive: true });
    fs.copyFileSync(path.join(gitDir, 'HEAD'), path.join(dir, 'evil/HEAD'));
    fs.writeFileSync(
      path.join(dir, 'evil/config'),
      `[core]\n\trepositoryformatversion = 0\n\tfsmonitor = "touch '${marker}'; false"\n`,
    );
    fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${path.join(dir, 'evil')}\n`);
    // The planted folder runs its config for a git that follows the pointer: the row's marker is real.
    execFileSync('git', ['status', '--porcelain'], { cwd: dir, env: process.env, stdio: 'ignore' });
    expect(fs.existsSync(marker)).toBe(true);
    fs.rmSync(marker);
    expect(await settleRunClone(REQ)).toEqual({
      ok: false,
      error: expect.stringContaining("the step changed this checkout's git folder"),
    });
    await expect(runCloneChanges(dir, base, base, 1024)).rejects.toThrow(
      "the step changed this checkout's git folder",
    );
    await expect(resetRunClone(dir, base)).rejects.toThrow(
      "the step changed this checkout's git folder",
    );
    expect(
      await runCloneShowAt(dir, base, 'README.md', 1024).catch((error: Error) => error.message),
    ).toContain("the step changed this checkout's git folder");
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('each layer holds on its own: the named git folder, replace refs off, grafts off', async () => {
    // runCloneGit is the module's one runner; called directly it skips gitFolderProblem, so each variable must hold alone.
    fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${path.join(source, '.git')}\n`);
    expect((await runCloneGit(dir, ['rev-parse', '--git-dir'])).trim()).toBe(gitDir);
    fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${gitDir}\n`);
    writeFile(dir, '.github/workflows/ci.yml', 'evil');
    writeFile(dir, 'src/app.ts', 'harmless');
    run(dir, 'add', '-A');
    run(dir, 'commit', '-qm', 'M');
    const M = run(dir, 'rev-parse', 'HEAD');
    run(dir, 'rm', '-q', '--cached', '.github/workflows/ci.yml');
    run(dir, 'commit', '-q', '--amend', '-m', 'M');
    const harmless = run(dir, 'rev-parse', 'HEAD');
    run(dir, 'update-ref', `refs/heads/${BRANCH}`, M);
    run(dir, 'replace', M, harmless);
    // The person's git sees the harmless commit.
    expect(run(dir, 'diff', '--name-only', base, M)).not.toContain('.github/workflows/ci.yml');
    expect(await runCloneGit(dir, ['diff', '--name-only', base, M])).toContain(
      '.github/workflows/ci.yml',
    );
    const orphan = run(dir, 'commit-tree', run(dir, 'mktree'), '-m', 'orphan');
    fs.writeFileSync(path.join(gitDir, 'info/grafts'), `${orphan} ${base}\n`);
    expect(() => run(dir, 'merge-base', '--is-ancestor', base, orphan)).not.toThrow();
    await expect(runCloneGit(dir, ['merge-base', '--is-ancestor', base, orphan])).rejects.toThrow();
  });

  it('a hard link fails the step before anything is staged: no object and no patch holds what it links to (review B5)', async () => {
    const outsideFile = path.join(tmp, 'outside-secret.txt');
    fs.writeFileSync(outsideFile, 'DUMMY-SECRET-7731');
    fs.linkSync(outsideFile, path.join(dir, 'hl'));
    const secretBlob = git(tmp, 'hash-object', outsideFile);
    for (const req of [REQ, { ...REQ, commit: null, keepOnly: true }]) {
      expect(await settleRunClone(req)).toEqual({
        ok: false,
        error:
          "`fix` left `hl` hard-linked to another file; Consola commits only the checkout's own files",
      });
      expect(() => run(dir, 'cat-file', '-e', secretBlob)).toThrow();
      expect(patchText()).not.toContain('DUMMY-SECRET');
      expect(run(dir, 'rev-parse', 'HEAD')).toBe(base);
    }
  });

  describe('a link that leads out of the checkout fails the step before anything is staged (3-B code review F6)', () => {
    const LEADS_OUT =
      "`fix` left `notes.md`, a link that leads out of the checkout; Consola commits only the checkout's own files";
    let outsideFile: string;
    beforeEach(() => {
      outsideFile = path.join(tmp, 'outside-secret.txt');
      fs.writeFileSync(outsideFile, 'DUMMY-SECRET-6604');
    });
    const linkIn = (target: string, at = 'notes.md') => fs.symlinkSync(target, path.join(dir, at));

    it.each<[string, () => void]>([
      ['an absolute target', () => linkIn(outsideFile)],
      ['a relative ../ target', () => linkIn(path.relative(dir, outsideFile))],
      [
        'a link to a link the repository already holds, which leads out',
        () => {
          // `hop` is in the branch before the step: only following the chain finds where notes.md leads.
          linkIn(outsideFile, 'hop');
          run(dir, 'add', 'hop');
          run(dir, 'commit', '-qm', 'hop');
          REQ = { ...REQ, before: run(dir, 'rev-parse', 'HEAD') };
          linkIn('hop');
        },
      ],
      [
        'a link through a linked folder the repository already holds',
        () => {
          fs.mkdirSync(path.join(tmp, 'elsewhere'));
          fs.writeFileSync(path.join(tmp, 'elsewhere', 'x.txt'), 'DUMMY-SECRET-6604');
          linkIn(path.join(tmp, 'elsewhere'), 'folder');
          run(dir, 'add', 'folder');
          run(dir, 'commit', '-qm', 'folder');
          REQ = { ...REQ, before: run(dir, 'rev-parse', 'HEAD') };
          linkIn('folder/x.txt');
        },
      ],
      // Committed, a link is read in every checkout of the branch: these two lead out of any other.
      ['an absolute target, even one that lands inside', () => linkIn(path.join(dir, 'README.md'))],
      [
        "a ../ target that comes back in by the checkout's own name",
        () => linkIn(`../${path.basename(dir)}/README.md`),
      ],
    ])('%s', async (_, make) => {
      make();
      const head = run(dir, 'rev-parse', 'HEAD');
      for (const req of [REQ, { ...REQ, commit: null, keepOnly: true }]) {
        expect(await settleRunClone(req)).toEqual({ ok: false, error: LEADS_OUT });
        expect(run(dir, 'rev-parse', 'HEAD')).toBe(head);
        expect(run(dir, 'diff', '--cached', '--name-only')).toBe('');
      }
      expect(await treeProblem(dir, 'fix')).toBe(LEADS_OUT);
      expect(await stageByDescriptor(dir, 'fix', ['notes.md'])).toBe(LEADS_OUT);
      expect(run(dir, 'diff', '--cached', '--name-only')).toBe('');
    });

    it('a chain of links longer than the file system follows is refused too', async () => {
      for (let i = 0; i < 45; i++) linkIn(`l${i + 1}`, i === 0 ? 'notes.md' : `l${i}`);
      linkIn('README.md', 'l45');
      expect(await stageByDescriptor(dir, 'fix', ['notes.md'])).toBe(LEADS_OUT);
    });

    it('a link that stays inside is committed as a link: to a file, to a link, to a folder, up a folder, and one whose target is not there yet', async () => {
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'a\n');
      linkIn('src/a.ts', 'a.ts');
      linkIn('a.ts', 'chain.ts');
      linkIn('src', 'source');
      linkIn('build/out.txt', 'out.txt');
      linkIn('../README.md', 'src/up.md');
      const r = await settleRunClone(REQ);
      expect(r).toMatchObject({ ok: true, files: 6 });
      expect(run(dir, 'ls-tree', 'HEAD', 'chain.ts')).toMatch(/^120000 /);
      expect(run(dir, 'cat-file', '-p', 'HEAD:out.txt')).toBe('build/out.txt');
    });

    it("a person's session that left one fails the boundary, in the session's name", async () => {
      linkIn(outsideFile);
      expect(
        await settleBetweenSteps({
          dir,
          branch: BRANCH,
          base,
          before: base,
          message: 'x',
          session: 'fix',
        }),
      ).toEqual({ ok: false, error: LEADS_OUT });
      expect(run(dir, 'rev-parse', 'HEAD')).toBe(base);
    });
  });

  it('a repository inside the checkout fails the step before anything is staged', async () => {
    writeFile(dir, 'sub/.git', 'gitdir: /tmp/x\n');
    writeFile(dir, 'sub/a.txt', 'a');
    expect(await settleRunClone(REQ)).toEqual({
      ok: false,
      error:
        "`fix` left a repository inside the checkout (`sub/.git`); Consola commits only the checkout's own files",
    });
    fs.rmSync(path.join(dir, 'sub'), { recursive: true });
    writeFile(dir, 'deep/er/.GIT/HEAD', 'ref: refs/heads/main\n');
    expect(await treeProblem(dir, 'fix')).toBe(
      "`fix` left a repository inside the checkout (`deep/er/.GIT`); Consola commits only the checkout's own files",
    );
    expect(run(dir, 'rev-parse', 'HEAD')).toBe(base);
  });

  it("a walk for a repository inside the checkout that is cut short fails as unknown (the re-check's Minor)", async () => {
    fs.mkdirSync(path.join(dir, 'a/b'), { recursive: true });
    expect(await treeProblem(dir, 'fix', { directories: 1, deadlineMs: 20_000 })).toBe(
      "Consola couldn't finish checking this run's checkout for repositories inside it; nothing was committed",
    );
    expect(await treeProblem(dir, 'fix', { directories: 100, deadlineMs: 0 })).toBe(
      "Consola couldn't finish checking this run's checkout for repositories inside it; nothing was committed",
    );
    expect(await treeProblem(dir, 'fix')).toBeNull();
  });

  it("a pointer rewritten after a settle is refused by the next spawn's check and by the boundary, with nothing else changed (review NB1)", async () => {
    expect(await settleRunClone(REQ)).toMatchObject({ ok: true });
    expect(gitFolderProblem(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${path.join(source, '.git')}\n`);
    expect(gitFolderProblem(dir)).toBe(".git in the checkout is not Consola's pointer");
    expect(
      await settleBetweenSteps({
        dir,
        branch: BRANCH,
        base,
        before: run(dir, 'rev-parse', 'HEAD'),
        message: 'x',
      }),
    ).toEqual({
      ok: false,
      error: expect.stringContaining("the step changed this checkout's git folder"),
    });
  });

  it("a .gitattributes filter the person configured never runs in Consola's commit", async () => {
    const marker = path.join(tmp, 'filter-ran');
    const globalWithFilter = path.join(tmp, 'global-with-filter');
    fs.writeFileSync(globalWithFilter, `[filter "mark"]\n\tclean = "touch '${marker}'; cat"\n`);
    writeFile(dir, '.gitattributes', '* filter=mark\n');
    writeFile(dir, 'a.txt', 'x');
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalWithFilter);
    // The person's own git runs it, but for the git folder's own attributes (put back after): the marker is real.
    const attributes = path.join(gitDir, 'info/attributes');
    fs.rmSync(attributes);
    execFileSync(
      'git',
      ['-c', 'core.hooksPath=/dev/null', 'hash-object', '--path=a.txt', path.join(dir, 'a.txt')],
      {
        cwd: dir,
        env: { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: dir },
      },
    );
    expect(fs.existsSync(marker)).toBe(true);
    fs.rmSync(marker);
    fs.writeFileSync(attributes, '* -filter\n');
    expect(await settleRunClone(REQ)).toMatchObject({ ok: true });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("nor one the system config names (the re-check's Minor: GIT_CONFIG_NOSYSTEM)", async () => {
    const marker = path.join(tmp, 'filter-ran');
    const systemWithFilter = path.join(tmp, 'system-with-filter');
    fs.writeFileSync(systemWithFilter, `[filter "mark"]\n\tclean = "touch '${marker}'; cat"\n`);
    writeFile(dir, '.gitattributes', '* filter=mark\n');
    writeFile(dir, 'a.txt', 'x');
    delete process.env.GIT_CONFIG_NOSYSTEM;
    vi.stubEnv('GIT_CONFIG_SYSTEM', systemWithFilter);
    const attributes = path.join(gitDir, 'info/attributes');
    fs.rmSync(attributes);
    execFileSync('git', ['hash-object', '--path=a.txt', path.join(dir, 'a.txt')], {
      cwd: dir,
      env: { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: dir },
    });
    expect(fs.existsSync(marker)).toBe(true);
    fs.rmSync(marker);
    fs.writeFileSync(attributes, '* -filter\n');
    expect(await settleRunClone(REQ)).toMatchObject({ ok: true });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("a program the git folder's own config names (fsmonitor, a signing program) never runs in Consola's git", async () => {
    // Only a `host` step, or something outside every sandbox, can write the git folder: the settings that beat it.
    const marker = path.join(tmp, 'config-ran');
    const program = path.join(tmp, 'program.sh');
    fs.writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    const config = path.join(gitDir, 'config');
    git(tmp, 'config', '--file', config, 'core.fsmonitor', program);
    git(tmp, 'config', '--file', config, 'commit.gpgsign', 'true');
    git(tmp, 'config', '--file', config, 'gpg.program', program);
    // The person's git runs it: the marker is real.
    expect(() => run(dir, 'status', '--porcelain')).not.toThrow();
    expect(fs.existsSync(marker)).toBe(true);
    fs.rmSync(marker);
    writeFile(dir, 'src/app.ts', 'x');
    // The changed config itself stops the settle (the commit review); each setting also holds on its own.
    expect(await settleRunClone(REQ)).toEqual({
      ok: false,
      error:
        "the step changed this checkout's git folder (`config` changed), so Consola will not commit in it",
    });
    await runCloneGit(dir, ['status', '--porcelain']);
    await runCloneGit(dir, ['add', '-A']);
    await runCloneGit(dir, ['commit', '-q', '--no-verify', '-m', 'x']);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("makes the git folder's attributes and records its config and attributes beside it (the commit review)", () => {
    expect(fs.readFileSync(path.join(gitDir, 'info/attributes'), 'utf8')).toBe('* -filter\n');
    const record = JSON.parse(fs.readFileSync(`${gitDir}.consola.json`, 'utf8'));
    expect(Object.keys(record).sort()).toEqual(['attributes', 'config']);
    expect(record.config).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each<[string, () => void, string]>([
    [
      'a key added to its config',
      () => git(tmp, 'config', '--file', path.join(gitDir, 'config'), 'core.editor', 'vi'),
      '`config` changed',
    ],
    [
      'its attributes rewritten',
      () => fs.writeFileSync(path.join(gitDir, 'info/attributes'), '* filter=mark\n'),
      '`info/attributes` changed',
    ],
    [
      'its attributes removed',
      () => fs.rmSync(path.join(gitDir, 'info/attributes')),
      '`info/attributes` changed',
    ],
    [
      'its record removed',
      () => fs.rmSync(`${gitDir}.consola.json`),
      'the record of its `config` is missing',
    ],
  ])('%s fails the next boundary, with nothing else changed', async (_what, change, what) => {
    change();
    expect(gitFolderProblem(dir)).toBe(what);
    expect(
      await settleBetweenSteps({ dir, branch: BRANCH, base, before: base, message: 'x' }),
    ).toEqual({
      ok: false,
      error: `the step changed this checkout's git folder (${what}), so Consola will not commit in it`,
    });
  });

  it("a filter the git folder's config names never runs for Consola's git, even called directly: its attributes beat the tree's", async () => {
    const marker = path.join(tmp, 'filter-ran');
    git(
      tmp,
      'config',
      '--file',
      path.join(gitDir, 'config'),
      'filter.mark.clean',
      `touch '${marker}'; cat`,
    );
    writeFile(dir, '.gitattributes', '* filter=mark\n');
    writeFile(dir, 'a.txt', 'x');
    await runCloneGit(dir, ['add', '-A']);
    expect(fs.existsSync(marker)).toBe(false);
    // Without the git folder's attributes, the same add runs it: the row's marker is real.
    fs.rmSync(path.join(gitDir, 'info/attributes'));
    writeFile(dir, 'b.txt', 'y');
    await runCloneGit(dir, ['add', '-A']);
    expect(fs.existsSync(marker)).toBe(true);
  });

  it.each<[string, Record<string, string>]>([
    [
      'GIT_CONFIG_COUNT',
      { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'filter.mark.clean', GIT_CONFIG_VALUE_0: 'MARK' },
    ],
    ['GIT_CONFIG_PARAMETERS', { GIT_CONFIG_PARAMETERS: "'filter.mark.clean'='MARK'" }],
  ])(
    "a filter the login environment passes (%s) never reaches Consola's git",
    async (_what, passed) => {
      const marker = path.join(tmp, 'passed-ran');
      for (const [name, value] of Object.entries(passed))
        vi.stubEnv(name, value.replace('MARK', `touch '${marker}'; cat`));
      fs.rmSync(path.join(gitDir, 'info/attributes'));
      const env = runCloneGitEnv(dir, process.env);
      expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
      expect(Object.values(env)).not.toContain(`touch '${marker}'; cat`);
      writeFile(dir, '.gitattributes', '* filter=mark\n');
      writeFile(dir, 'a.txt', 'x');
      await runCloneGit(dir, ['add', '-A']);
      expect(fs.existsSync(marker)).toBe(false);
    },
  );

  it("writes to the run clone's git folder leave the person's clone byte-identical", async () => {
    const before = hashTree(path.join(source, '.git'));
    run(dir, 'update-ref', 'refs/heads/main', 'HEAD');
    run(dir, 'update-ref', 'refs/heads/planted', 'HEAD');
    fs.appendFileSync(path.join(gitDir, 'packed-refs'), '# x\n');
    writeFile(dir, 'src/app.ts', 'y');
    await settleRunClone({ ...REQ });
    expect(hashTree(path.join(source, '.git'))).toEqual(before);
  });

  it('a command that leaves files changed or untracked fails; one that writes only .consola-cache/ passes', async () => {
    writeFile(dir, 'README.md', 'y');
    writeFile(dir, 'coverage.txt', 'z');
    expect(await settleRunClone({ ...REQ, commit: null, step: 'test' })).toEqual({
      ok: false,
      error: '`test` left files changed: README.md, coverage.txt',
    });
    run(dir, 'checkout', '--', '.');
    fs.rmSync(path.join(dir, 'coverage.txt'));
    writeFile(dir, '.consola-cache/npm/x', 'c');
    expect(await settleRunClone({ ...REQ, commit: null, step: 'test' })).toEqual({
      ok: true,
      after: base,
      files: 0,
      flagged: [],
    });
  });

  it("a command's leftovers are named, at most ten, then how many more", async () => {
    for (let i = 0; i < 12; i++) writeFile(dir, `out/f${String(i).padStart(2, '0')}.txt`, 'x');
    expect(await settleRunClone({ ...REQ, commit: null, step: 'test' })).toEqual({
      ok: false,
      error:
        '`test` left files changed: out/f00.txt, out/f01.txt, out/f02.txt, out/f03.txt, out/f04.txt, out/f05.txt, out/f06.txt, out/f07.txt, out/f08.txt, out/f09.txt and 2 more',
    });
  });

  it('a reset goes back to before: ignored files too, but .consola-cache/ and the pointer; the patch keeps uncommitted and untracked work', async () => {
    writeFile(dir, '.gitignore', 'node_modules/\n');
    await settleRunClone(REQ);
    const before2 = run(dir, 'rev-parse', 'HEAD');
    writeFile(dir, 'node_modules/x', 'i');
    writeFile(dir, '.consola-cache/k', 'c');
    writeFile(dir, 'src/new.ts', 'u');
    writeFile(dir, 'README.md', 'changed');
    expect(
      await settleRunClone({ ...REQ, before: before2, commit: null, keepOnly: true }),
    ).toMatchObject({
      ok: true,
      after: before2,
      files: 2,
    });
    expect(patchText()).toMatch(/README\.md[\s\S]*src\/new\.ts/);
    expect(patchText()).not.toContain('node_modules');
    // Nothing stays staged, intent-to-add included, and nothing was committed.
    expect(run(dir, 'diff', '--cached', '--name-only')).toBe('');
    expect(run(dir, 'status', '--porcelain', '--untracked-files=all')).toContain('?? src/new.ts');
    expect(run(dir, 'rev-parse', 'HEAD')).toBe(before2);
    await resetRunClone(dir, before2);
    expect(fs.existsSync(path.join(dir, 'node_modules/x'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'src/new.ts'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.consola-cache/k'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, '.git'), 'utf8')).toBe(`gitdir: ${gitDir}\n`);
    expect(run(dir, 'status', '--porcelain')).toBe('');
  });

  it('a reset also takes the branch back, after an agent committed on host', async () => {
    writeFile(dir, 'a.txt', 'agent');
    run(dir, 'add', '-A');
    run(dir, 'commit', '-qm', 'agent');
    await resetRunClone(dir, base);
    expect(run(dir, 'rev-parse', 'HEAD')).toBe(base);
    expect(run(dir, 'symbolic-ref', 'HEAD')).toBe(`refs/heads/${BRANCH}`);
  });

  it('a reset given the branch puts HEAD back on it, at before, after an agent detached it', async () => {
    run(dir, 'checkout', '-q', '--detach');
    writeFile(dir, 'a.txt', 'agent');
    run(dir, 'add', '-A');
    run(dir, 'commit', '-qm', 'detached');
    run(dir, 'update-ref', `refs/heads/${BRANCH}`, run(dir, 'rev-parse', 'HEAD'));
    await resetRunClone(dir, base, BRANCH);
    expect(run(dir, 'symbolic-ref', 'HEAD')).toBe(`refs/heads/${BRANCH}`);
    expect(run(dir, 'rev-parse', 'HEAD')).toBe(base);
    expect(run(dir, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(base);
    expect(fs.existsSync(path.join(dir, 'a.txt'))).toBe(false);
    expect(run(dir, 'status', '--porcelain')).toBe('');
  });

  it('the diff from base is capped, and a path artifact is read at a commit, refused when not a file or too large', async () => {
    writeFile(dir, 'big.txt', `${'line of text\n'.repeat(25_000)}`);
    writeFile(dir, 'docs/notes.md', '# notes\n');
    writeFile(dir, 'huge.bin', Buffer.alloc(2 * 1024 * 1024, 7));
    fs.symlinkSync('docs/notes.md', path.join(dir, 'link.md'));
    const settled = await settleRunClone(REQ);
    if (!settled.ok) throw new Error(settled.error);
    const cap = 256 * 1024;
    const changes = await runCloneChanges(dir, base, settled.after, cap);
    expect(changes.truncated).toBe(true);
    expect(Buffer.byteLength(changes.text)).toBeLessThanOrEqual(cap);
    expect(changes.bytes).toBeGreaterThan(cap);
    expect(changes.text.startsWith('diff --git')).toBe(true);
    const small = await runCloneChanges(dir, base, settled.after, 64 * 1024 * 1024);
    expect(small).toMatchObject({ truncated: false, bytes: Buffer.byteLength(small.text) });
    expect(await runCloneShowAt(dir, settled.after, 'docs/notes.md', 1024 * 1024)).toEqual({
      ok: true,
      text: '# notes\n',
    });
    expect(await runCloneShowAt(dir, settled.after, 'link.md', 1024 * 1024)).toEqual({
      ok: false,
      reason: 'not-a-file',
    });
    expect(await runCloneShowAt(dir, settled.after, 'docs', 1024 * 1024)).toEqual({
      ok: false,
      reason: 'not-a-file',
    });
    expect(await runCloneShowAt(dir, settled.after, 'huge.bin', 1024 * 1024)).toEqual({
      ok: false,
      reason: 'too-large',
    });
    expect(await runCloneShowAt(dir, settled.after, 'absent.md', 1024 * 1024)).toEqual({
      ok: false,
      reason: 'missing',
    });
    expect(await runCloneShowAt(dir, settled.after, 'docs/*.md', 1024 * 1024)).toEqual({
      ok: false,
      reason: 'missing',
    });
  });

  it("settleBetweenSteps commits a person's leftovers apart, returns null when nothing changed, and fails on a moved HEAD (M11)", async () => {
    expect(
      await settleBetweenSteps({
        dir,
        branch: BRANCH,
        base,
        before: base,
        message: 'changes by fix during ui-bug-to-pr',
      }),
    ).toBeNull();
    writeFile(dir, 'NOTES.md', 'by hand');
    const r = await settleBetweenSteps({
      dir,
      branch: BRANCH,
      base,
      before: base,
      message: 'changes by fix during ui-bug-to-pr',
    });
    expect(r).toMatchObject({ ok: true, files: 1 });
    expect(run(dir, 'log', '-1', '--format=%s')).toBe('changes by fix during ui-bug-to-pr');
    run(dir, 'checkout', '-q', '--detach');
    expect(
      await settleBetweenSteps({
        dir,
        branch: BRANCH,
        base,
        before: run(dir, 'rev-parse', 'HEAD'),
        message: 'x',
      }),
    ).toEqual({ ok: false, error: 'the step moved `HEAD` off fix/SHOP-42' });
  });

  it("settleBetweenSteps checks the tree too: a person's session that left a repository inside fails the boundary", async () => {
    writeFile(dir, 'sub/.git', 'gitdir: /tmp/x\n');
    expect(
      await settleBetweenSteps({
        dir,
        branch: BRANCH,
        base,
        before: base,
        message: 'x',
        session: 'fix',
      }),
    ).toEqual({
      ok: false,
      error:
        "`fix` left a repository inside the checkout (`sub/.git`); Consola commits only the checkout's own files",
    });
    expect(run(dir, 'rev-parse', 'HEAD')).toBe(base);
  });

  it('settleBetweenSteps names the session it saw holding the checkout when HEAD, the branch or the git folder moved (Task 14)', async () => {
    const asFix = (before: string) =>
      settleBetweenSteps({ dir, branch: BRANCH, base, before, message: 'x', session: 'fix' });
    writeFile(dir, 'NOTES.md', 'by hand');
    run(dir, 'add', '-A');
    run(dir, 'commit', '-qm', 'mine');
    const mine = run(dir, 'rev-parse', 'HEAD');
    run(dir, 'update-ref', `refs/heads/${BRANCH}`, base);
    expect(await asFix(mine)).toEqual({
      ok: false,
      error: `\`fix\`, opened by you, moved ${BRANCH} off the commit the run was at (${mine.slice(0, 7)})`,
    });
    run(dir, 'checkout', '-q', '--detach');
    expect(await asFix(base)).toEqual({
      ok: false,
      error: `\`fix\`, opened by you, moved \`HEAD\` off ${BRANCH}`,
    });
    run(dir, 'checkout', '-q', BRANCH);
    fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${path.join(source, '.git')}\n`);
    expect(await asFix(base)).toEqual({
      ok: false,
      error:
        "`fix`, opened by you, changed this checkout's git folder (.git in the checkout is not Consola's pointer), so Consola will not commit in it",
    });
  });

  it("settleBetweenSteps reports a person's own commit, with nothing left uncommitted", async () => {
    writeFile(dir, 'NOTES.md', 'by hand');
    run(dir, 'add', '-A');
    run(dir, 'commit', '-qm', 'mine');
    const r = await settleBetweenSteps({ dir, branch: BRANCH, base, before: base, message: 'x' });
    expect(r).toEqual({ ok: true, after: run(dir, 'rev-parse', 'HEAD'), files: 1, flagged: [] });
    expect(run(dir, 'log', '-1', '--format=%s')).toBe('mine');
  });
});

describe("staging what a step left by descriptor, never by path (the commit review: the check and git's read raced)", () => {
  let gitDir: string;
  const writeFile = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  const staged = () => run(dir, 'ls-files', '-s');

  beforeEach(async () => {
    await makeRunClone({ source, dir, branch: 'fix/a', runId: 'r', fetchEnv: process.env });
    gitDir = runCloneGitDirFor(dir);
  });

  it('stages a changed, a new, an executable, a removed file and a link, each as it was read', async () => {
    writeFile('NEWER.md', 'changed\n');
    writeFile('src/new.ts', 'new\n');
    writeFile('run.sh', '#!/bin/sh\n');
    fs.chmodSync(path.join(dir, 'run.sh'), 0o755);
    fs.rmSync(path.join(dir, 'README.md'));
    fs.symlinkSync('src/new.ts', path.join(dir, 'link.ts'));
    expect(
      await stageByDescriptor(dir, 'fix', [
        'NEWER.md',
        'src/new.ts',
        'run.sh',
        'README.md',
        'link.ts',
      ]),
    ).toBeNull();
    const index = staged();
    expect(index).toContain(
      `100644 ${git(tmp, 'hash-object', path.join(dir, 'NEWER.md'))} 0\tNEWER.md`,
    );
    expect(index).toContain('\tsrc/new.ts');
    expect(index).toMatch(/^100755 .*\trun\.sh$/m);
    expect(index).toMatch(/^120000 .*\tlink\.ts$/m);
    expect(index).not.toContain('\tREADME.md');
    expect(run(dir, 'diff', '--cached', '--name-only').split('\n').sort()).toEqual(
      ['NEWER.md', 'README.md', 'link.ts', 'run.sh', 'src/new.ts'].sort(),
    );
  });

  it('a file that became a hard link after the check is refused, and no object holds what it links to', async () => {
    const outside = path.join(tmp, 'outside-secret.txt');
    fs.writeFileSync(outside, 'DUMMY-SECRET-9113');
    fs.linkSync(outside, path.join(dir, 'late.txt'));
    const before = staged();
    expect(await stageByDescriptor(dir, 'fix', ['late.txt'])).toBe(
      "`fix` left `late.txt` hard-linked to another file; Consola commits only the checkout's own files",
    );
    expect(() => run(dir, 'cat-file', '-e', git(tmp, 'hash-object', outside))).toThrow();
    expect(staged()).toBe(before);
  });

  it('a file reached through a linked folder is refused, and nothing is read through it', async () => {
    fs.mkdirSync(path.join(tmp, 'denied'));
    fs.writeFileSync(path.join(tmp, 'denied/key'), 'DUMMY-SECRET-5520');
    fs.symlinkSync(path.join(tmp, 'denied'), path.join(dir, 'docs'));
    expect(await stageByDescriptor(dir, 'fix', ['docs/key'])).toBe(
      "`fix` left `docs/key` behind a linked folder; Consola commits only the checkout's own files",
    );
    expect(() =>
      run(dir, 'cat-file', '-e', git(tmp, 'hash-object', path.join(tmp, 'denied/key'))),
    ).toThrow();
  });

  it('what is not a file, a link or gone is refused', async () => {
    execFileSync('mkfifo', [path.join(dir, 'pipe')]);
    expect(await stageByDescriptor(dir, 'fix', ['pipe'])).toBe(
      "`fix` left `pipe`, which is not a file; Consola commits only the checkout's own files",
    );
  });

  it('a refusal while staging puts the index back: nothing of what it staged before stays', async () => {
    writeFile('a.txt', 'staged first\n');
    const outside = path.join(tmp, 'outside.txt');
    fs.writeFileSync(outside, 'x');
    fs.linkSync(outside, path.join(dir, 'hl'));
    expect(await stageChecked(dir, 'fix')).toBe(
      "`fix` left `hl` hard-linked to another file; Consola commits only the checkout's own files",
    );
    expect(run(dir, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('after staging, the tree is checked again: a repository that appeared is refused, the index put back', async () => {
    writeFile('a.txt', 'x\n');
    writeFile('sub/.git', 'gitdir: /tmp/x\n');
    expect(await stageChecked(dir, 'fix')).toBe(
      "`fix` left a repository inside the checkout (`sub/.git`); Consola commits only the checkout's own files",
    );
    expect(run(dir, 'diff', '--cached', '--name-only')).toBe('');
  });

  it("keeps the repository's own line-ending rules, as git add would", async () => {
    writeFile('.gitattributes', '*.txt text eol=lf\n');
    writeFile('crlf.txt', 'a\r\nb\r\n');
    expect(await stageByDescriptor(dir, 'fix', ['.gitattributes', 'crlf.txt'])).toBeNull();
    expect(run(dir, 'cat-file', '-p', ':crlf.txt')).toBe('a\nb');
  });

  it('settle commits through it', async () => {
    writeFile('src/app.ts', 'fixed\n');
    const result = await settleRunClone({
      dir,
      branch: 'fix/a',
      base: run(dir, 'rev-parse', 'HEAD'),
      before: run(dir, 'rev-parse', 'HEAD'),
      commit: { message: 'm' },
      attemptDir: path.join(tmp, 'attempt'),
      step: 'fix',
    });
    expect(result).toMatchObject({ ok: true, files: 1 });
    expect(run(dir, 'show', 'HEAD:src/app.ts')).toBe('fixed');
    expect(fs.existsSync(`${gitDir}.consola.json`)).toBe(true);
  });
});

describe("a removed run's checkout: its keep-ref, its folders, its rebuild (Task 19)", () => {
  const KEEP = 'refs/consola/worktrees/catalog-portal-run-3f2a91c0';
  let head: string;
  beforeEach(async () => {
    await makeRunClone({
      source,
      dir,
      branch: 'fix/SHOP-42',
      runId: '3f2a91c0aa',
      fetchEnv: process.env,
    });
    fs.writeFileSync(path.join(dir, 'fix.txt'), 'fixed\n');
    run(dir, 'add', '-A');
    run(
      dir,
      '-c',
      'user.name=alice',
      '-c',
      'user.email=alice@sprocket.example',
      'commit',
      '-q',
      '-m',
      'fix',
    );
    head = run(dir, 'rev-parse', 'HEAD');
  });

  it("fetches the branch into the person's clone as the keep-ref, never into the run clone (review S2)", async () => {
    await fetchKeepRef({ source, dir, branch: 'fix/SHOP-42', head, keepRef: KEEP });
    expect(git(source, 'rev-parse', KEEP)).toBe(head);
    expect(() => run(dir, 'rev-parse', '--verify', '-q', KEEP)).toThrow();
  });

  it('removes nothing when the branch moved since Consola recorded its head (review S2)', async () => {
    const before = run(dir, 'rev-parse', 'HEAD~1');
    await expect(
      fetchKeepRef({ source, dir, branch: 'fix/SHOP-42', head: before, keepRef: KEEP }),
    ).rejects.toThrow(
      "the run's branch is not at the commit Consola recorded; nothing was removed",
    );
    expect(() => git(source, 'rev-parse', '--verify', '-q', KEEP)).toThrow();
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("fetches into no ref but Consola's own: the person's branches stay where they are (3-B code review F13)", async () => {
    const main = git(source, 'rev-parse', 'refs/heads/main');
    for (const keepRef of ['refs/heads/main', 'refs/heads/fix/SHOP-42', 'refs/tags/kept', 'HEAD'])
      await expect(
        fetchKeepRef({ source, dir, branch: 'fix/SHOP-42', head, keepRef }),
      ).rejects.toThrow(`${keepRef} is not a ref Consola keeps`);
    expect(git(source, 'rev-parse', 'refs/heads/main')).toBe(main);
    expect(() => git(source, 'rev-parse', '--verify', '-q', 'refs/heads/fix/SHOP-42')).toThrow();
    expect(() => git(source, 'rev-parse', '--verify', '-q', 'refs/tags/kept')).toThrow();
  });

  it('fetches nothing from a git folder that changed (Call 9)', async () => {
    fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${path.join(source, '.git')}\n`);
    await expect(
      fetchKeepRef({ source, dir, branch: 'fix/SHOP-42', head, keepRef: KEEP }),
    ).rejects.toThrow(".git in the checkout is not Consola's pointer");
    expect(() => git(source, 'rev-parse', '--verify', '-q', KEEP)).toThrow();
  });

  it("rebuilds it as it was made, at the recorded commit, from the person's clone alone; a gc there leaves it whole (review NB2)", async () => {
    await fetchKeepRef({ source, dir, branch: 'fix/SHOP-42', head, keepRef: KEEP });
    const gitDir = runCloneGitDirFor(dir);
    deleteRunClone(dir);
    expect([
      fs.existsSync(dir),
      fs.existsSync(gitDir),
      fs.existsSync(`${gitDir}.consola.json`),
    ]).toEqual([false, false, false]);
    await rebuildRunClone({
      source,
      dir,
      branch: 'fix/SHOP-42',
      commit: head,
      runId: '3f2a91c0aa',
    });
    expect(run(dir, 'rev-parse', 'HEAD')).toBe(head);
    expect(run(dir, 'symbolic-ref', 'HEAD')).toBe('refs/heads/fix/SHOP-42');
    expect(fs.readFileSync(path.join(dir, '.git'), 'utf8')).toBe(`gitdir: ${gitDir}\n`);
    expect(git(dir, 'config', '--file', path.join(gitDir, 'config'), 'consola.run')).toBe(
      '3f2a91c0aa',
    );
    expect(git(dir, 'config', '--file', path.join(gitDir, 'config'), 'consola.source')).toBe(
      source,
    );
    expect(fs.readFileSync(path.join(gitDir, 'info', 'attributes'), 'utf8')).toBe('* -filter\n');
    expect(fs.readFileSync(path.join(dir, 'fix.txt'), 'utf8')).toBe('fixed\n');
    // As made: the folder Consola checks is the folder it wrote, record included.
    expect(gitFolderProblem(dir)).toBeNull();
    git(source, 'reflog', 'expire', '--expire=now', '--all');
    git(source, 'gc', '-q', '--prune=now');
    expect(() => run(dir, 'cat-file', '-e', head)).not.toThrow();
    expect(run(dir, 'status', '--porcelain')).toBe('');
  });

  it('a rebuild without the keep-ref, after a gc, is refused, and leaves nothing behind', async () => {
    const gitDir = runCloneGitDirFor(dir);
    deleteRunClone(dir);
    git(source, 'reflog', 'expire', '--expire=now', '--all');
    git(source, 'gc', '-q', '--prune=now');
    await expect(
      rebuildRunClone({ source, dir, branch: 'fix/SHOP-42', commit: head, runId: '3f2a91c0aa' }),
    ).rejects.toBeInstanceOf(RunCheckoutError);
    expect([fs.existsSync(dir), fs.existsSync(gitDir)]).toEqual([false, false]);
  });
});
