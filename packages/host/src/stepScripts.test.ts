// @effect-diagnostics nodeBuiltinImport:off - It runs the step sandbox's scripts with sh, against a git repository on disk.
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { readSessionLine } from './core/runnerDecisions.ts';
import {
  CHECKOUT_CLAUDE_SETTINGS,
  cutLine,
  jsonFileText,
  STEP_THREAD_TITLE,
  stepT3Settings,
} from './core/steps/stepSandbox.ts';
import { isolateMachine } from './testing/machine.ts';

/**
 * The step sandbox's two scripts (`sandbox-template/consola-step-checkout`,
 * `consola-step-start`), run with `sh` on a machine of the test's own: the checkout against a
 * repository on disk standing in for github.com (a `git` first on the PATH that points the URL
 * there), the start with a `node` that records how the host would have started.
 */
const machine = isolateMachine();

const TEMPLATE = join(import.meta.dirname, '..', 'sandbox-template');
const CHECKOUT_SCRIPT = join(TEMPLATE, 'consola-step-checkout');
const START_SCRIPT = join(TEMPLATE, 'consola-step-start');
const REPOSITORY = 'sprocket/catalog-portal';
const GITHUB_URL = `https://github.com/${REPOSITORY}.git`;
/** Not a real token; its `/` and `+` make its URL-encoded form differ from it. */
const GIT_TOKEN = 'ghs_Sprocket/Step+0123456789';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const folder = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};

/** The real git, found on the machine's own folders (the fakes hold none). */
const realGit = (): string =>
  spawnSync('/bin/sh', ['-c', 'command -v git'], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin' },
  }).stdout.trim();

const git = (cwd: string, ...args: string[]): string => {
  const ran = spawnSync(
    realGit(),
    ['-c', 'user.name=Sprocket', '-c', 'user.email=dev@sprocket.invalid', ...args],
    { cwd, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: machine.home() } },
  );
  if (ran.status !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr}`);
  return ran.stdout.trim();
};

const writeScript = (file: string, lines: readonly string[]) => {
  writeFileSync(file, ['#!/bin/sh', ...lines, ''].join('\n'));
  chmodSync(file, 0o755);
};

/**
 * github.com, on disk: `catalog-portal` with `main` and pull request 42, whose head (`head`) is on
 * no branch, only `refs/pull/42/head`, as GitHub keeps it.
 */
const remote = (changedLines = 3) => {
  const root = folder('consola-step-remote-');
  const work = join(root, 'work');
  const origin = join(root, 'origin.git');
  mkdirSync(work);
  git(work, 'init', '-q', '-b', 'main');
  writeFileSync(join(work, 'README.md'), '# Catalog portal\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'Start');
  const base = git(work, 'rev-parse', 'HEAD');
  git(work, 'checkout', '-q', '-b', 'feature');
  writeFileSync(
    join(work, 'checkout.ts'),
    Array.from(
      { length: changedLines },
      (_, index) => `export const line${index} = ${index};`,
    ).join('\n'),
  );
  writeFileSync(join(work, 'README.md'), '# Catalog portal\n\nNow with checkout.\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'Checkout');
  const head = git(work, 'rev-parse', 'HEAD');
  git(root, 'init', '-q', '--bare', origin);
  git(work, 'push', '-q', origin, 'main:refs/heads/main', `${head}:refs/pull/42/head`);
  return { origin, base, head };
};

/** A machine for a script: stand-ins first on the PATH, and the workspace it works in. */
const scriptMachine = (origin: string) => {
  const root = folder('consola-step-scripts-');
  const bin = join(root, 'bin');
  const workspace = join(root, 'workspace');
  mkdirSync(bin);
  mkdirSync(workspace);
  // git, with github.com's address pointed at the repository on disk, recording its arguments.
  writeScript(join(bin, 'git'), [
    `printf '%s\\n' "$@" >> '${join(root, 'git.args')}'`,
    'first=1',
    'for arg in "$@"; do',
    '  if [ "$first" = 1 ]; then set --; first=0; fi',
    `  if [ "$arg" = '${GITHUB_URL}' ]; then arg='${origin}'; fi`,
    '  set -- "$@" "$arg"',
    'done',
    `exec '${realGit()}' "$@"`,
  ]);
  // node: runs the scripts' own `node -e`, and records how the host would have started.
  writeScript(join(bin, 'node'), [
    `if [ "$1" = -e ]; then exec '${process.execPath}' "$@"; fi`,
    `printf '%s\\n' "$@" > '${join(root, 'node.args')}'`,
    'exit 0',
  ]);
  const read = (name: string): string | null => {
    const file = join(root, name);
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  };
  return { root, bin, workspace, read, repo: join(workspace, 'repo') };
};

const run = (
  script: string,
  scripted: ReturnType<typeof scriptMachine>,
  env: Readonly<Record<string, string>>,
) =>
  spawnSync('/bin/sh', [script], {
    encoding: 'utf8',
    env: {
      HOME: machine.home(),
      PATH: `${scripted.bin}:/usr/bin:/bin`,
      CONSOLA_WORKSPACE: scripted.workspace,
      ...env,
    },
  });

describe('consola-step-checkout', () => {
  it('checks out the pull request head by its commit, hooks off, the token written nowhere', () => {
    const { origin, head } = remote();
    const scripted = scriptMachine(origin);
    const ran = run(CHECKOUT_SCRIPT, scripted, {
      CONSOLA_REPOSITORY: REPOSITORY,
      CONSOLA_CHECKOUT_COMMIT: head,
      CONSOLA_CHECKOUT_PULL_REQUEST: '42',
      GIT_TOKEN,
    });
    expect(ran.status, ran.stderr).toBe(0);
    expect(ran.stdout).toBe('');
    expect(git(scripted.repo, 'rev-parse', 'HEAD')).toBe(head);
    const config = (key: string) =>
      spawnSync(realGit(), ['-C', scripted.repo, 'config', '--get', key], {
        encoding: 'utf8',
      }).stdout.trim();
    expect(config('core.hooksPath')).toBe('/dev/null');
    expect(config('user.name')).toBe('Consola step');
    expect(readFileSync(join(scripted.repo, '.git', 'config'), 'utf8')).not.toContain(GIT_TOKEN);
    expect(scripted.read('git.args')).not.toContain(GIT_TOKEN);
    expect(scripted.read('git.args')).toContain(GITHUB_URL);
    // A command step's checkout writes no changes document.
    expect(existsSync(join(scripted.workspace, '.consola', 'changes.md'))).toBe(false);
  });

  it("writes an agent step's pull request changes: its files, then its diff against the merge base", () => {
    const { origin, base, head } = remote();
    const scripted = scriptMachine(origin);
    const ran = run(CHECKOUT_SCRIPT, scripted, {
      CONSOLA_REPOSITORY: REPOSITORY,
      CONSOLA_CHECKOUT_COMMIT: head,
      CONSOLA_CHECKOUT_PULL_REQUEST: '42',
      CONSOLA_CHECKOUT_BASE_REF: 'main',
      CONSOLA_CHANGES_MAX_BYTES: String(512 * 1024),
    });
    expect(ran.status, ran.stderr).toBe(0);
    expect(ran.stdout).toBe('');
    const changes = readFileSync(join(scripted.workspace, '.consola', 'changes.md'), 'utf8');
    expect(changes).toContain(
      `Changes of pull request #42 since its merge base with main (${base.slice(0, 7)}), at ${head.slice(0, 7)}.`,
    );
    expect(changes).toContain('Files changed:\nM\tREADME.md\nA\tcheckout.ts\n');
    expect(changes).toContain('Diff:\ndiff --git a/README.md b/README.md');
    expect(changes).toContain('+Now with checkout.');
    expect(changes).not.toContain('\u001b[');
    expect(changes).not.toContain('[cut here');
  });

  it('cuts a long diff, keeping the file list whole and saying how much was left out', () => {
    const { origin, head } = remote(2000);
    const scripted = scriptMachine(origin);
    const max = 4000;
    const ran = run(CHECKOUT_SCRIPT, scripted, {
      CONSOLA_REPOSITORY: REPOSITORY,
      CONSOLA_CHECKOUT_COMMIT: head,
      CONSOLA_CHECKOUT_PULL_REQUEST: '42',
      CONSOLA_CHECKOUT_BASE_REF: 'main',
      CONSOLA_CHANGES_MAX_BYTES: String(max),
    });
    expect(ran.status, ran.stderr).toBe(0);
    const changes = readFileSync(join(scripted.workspace, '.consola', 'changes.md'), 'utf8');
    expect(Buffer.byteLength(changes)).toBeLessThanOrEqual(max);
    expect(changes).toContain('Files changed:\nM\tREADME.md\nA\tcheckout.ts\n');
    const last = changes.trimEnd().split('\n').at(-1) ?? '';
    const whole = Buffer.byteLength(
      git(scripted.repo, 'diff', '--no-color', '--find-renames', 'refs/remotes/origin/main...HEAD'),
    );
    const left = Number(/\((\d+) bytes\)/.exec(last)?.[1]);
    expect(last).toBe(cutLine(left));
    // What was kept and what was left out make the whole diff (git's output, less its last newline).
    const kept = Buffer.byteLength(
      changes.slice(changes.indexOf('Diff:\n') + 6, changes.lastIndexOf('\n[cut here')),
    );
    expect(kept + left).toBe(whole + 1);
  });

  it('says in one line why the changes are missing when the base is gone, and does not fail', () => {
    const { origin, head } = remote();
    const scripted = scriptMachine(origin);
    const ran = run(CHECKOUT_SCRIPT, scripted, {
      CONSOLA_REPOSITORY: REPOSITORY,
      CONSOLA_CHECKOUT_COMMIT: head,
      CONSOLA_CHECKOUT_PULL_REQUEST: '42',
      CONSOLA_CHECKOUT_BASE_REF: 'release/gone',
    });
    expect(ran.status, ran.stderr).toBe(0);
    expect(git(scripted.repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(readFileSync(join(scripted.workspace, '.consola', 'changes.md'), 'utf8')).toBe(
      'The changes of pull request #42 could not be read: its base branch release/gone could not be fetched.\n',
    );
  });

  it('on a failed clone prints one clone-failed line without the token, and exits 1', () => {
    const scripted = scriptMachine(join(folder('consola-step-none-'), 'missing.git'));
    writeScript(join(scripted.bin, 'git'), [
      `echo "fatal: unable to access 'https://x-access-token:${GIT_TOKEN}@github.com/${REPOSITORY}.git/': 403" >&2`,
      `echo "remote: invalid credentials ${encodeURIComponent(GIT_TOKEN)}" >&2`,
      'exit 128',
    ]);
    const ran = run(CHECKOUT_SCRIPT, scripted, {
      CONSOLA_REPOSITORY: REPOSITORY,
      CONSOLA_CHECKOUT_COMMIT: '0123456789abcdef0123456789abcdef01234567',
      GIT_TOKEN,
    });
    expect(ran.status).toBe(1);
    const lines = ran.stdout.split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(1);
    const read = readSessionLine(lines[0] ?? '');
    expect(read.kind).toBe('clone-failed');
    expect(read.kind === 'clone-failed' ? read.message : '').toContain(
      `Could not clone ${REPOSITORY}: `,
    );
    for (const output of [ran.stdout, ran.stderr]) {
      expect(output).not.toContain(GIT_TOKEN);
      expect(output).not.toContain(encodeURIComponent(GIT_TOKEN));
    }
  });

  it('refuses a commit that is not a commit id before running git', () => {
    const scripted = scriptMachine('/nowhere');
    const ran = run(CHECKOUT_SCRIPT, scripted, {
      CONSOLA_REPOSITORY: REPOSITORY,
      CONSOLA_CHECKOUT_COMMIT: '--upload-pack=touch /tmp/x',
    });
    expect(ran.status).toBe(1);
    expect(ran.stderr).toMatch(/not a commit id/);
    expect(scripted.read('git.args')).toBeNull();
  });
});

describe('consola-step-start', () => {
  const PASS_PUBLIC_KEY = generateKeyPairSync('ed25519')
    .publicKey.export({ type: 'spki', format: 'pem' })
    .toString();

  /** A step's workspace as the runner leaves it before the script: its t3 settings written. */
  const stepWorkspace = (scripted: ReturnType<typeof scriptMachine>) => {
    const settings = join(scripted.workspace, '.consola', 't3-state', 'userdata', 'settings.json');
    mkdirSync(dirname(settings), { recursive: true });
    writeFileSync(settings, jsonFileText(stepT3Settings()));
    return { stepFolder: join(scripted.workspace, '.consola', 'step') };
  };

  const startEnv = (
    scripted: ReturnType<typeof scriptMachine>,
    home: string,
    stepFolder: string,
  ): Record<string, string> => ({
    HOME: home,
    PATH: `${scripted.bin}:/usr/bin:/bin`,
    CONSOLA_WORKSPACE: scripted.workspace,
    CONSOLA_SESSION_ID: 'step-run-review-1',
    CONSOLA_HARNESS: 'claude',
    CONSOLA_PASS_PUBLIC_KEY: PASS_PUBLIC_KEY,
    CONSOLA_SESSION_IDLE_MINUTES: '10',
    CONSOLA_STEP_FOLDER: stepFolder,
    ANTHROPIC_API_KEY: 'sk-ant-sprocket-step-0123456789',
  });

  it("takes the checkout's own Claude settings out, writes the key, then runs the host in the step's state with a title", () => {
    const scripted = scriptMachine('/nowhere');
    const { stepFolder } = stepWorkspace(scripted);
    const home = folder('consola-step-home-');
    // The author's checkout: settings with a hook and an allow rule, and a file that stays.
    mkdirSync(join(scripted.repo, '.claude'), { recursive: true });
    for (const name of ['settings.json', 'settings.local.json']) {
      writeFileSync(
        join(scripted.repo, '.claude', name),
        JSON.stringify({ permissions: { allow: ['Bash'] }, hooks: {} }),
      );
    }
    writeFileSync(join(scripted.repo, '.claude', 'NOTES.md'), 'kept');
    const ran = spawnSync('/bin/sh', [START_SCRIPT], {
      encoding: 'utf8',
      env: startEnv(scripted, home, stepFolder),
    });
    expect(ran.status, ran.stderr).toBe(0);
    expect(ran.stdout).toBe('');
    const keyFile = join(scripted.workspace, '.consola', 'pass-public-key.pem');
    expect(readFileSync(keyFile, 'utf8')).toBe(`${PASS_PUBLIC_KEY.trimEnd()}\n`);
    expect(existsSync(stepFolder)).toBe(true);
    expect(existsSync(join(scripted.repo, '.claude', 'settings.json'))).toBe(false);
    expect(existsSync(join(scripted.repo, '.claude', 'settings.local.json'))).toBe(false);
    expect(readFileSync(join(scripted.repo, '.claude', 'NOTES.md'), 'utf8')).toBe('kept');
    expect(CHECKOUT_CLAUDE_SETTINGS).toEqual([
      '.claude/settings.json',
      '.claude/settings.local.json',
    ]);
    expect(scripted.read('node.args')?.split('\n').slice(0, -1)).toEqual([
      '/opt/consola/consola-host.mjs',
      'session',
      '--session-id',
      'step-run-review-1',
      '--harness',
      'claude',
      '--cwd',
      scripted.repo,
      '--bind',
      '0.0.0.0',
      '--port',
      '7420',
      '--pass-public-key',
      keyFile,
      '--idle-minutes',
      '10',
      '--state-dir',
      join(scripted.workspace, '.consola', 't3-state'),
      '--title',
      STEP_THREAD_TITLE,
    ]);
    // It writes nothing into Claude's own config: `--restricted` ignores the user's settings.
    expect(existsSync(join(home, '.claude.json'))).toBe(false);
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });

  it("starts no host without the step's t3 settings, whose launch arguments hold --restricted", () => {
    const scripted = scriptMachine('/nowhere');
    const home = folder('consola-step-home-');
    const ran = spawnSync('/bin/sh', [START_SCRIPT], {
      encoding: 'utf8',
      env: startEnv(scripted, home, join(scripted.workspace, '.consola', 'step')),
    });
    expect(ran.status).toBe(1);
    expect(ran.stderr).toMatch(/t3 settings are not there/);
    expect(scripted.read('node.args')).toBeNull();
  });

  it('names no launch argument and writes no t3 settings itself: the runner writes them', () => {
    for (const script of [START_SCRIPT, CHECKOUT_SCRIPT]) {
      const text = readFileSync(script, 'utf8');
      expect(text).not.toMatch(/--permission-mode|--dangerously-skip-permissions|launchArgs/);
    }
    expect(readFileSync(START_SCRIPT, 'utf8')).not.toMatch(/> *"\$state/);
  });

  it('refuses another harness', () => {
    const scripted = scriptMachine('/nowhere');
    const ran = run(START_SCRIPT, scripted, {
      CONSOLA_SESSION_ID: 'step-1',
      CONSOLA_HARNESS: 'codex',
      CONSOLA_PASS_PUBLIC_KEY: PASS_PUBLIC_KEY,
      CONSOLA_STEP_FOLDER: join(scripted.workspace, 'step'),
    });
    expect(ran.status).toBe(1);
    expect(ran.stderr).toMatch(/Claude alone/);
    expect(scripted.read('node.args')).toBeNull();
  });
});
