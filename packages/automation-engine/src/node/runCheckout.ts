import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { withoutGitHooks, withoutRepositoryOverrides } from '../gitEnv';
import {
  flaggedPaths,
  RunCheckoutError,
  type RunCheckoutStage,
  type SettleRequest,
  type SettleResult,
} from '../steps/runCheckout';

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

/** Settings every git Consola runs for a run clone gives on its command line, which beat any file's. */
const HARDENED: ReadonlyArray<[string, string]> = [
  ['core.fsmonitor', 'false'],
  ['commit.gpgsign', 'false'],
  ['core.untrackedCache', 'false'],
  // A borrowed (`--shared`) clone is never repacked behind Consola's back.
  ['gc.auto', '0'],
  // No attributes file but the repository's and the git folder's own `info/attributes`.
  ['core.attributesFile', '/dev/null'],
];

/**
 * The git folder's own attributes, which beat every `.gitattributes` in the
 * tree: no filter runs for any git in the run's clone (a filter is a
 * command a `.gitattributes` a step wrote could select). Diff drivers need
 * no line here: Consola's diffs pass `--no-ext-diff --no-textconv`.
 */
const GIT_FOLDER_ATTRIBUTES = '* -filter\n';

/** Where Consola records what the git folder's `config` and `info/attributes` were when it made them: beside the folder, never in it. */
const recordFor = (gitDir: string) => `${gitDir}.consola.json`;

const sha256 = (file: string): string | null =>
  fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;

/** The hashes `gitFolderProblem` compares against, of the files Consola wrote last. */
function writeGitFolderRecord(gitDir: string): void {
  const record = {
    config: sha256(path.join(gitDir, 'config')),
    attributes: sha256(path.join(gitDir, 'info', 'attributes')),
  };
  fs.writeFileSync(recordFor(gitDir), `${JSON.stringify(record)}\n`);
}

/** `env` without any config a login environment passes on git's command line (`GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`). */
function withoutPassedConfig(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const name of Object.keys(clean))
    if (
      name === 'GIT_CONFIG_PARAMETERS' ||
      name === 'GIT_CONFIG_COUNT' ||
      /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(name)
    )
      delete clean[name];
  return clean;
}

/**
 * Call 9's environment for every git Consola runs for the run clone at
 * `dir`: its git folder (`runCloneGitDirFor(dir)`) and work tree named, never
 * discovered from the checkout (and `GIT_COMMON_DIR`, so no `commondir`
 * file is read); hooks off; no global or system config, so a
 * `.gitattributes` a step wrote cannot name a filter or diff driver the
 * person configured; replace refs and grafts ignored (`GIT_NO_REPLACE_OBJECTS`
 * alone leaves grafts on); no fsmonitor, signing, untracked cache or auto gc.
 * Consola's own git only: no step is ever given these variables (review NB1).
 */
export function runCloneGitEnv(dir: string, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const gitDir = runCloneGitDirFor(dir);
  const env: NodeJS.ProcessEnv = {
    ...plainGit(withoutPassedConfig(base)),
    GIT_DIR: gitDir,
    GIT_WORK_TREE: dir,
    GIT_COMMON_DIR: gitDir,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_GRAFT_FILE: '/dev/null',
  };
  let count = Number(env.GIT_CONFIG_COUNT ?? '0');
  for (const [key, value] of HARDENED) {
    env[`GIT_CONFIG_KEY_${count}`] = key;
    env[`GIT_CONFIG_VALUE_${count}`] = value;
    count += 1;
  }
  env.GIT_CONFIG_COUNT = String(count);
  return env;
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
    const local = { cwd: dir, env: runCloneGitEnv(dir, fetchEnv) };
    // The fetch keeps the person's global config: their credential helper is there.
    const remote = {
      cwd: dir,
      env: { ...plainGit(fetchEnv), GIT_DIR: gitDir, GIT_WORK_TREE: dir, GIT_TERMINAL_PROMPT: '0' },
    };

    fs.mkdirSync(path.dirname(gitDir), { recursive: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    // No template: a template folder's hooks would land in the clone (`init.templateDir`).
    const { GIT_DIR: _dir, GIT_WORK_TREE: _tree, GIT_COMMON_DIR: _common, ...cloning } = local.env;
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
    fs.writeFileSync(path.join(gitDir, 'info', 'attributes'), GIT_FOLDER_ATTRIBUTES);
    // Last: what the folder's config and attributes are, now that Consola wrote them both.
    writeGitFolderRecord(gitDir);
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
    fs.rmSync(recordFor(gitDir), { force: true });
    throw error instanceof RunCheckoutError ? error : new RunCheckoutError(stage, describe(error));
  }
}

// --- checking, committing and resetting (Task 11) ----------------------------------

/**
 * git in the run clone at `dir`, with `runCloneGitEnv`: its
 * whole stdout; a failure rejects with git's own last line. The module's one
 * runner, exported for its tests only: called directly it skips
 * `gitFolderProblem`, which every function below asks first.
 */
export function runCloneGit(dir: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd: dir,
        env: runCloneGitEnv(dir, process.env),
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        const said = `${stderr}`.trim().split('\n').filter(Boolean);
        reject(new Error(said.length > 0 ? said[said.length - 1] : error.message));
      },
    );
  });
}

/** Whether `args` succeed: git's yes-or-no questions (`merge-base --is-ancestor`, `diff --quiet`). */
const answers = (dir: string, args: string[]) =>
  runCloneGit(dir, args).then(
    () => true,
    () => false,
  );

/** The words a settle or a reset fails with when the git folder or its pointer changed. */
const changedFolder = (what: string) =>
  `the step changed this checkout's git folder (${what}), so Consola will not commit in it`;

/** The first symbolic link under `root`, by its path inside it, or null. */
function firstLink(root: string, relative = ''): string | null {
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const inside = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isSymbolicLink()) return inside;
    if (entry.isDirectory()) {
      const found = firstLink(root, inside);
      if (found !== null) return found;
    }
  }
  return null;
}

/** Whether the git folder holds a replace ref, loose or packed. */
function holdsReplaceRef(gitDir: string): boolean {
  const loose = path.join(gitDir, 'refs', 'replace');
  if (fs.existsSync(loose) && fs.readdirSync(loose, { recursive: true }).length > 0) return true;
  const packed = path.join(gitDir, 'packed-refs');
  return (
    fs.existsSync(packed) && /^[0-9a-f]+ refs\/replace\//m.test(fs.readFileSync(packed, 'utf8'))
  );
}

/** What `makeRunClone` wrote as the alternates, from the git folder's own config; null when unreadable. */
function recordedAlternates(gitDir: string): string | null {
  try {
    return execFileSync(
      'git',
      ['config', '--file', path.join(gitDir, 'config'), 'consola.alternates'],
      {
        encoding: 'utf8',
        env: { ...plainGit(process.env), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
  } catch {
    return null;
  }
}

/**
 * Call 9's folder check, of the checkout's pointer and the run clone's git
 * folder: null when both are as Consola made them, else what changed. The
 * pointer is a regular file holding exactly what Consola wrote; the git
 * folder a real directory with no link under it, no `commondir` or `gitdir`
 * file, no replace ref (loose or packed), no `info/grafts`, and its
 * alternates byte for byte what Consola recorded. A sandboxed step can write
 * none of these (canary rows 32, 47); only a `host` step, or something
 * outside every sandbox, could: a tripwire. Asked before every spawn in a
 * run-owned checkout and at every boundary (review NB1).
 */
export function gitFolderProblem(dir: string): string | null {
  const gitDir = runCloneGitDirFor(dir);
  const pointer = path.join(dir, '.git');
  const pointerStat = fs.lstatSync(pointer, { throwIfNoEntry: false });
  if (!pointerStat?.isFile() || fs.readFileSync(pointer, 'utf8') !== pointerText(gitDir))
    return ".git in the checkout is not Consola's pointer";
  if (!fs.lstatSync(gitDir, { throwIfNoEntry: false })?.isDirectory())
    return 'the git folder is not a folder';
  const link = firstLink(gitDir);
  if (link !== null) return `\`${link}\` in it is a link`;
  for (const name of ['commondir', 'gitdir'])
    if (fs.existsSync(path.join(gitDir, name))) return `it holds \`${name}\``;
  if (holdsReplaceRef(gitDir)) return '`refs/replace/` holds a ref';
  if (fs.existsSync(path.join(gitDir, 'info', 'grafts'))) return 'it holds `info/grafts`';
  const alternates = path.join(gitDir, 'objects', 'info', 'alternates');
  const written = fs.existsSync(alternates) ? fs.readFileSync(alternates, 'utf8').trim() : '';
  if (written !== recordedAlternates(gitDir)) return '`objects/info/alternates` changed';
  // Its config and attributes, as Consola last wrote them (the commit review): only a `host` step can change them.
  let record: { config?: unknown; attributes?: unknown };
  try {
    record = JSON.parse(fs.readFileSync(recordFor(gitDir), 'utf8'));
  } catch {
    return 'the record of its `config` is missing';
  }
  if (record.config !== sha256(path.join(gitDir, 'config'))) return '`config` changed';
  if (record.attributes !== sha256(path.join(gitDir, 'info', 'attributes')))
    return '`info/attributes` changed';
  return null;
}

/** The paths `git status --porcelain=v1 -z` lists, a rename's original left out. */
function statusPaths(listed: string): string[] {
  const tokens = listed.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.length < 4) continue;
    paths.push(token.slice(3));
    if (token[0] === 'R' || token[0] === 'C') i += 1;
  }
  return paths;
}

/** Every changed or untracked path in the checkout, as git lists them (nothing staged, nothing written). */
async function changedPaths(dir: string): Promise<string[]> {
  return statusPaths(
    await runCloneGit(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
  );
}

const WALK_CUT_SHORT =
  "Consola couldn't finish checking this run's checkout for repositories inside it; nothing was committed";

/**
 * Call 9's tree check, before anything is staged (review B5): a changed or
 * untracked regular file with more than one link (a hard link lets
 * Consola's unsandboxed read commit a file the sandbox denies), then a
 * repository inside the checkout (any entry named `.git`, case aside, below
 * its root, whose config would run in any git started there). The walk
 * follows no link and is bounded, as cleanup's is: cut short it fails as
 * unknown (fail closed). Null when neither.
 */
export async function treeProblem(
  dir: string,
  step: string,
  limits: { directories: number; deadlineMs: number } = {
    directories: 200_000,
    deadlineMs: 20_000,
  },
): Promise<string | null> {
  for (const file of await changedPaths(dir)) {
    const stat = fs.lstatSync(path.join(dir, file), { throwIfNoEntry: false });
    if (stat?.isFile() && stat.nlink > 1)
      return `\`${step}\` left \`${file}\` hard-linked to another file; Consola commits only the checkout's own files`;
  }
  const started = Date.now();
  const folders = [''];
  let visited = 0;
  while (folders.length > 0) {
    const relative = folders.pop()!;
    visited += 1;
    if (visited > limits.directories || Date.now() - started >= limits.deadlineMs)
      return WALK_CUT_SHORT;
    for (const entry of fs.readdirSync(path.join(dir, relative), { withFileTypes: true })) {
      const inside = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.name.toLowerCase() === '.git' && relative !== '')
        return `\`${step}\` left a repository inside the checkout (\`${inside}\`); Consola commits only the checkout's own files`;
      if (entry.isDirectory()) folders.push(inside);
    }
  }
  return null;
}

/** HEAD on `branch`, and `branch` still descending from `before` (replace refs and grafts off): the words when not. */
async function headProblem(
  dir: string,
  branch: string,
  before: string,
  session?: string,
): Promise<string | null> {
  const head = await runCloneGit(dir, ['symbolic-ref', '-q', 'HEAD']).then(
    (said) => said.trim(),
    () => '',
  );
  const who = session === undefined ? 'the step' : openedByYou(session);
  if (head !== `refs/heads/${branch}`) return `${who} moved \`HEAD\` off ${branch}`;
  if (!(await answers(dir, ['merge-base', '--is-ancestor', before, `refs/heads/${branch}`])))
    return session === undefined
      ? `the step moved ${branch} off the commit it started from (${before.slice(0, 7)})`
      : `${who} moved ${branch} off the commit the run was at (${before.slice(0, 7)})`;
  return null;
}

/** A person's session, as a between-steps refusal names it (slice 3-B Task 14): `` `<name>`, opened by you, ``. */
const openedByYou = (session: string) => `\`${session}\`, opened by you,`;

/** The paths that differ between `from` and `to` (the working tree when `to` is absent). */
async function namesBetween(dir: string, from: string, to?: string): Promise<string[]> {
  const listed = await runCloneGit(dir, ['diff', '--name-only', '-z', from, ...(to ? [to] : [])]);
  return listed.split('\0').filter(Boolean);
}

/** `<a>, <b>, …` for at most ten, then `and <n> more`. */
function namedAtMostTen(paths: string[]): string {
  const shown = paths.slice(0, 10).join(', ');
  return paths.length > 10 ? `${shown} and ${paths.length - 10} more` : shown;
}

/**
 * Steps 2–6 of *Commits, and the checks between steps*, for one step: the
 * folder; `HEAD` on the branch; the branch descending from `before`; the
 * tree; then, for an agent step, `git add -A` and Consola's commit (none
 * when nothing is left; an agent's own commit on `host` is kept), for a
 * command step the leftovers refusal, and for a failed attempt
 * (`keepOnly`) nothing committed; `changes.patch` in the attempt folder
 * (`before` to `after`, or to the working tree, untracked included, for a
 * failed one). A problem fails the step, in the Global Constraints' words,
 * and commits nothing.
 */
export async function settleRunClone(request: SettleRequest): Promise<SettleResult> {
  const { dir, branch, before, step, commit, attemptDir, keepOnly } = request;
  const folder = gitFolderProblem(dir);
  if (folder) return { ok: false, error: changedFolder(folder) };
  try {
    const moved = await headProblem(dir, branch, before);
    if (moved) return { ok: false, error: moved };
    const tree = await treeProblem(dir, step);
    if (tree) return { ok: false, error: tree };
    if (keepOnly) {
      // Untracked files join the patch as intent-to-add, and leave the index as they came.
      await runCloneGit(dir, ['add', '-A', '-N']);
      const patch = await runCloneGit(dir, [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--binary',
        before,
      ]);
      const names = await namesBetween(dir, before);
      await runCloneGit(dir, ['reset', '-q']);
      writePatch(attemptDir, patch);
      const after = (await runCloneGit(dir, ['rev-parse', 'HEAD'])).trim();
      return { ok: true, after, files: names.length, flagged: flaggedPaths(names) };
    }
    if (commit) {
      const refused = await stageChecked(dir, step);
      if (refused) return { ok: false, error: refused };
      if (!(await answers(dir, ['diff', '--cached', '--quiet'])))
        await runCloneGit(dir, ['commit', '-q', '--no-verify', '-m', commit.message]);
    } else {
      const left = await changedPaths(dir);
      if (left.length > 0)
        return { ok: false, error: `\`${step}\` left files changed: ${namedAtMostTen(left)}` };
    }
    const after = (await runCloneGit(dir, ['rev-parse', 'HEAD'])).trim();
    const names = await namesBetween(dir, before, after);
    if (commit)
      writePatch(
        attemptDir,
        await runCloneGit(dir, [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--binary',
          before,
          after,
        ]),
      );
    return { ok: true, after, files: names.length, flagged: flaggedPaths(names) };
  } catch (error) {
    return {
      ok: false,
      error: `Consola couldn't settle \`${step}\`'s checkout: ${describe(error)}`,
    };
  }
}

/** git in the run clone with `input` on its stdin: its trimmed stdout. */
function runCloneGitWithInput(dir: string, args: string[], input: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: dir,
      env: runCloneGitEnv(dir, process.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim().split('\n').pop() || `git exited ${code}`));
    });
    child.stdin.end(input);
  });
}

const notOwnFile = (who: string, file: string, why: string) =>
  `\`${who}\` left \`${file}\`${why}; Consola commits only the checkout's own files`;

/** The first folder on `file`'s way (inside `dir`) that is a link, or null. */
function linkedFolderOn(dir: string, file: string): string | null {
  const parts = file.split('/');
  for (let i = 1; i < parts.length; i++) {
    const folder = parts.slice(0, i).join('/');
    if (fs.lstatSync(path.join(dir, folder), { throwIfNoEntry: false })?.isSymbolicLink())
      return folder;
  }
  return null;
}

/**
 * Stage `paths` (what `git status` lists) as Consola read them, never by
 * letting git read them again by path (the commit review: a leftover still
 * writing the checkout could swap a file for a hard link, or a folder for a
 * link, between the check and git's read). Each regular file is opened
 * `O_NOFOLLOW`, its descriptor's link count checked to be 1, its bytes read
 * from that descriptor and the path checked to still be that file, then
 * written as an object (`hash-object -w --stdin --path`, so the repository's
 * line-ending rules apply as `git add`'s would, and no filter) and put in the
 * index (`update-index --cacheinfo`); a link is staged as a link, a gone
 * file removed; a path behind a linked folder, or that is no file, is
 * refused. Null when all were staged; else why not, nothing more staged.
 * Exported for its tests.
 */
export async function stageByDescriptor(
  dir: string,
  who: string,
  paths: readonly string[],
): Promise<string | null> {
  for (const file of paths) {
    if (linkedFolderOn(dir, file) !== null) return notOwnFile(who, file, ' behind a linked folder');
    const full = path.join(dir, file);
    const stat = fs.lstatSync(full, { throwIfNoEntry: false });
    if (!stat) {
      await runCloneGit(dir, ['update-index', '--force-remove', '--', file]);
      continue;
    }
    if (stat.isSymbolicLink()) {
      const object = await runCloneGitWithInput(
        dir,
        ['hash-object', '-w', '--stdin', '--no-filters'],
        Buffer.from(fs.readlinkSync(full)),
      );
      await runCloneGit(dir, ['update-index', '--add', '--cacheinfo', `120000,${object},${file}`]);
      continue;
    }
    if (!stat.isFile()) return notOwnFile(who, file, ', which is not a file');
    const fd = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let bytes: Buffer;
    let mode: string;
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.nlink !== 1)
        return notOwnFile(who, file, ' hard-linked to another file');
      bytes = fs.readFileSync(fd);
      const now = fs.lstatSync(full, { throwIfNoEntry: false });
      // The path must still be the file read, reached by no linked folder.
      if (!now || now.ino !== opened.ino || now.dev !== opened.dev || linkedFolderOn(dir, file))
        return notOwnFile(who, file, ', which changed while Consola read it');
      mode = (opened.mode & 0o111) !== 0 ? '100755' : '100644';
    } finally {
      fs.closeSync(fd);
    }
    // `--path`: the repository's own line-ending rules apply, as `git add`'s would; no filter can (the git folder's attributes).
    const object = await runCloneGitWithInput(
      dir,
      ['hash-object', '-w', '--stdin', '--path', file],
      bytes,
    );
    await runCloneGit(dir, ['update-index', '--add', '--cacheinfo', `${mode},${object},${file}`]);
  }
  return null;
}

/**
 * Stage everything a step or a session left, by descriptor, then check the
 * tree again before anything is committed (the commit review: what changed
 * after the first check); a refusal puts the index back to `HEAD`.
 */
export async function stageChecked(dir: string, who: string): Promise<string | null> {
  const refused =
    (await stageByDescriptor(dir, who, await changedPaths(dir))) ?? (await treeProblem(dir, who));
  if (refused) await runCloneGit(dir, ['reset', '-q']);
  return refused;
}

function writePatch(attemptDir: string, patch: string): void {
  fs.mkdirSync(attemptDir, { recursive: true });
  fs.writeFileSync(path.join(attemptDir, 'changes.patch'), patch);
}

/**
 * Between steps: what a person's session left (never ending a process),
 * committed apart with `message`. The folder is checked first, so a pointer
 * rewritten between steps fails the boundary even when nothing else
 * changed (review NB1); then `HEAD` and the branch, as after a step. Null
 * when nothing changed and `HEAD` is still `before`.
 */
export async function settleBetweenSteps(request: {
  dir: string;
  branch: string;
  base: string;
  before: string;
  message: string;
  /**
   * The session the run last saw holding the checkout, for a refusal's words
   * (`` `<name>`, opened by you, moved `HEAD` off <branch> ``); absent, the
   * tree's refusals say `a session` and the rest the step's words.
   */
  session?: string;
}): Promise<SettleResult | null> {
  const { dir, branch, before, message, session } = request;
  const folder = gitFolderProblem(dir);
  if (folder)
    return {
      ok: false,
      error:
        session === undefined
          ? changedFolder(folder)
          : `${openedByYou(session)} changed this checkout's git folder (${folder}), so Consola will not commit in it`,
    };
  try {
    const moved = await headProblem(dir, branch, before, session);
    if (moved) return { ok: false, error: moved };
    // Before the look for changes: git lists no change for a repository planted inside the checkout.
    const tree = await treeProblem(dir, request.session ?? 'a session');
    if (tree) return { ok: false, error: tree };
    const left = await changedPaths(dir);
    const head = (await runCloneGit(dir, ['rev-parse', 'HEAD'])).trim();
    if (left.length === 0 && head === before) return null;
    if (left.length > 0) {
      const refused = await stageChecked(dir, request.session ?? 'a session');
      if (refused) return { ok: false, error: refused };
      await runCloneGit(dir, ['commit', '-q', '--no-verify', '-m', message]);
    }
    const after = (await runCloneGit(dir, ['rev-parse', 'HEAD'])).trim();
    const names = await namesBetween(dir, before, after);
    return { ok: true, after, files: names.length, flagged: flaggedPaths(names) };
  } catch (error) {
    return { ok: false, error: `Consola couldn't check this run's checkout: ${describe(error)}` };
  }
}

/** Throws the folder check's words, for a reset, a diff or a read, which nothing must run on a changed folder. */
function assertFolder(dir: string): void {
  const folder = gitFolderProblem(dir);
  if (folder) throw new Error(changedFolder(folder));
}

/**
 * Back to `before` for a retry: the working tree, the index and, given
 * `branch`, the branch with `HEAD` on it (an agent may have moved either);
 * every untracked and ignored file goes but `.consola-cache/` and the
 * pointer. After the folder check.
 */
export async function resetRunClone(dir: string, before: string, branch?: string): Promise<void> {
  assertFolder(dir);
  if (branch !== undefined) await runCloneGit(dir, ['checkout', '-q', '-f', '-B', branch, before]);
  else await runCloneGit(dir, ['reset', '-q', '--hard', before]);
  await runCloneGit(dir, ['clean', '-q', '-ffdx', '-e', '.consola-cache']);
}

/** `base..head`'s diff as text, cut at `maxBytes` on a character's edge; `bytes` is its whole size. */
export async function runCloneChanges(
  dir: string,
  base: string,
  head: string,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean; bytes: number }> {
  assertFolder(dir);
  const { kept, bytes } = await streamGit(
    dir,
    ['diff', '--no-ext-diff', '--no-textconv', base, head],
    maxBytes,
  );
  let cut = Math.min(kept.length, maxBytes);
  // Back off to the start of a character, so the text never ends in half of one.
  while (cut > 0 && cut < kept.length && (kept[cut] & 0xc0) === 0x80) cut -= 1;
  return { text: kept.subarray(0, cut).toString('utf8'), truncated: bytes > maxBytes, bytes };
}

/** git's stdout, keeping at most `keep` bytes (and one more, to find a character's edge) and counting the rest. */
function streamGit(
  dir: string,
  args: string[],
  keep: number,
): Promise<{ kept: Buffer; bytes: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: dir,
      env: runCloneGitEnv(dir, process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let held = 0;
    let bytes = 0;
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (held <= keep) {
        chunks.push(chunk);
        held += chunk.length;
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve({ kept: Buffer.concat(chunks), bytes });
      else reject(new Error(stderr.trim().split('\n').pop() || `git exited ${code}`));
    });
  });
}

/**
 * A path artifact's file at `commit` (*Artifacts with a `path:`*): its text
 * when it is a regular file of at most `maxBytes`; else why not. The path is
 * literal, never a pattern.
 */
export async function runCloneShowAt(
  dir: string,
  commit: string,
  file: string,
  maxBytes: number,
): Promise<
  { ok: true; text: string } | { ok: false; reason: 'missing' | 'not-a-file' | 'too-large' }
> {
  assertFolder(dir);
  // `ls-tree` takes a path, never a pattern; the entry must name `file` exactly.
  const listed = await runCloneGit(dir, ['ls-tree', '-z', commit, '--', file]);
  const entry = listed.split('\0').find((line) => line.endsWith(`\t${file}`));
  if (!entry) return { ok: false, reason: 'missing' };
  const [mode, type, object] = entry.slice(0, entry.indexOf('\t')).split(' ');
  if (type !== 'blob' || mode === '120000') return { ok: false, reason: 'not-a-file' };
  const size = Number((await runCloneGit(dir, ['cat-file', '-s', object])).trim());
  if (size > maxBytes) return { ok: false, reason: 'too-large' };
  return { ok: true, text: await runCloneGit(dir, ['cat-file', 'blob', object]) };
}
