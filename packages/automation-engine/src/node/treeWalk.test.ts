import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeRunClone, treeProblem } from './runCheckout';

/*
 * The 3-B code review's F4: `treeProblem` walks a whole checkout, in
 * Electron's main process, twice per agent settle and at every boundary. It
 * reads each folder asynchronously, so the process serves its terminals and
 * windows between reads; this pins that no folder is read with the
 * synchronous call, which would hold the process for the whole walk.
 */

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return { ...real, readdirSync: vi.fn(real.readdirSync) };
});

let tmp: string;
let dir: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: process.env }).trim();

beforeEach(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-tree-walk-')));
  fs.writeFileSync(path.join(tmp, 'gitconfig'), '');
  vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(tmp, 'gitconfig'));
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  const remote = path.join(tmp, 'remote.git');
  const source = path.join(tmp, 'catalog-portal');
  git(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
  git(tmp, 'clone', '-q', remote, source);
  git(source, 'config', 'user.name', 'alice');
  git(source, 'config', 'user.email', 'alice@sprocket.example');
  fs.writeFileSync(path.join(source, 'README.md'), 'catalog-portal\n');
  git(source, 'add', '-A');
  git(source, 'commit', '-q', '-m', 'first');
  git(source, 'push', '-q', 'origin', 'HEAD:main');
  fs.mkdirSync(path.join(tmp, 'worktrees'));
  dir = path.join(tmp, 'worktrees', 'catalog-portal-run-3f2a91c0');
  await makeRunClone({ source, dir, branch: 'fix/a', runId: 'r', fetchEnv: process.env });
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the checkout's tree walk (3-B code review F4)", () => {
  it('reads no folder of the checkout synchronously, and still finds what it looks for', async () => {
    for (let i = 0; i < 5; i++) {
      fs.mkdirSync(path.join(dir, 'node_modules', `p${i}`, 'lib'), { recursive: true });
    }
    fs.mkdirSync(path.join(dir, 'deep', 'er'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'deep', 'er', '.git'), 'gitdir: /tmp/x\n');
    const readdirSync = vi.mocked(fs.readdirSync);
    readdirSync.mockClear();
    expect(await treeProblem(dir, 'fix')).toBe(
      "`fix` left a repository inside the checkout (`deep/er/.git`); Consola commits only the checkout's own files",
    );
    const insideCheckout = readdirSync.mock.calls.filter(([at]) => String(at).startsWith(dir));
    expect(insideCheckout).toEqual([]);
  });
});
