import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunCheckoutError } from '../steps/runCheckout';
import {
  gitFolderProblem,
  makeRunClone,
  resetRunClone,
  runCloneChanges,
  runCloneGit,
  runCloneGitDirFor,
  runCloneGitEnv,
  runCloneShowAt,
  settleBetweenSteps,
  settleRunClone,
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
    // The person's own git runs it: the marker is real.
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
    execFileSync('git', ['hash-object', '--path=a.txt', path.join(dir, 'a.txt')], {
      cwd: dir,
      env: { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: dir },
    });
    expect(fs.existsSync(marker)).toBe(true);
    fs.rmSync(marker);
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
    expect(await settleRunClone(REQ)).toMatchObject({ ok: true, files: 1 });
    expect(fs.existsSync(marker)).toBe(false);
  });

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

  it("settleBetweenSteps reports a person's own commit, with nothing left uncommitted", async () => {
    writeFile(dir, 'NOTES.md', 'by hand');
    run(dir, 'add', '-A');
    run(dir, 'commit', '-qm', 'mine');
    const r = await settleBetweenSteps({ dir, branch: BRANCH, base, before: base, message: 'x' });
    expect(r).toEqual({ ok: true, after: run(dir, 'rev-parse', 'HEAD'), files: 1, flagged: [] });
    expect(run(dir, 'log', '-1', '--format=%s')).toBe('mine');
  });
});
