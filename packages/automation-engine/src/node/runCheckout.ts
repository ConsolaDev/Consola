import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { withoutGitHooks, withoutRepositoryOverrides } from '../gitEnv';
import { RunCheckoutError, type RunCheckoutStage } from '../steps/runCheckout';

/*
 * A run's own checkout against real git (slice 3-B, *The run-owned
 * checkout*): the one file in the engine that runs `git` for it, through
 * `execFile`, every name one argument, never a shell. The checkout is a
 * `git clone --shared` of the person's clone whose git folder is outside it,
 * in `run-git/` beside the worktree root (Call 9), where no step's sandbox
 * can write; the checkout holds only a `.git` pointer Consola writes. Every
 * git Consola runs there names its git folder and its work tree (`GIT_DIR`,
 * `GIT_WORK_TREE`), never discovering either from the checkout, with hooks
 * off; nothing here ever hands those variables to a step.
 */

/** Text a person reads when the git folder is checked later: what Consola wrote into the checkout. */
const pointerText = (gitDir: string) => `gitdir: ${gitDir}\n`;

/**
 * Call 9: the checkout's git folder, `<worktree root>/../run-git/<checkout's
 * name>.git` (`~/.consola/run-git/<repo>-run-<8>.git`), from the path alone,
 * never read from the checkout, which a step can write.
 */
export function runCloneGitDirFor(dir: string): string {
  const root = path.dirname(dir);
  return path.join(path.dirname(root), 'run-git', `${path.basename(dir)}.git`);
}

/** git's answer, trimmed; a failure rejects with git's own last line. */
function git(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd: options.cwd, env: options.env, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout.trim());
          return;
        }
        const said = `${stderr}`.trim().split('\n').filter(Boolean);
        reject(new Error(said.length > 0 ? said[said.length - 1] : error.message));
      },
    );
  });
}

/** `env` with git's hooks off and no repository a login shell aimed it at. */
const plainGit = (env: NodeJS.ProcessEnv) => withoutGitHooks(withoutRepositoryOverrides(env));

/** `env` for Consola's own git in the run clone while it is made: the folder pair named, no global or system config, no fsmonitor. */
function cloneGit(gitDir: string, dir: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base = plainGit(env);
  const count = Number(base.GIT_CONFIG_COUNT ?? '0');
  return {
    ...base,
    GIT_DIR: gitDir,
    GIT_WORK_TREE: dir,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: String(count + 1),
    [`GIT_CONFIG_KEY_${count}`]: 'core.fsmonitor',
    [`GIT_CONFIG_VALUE_${count}`]: 'false',
  };
}

/** Whether `target` is absent or an empty folder: the only things `makeRunClone` takes. */
function absentOrEmpty(target: string): boolean {
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat) return true;
  return stat.isDirectory() && fs.readdirSync(target).length === 0;
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Steps 2–7 of *How it is made*, in `dir` (absent or empty) and its git
 * folder (absent or empty), from the person's clone `source`; on any failure
 * it removes what it made of both and throws a `RunCheckoutError` naming the
 * stage. `fetchEnv` is the bound account's environment, used for the one
 * fetch from the real remote (and the question of its default branch); every
 * other git here runs with no global or system config, but the reads of the
 * person's own clone (`origin`, the identity), which are the person's.
 */
export async function makeRunClone(input: {
  source: string;
  dir: string;
  branch: string;
  from?: string;
  runId: string;
  fetchEnv: NodeJS.ProcessEnv;
}): Promise<{ base: string }> {
  const { dir, branch, runId, fetchEnv } = input;
  const gitDir = runCloneGitDirFor(dir);
  if (!absentOrEmpty(dir) || !absentOrEmpty(gitDir)) {
    throw new RunCheckoutError(
      'clone',
      `${absentOrEmpty(dir) ? gitDir : dir} is already there and not empty`,
    );
  }
  const made = { dir: !fs.existsSync(dir), gitDir: !fs.existsSync(gitDir) };
  let stage: RunCheckoutStage = 'clone';
  try {
    const source = fs.realpathSync(input.source);
    const sourceGit = { cwd: source, env: plainGit(fetchEnv) };
    const local = { cwd: dir, env: cloneGit(gitDir, dir, fetchEnv) };
    // The fetch keeps the person's global config: their credential helper is there.
    const remote = {
      cwd: dir,
      env: { ...plainGit(fetchEnv), GIT_DIR: gitDir, GIT_WORK_TREE: dir, GIT_TERMINAL_PROMPT: '0' },
    };

    fs.mkdirSync(path.dirname(gitDir), { recursive: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    // No template: a template folder's hooks would land in the clone (`init.templateDir`).
    const { GIT_DIR: _dir, GIT_WORK_TREE: _tree, ...cloning } = local.env;
    await git(
      [
        'clone',
        '--shared',
        '--no-checkout',
        '--template=',
        '--separate-git-dir',
        gitDir,
        source,
        dir,
      ],
      { cwd: path.dirname(dir), env: cloning },
    );
    // Consola's own pointer, exactly: what `gitFolderProblem` compares against before every spawn and settle.
    fs.writeFileSync(path.join(dir, '.git'), pointerText(gitDir));
    const alternates = fs
      .readFileSync(path.join(gitDir, 'objects', 'info', 'alternates'), 'utf8')
      .trim();

    stage = 'origin';
    const url = await git(['remote', 'get-url', 'origin'], sourceGit);
    await git(['remote', 'set-url', 'origin', url], local);

    stage = 'fetch';
    let from = input.from;
    if (from === undefined) {
      const said = await git(['ls-remote', '--symref', 'origin', 'HEAD'], remote);
      const match = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(said);
      if (!match) throw new Error("the remote didn't say its default branch");
      from = match[1];
    }
    await git(['fetch', '--no-tags', 'origin', `refs/heads/${from}`], remote);
    const base = await git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], local);

    // `switch -c` runs git's own check of the name (Call 7): a name it refuses fails here.
    stage = 'branch';
    await git(['switch', '--quiet', '--no-track', '-c', branch, base], local);

    stage = 'identity';
    const identity = async (key: string) => git(['config', key], sourceGit).catch(() => '');
    const name = await identity('user.name');
    const email = await identity('user.email');
    if (name === '' || email === '') throw new Error('set user.name and user.email in git');
    const config = path.join(gitDir, 'config');
    for (const [key, value] of [
      ['user.name', name],
      ['user.email', email],
      // Call 11: what makes the folder a run's once history has dropped the run.
      ['consola.run', runId],
      ['consola.source', input.source],
      ['consola.alternates', alternates],
    ]) {
      await git(['config', '--file', config, key, value], local);
    }

    stage = 'exclude';
    fs.mkdirSync(path.join(gitDir, 'info'), { recursive: true });
    fs.appendFileSync(path.join(gitDir, 'info', 'exclude'), '.consola-cache/\n');
    return { base };
  } catch (error) {
    // What it made goes: a folder it created, or what it put in an empty one it was given.
    for (const [target, created] of [
      [dir, made.dir],
      [gitDir, made.gitDir],
    ] as const) {
      if (created) fs.rmSync(target, { recursive: true, force: true });
      else
        for (const entry of fs.readdirSync(target))
          fs.rmSync(path.join(target, entry), { recursive: true, force: true });
    }
    throw error instanceof RunCheckoutError ? error : new RunCheckoutError(stage, describe(error));
  }
}
