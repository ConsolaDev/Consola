import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalServers, parseListeners } from './LocalServers';

const LISTENING = [
  'p501',
  'cvite',
  'n*:5173',
  'p502',
  'cnode',
  'n127.0.0.1:3000',
  'n[::1]:3000',
  'p503',
  'cpostgres',
  'n192.168.1.20:5432',
  'p504',
  'cControlCe',
  'n*:7000',
  '',
].join('\n');

describe('parseListeners', () => {
  it('reads each listener once with its command and port', () => {
    expect(parseListeners(LISTENING)).toEqual([
      { pid: 501, command: 'vite', port: 5173 },
      { pid: 502, command: 'node', port: 3000 },
      { pid: 504, command: 'ControlCe', port: 7000 },
    ]);
  });

  it('skips a socket bound to an address localhost does not reach', () => {
    expect(parseListeners('p1\ncdb\nn10.0.0.5:5432\n')).toEqual([]);
  });

  it('keeps every port a process listens on', () => {
    const output = 'p9\ncnode\nn*:3000\nn*:3001\n';
    expect(parseListeners(output).map((l) => l.port)).toEqual([3000, 3001]);
  });

  it('ignores a name with no port', () => {
    expect(parseListeners('p1\ncx\nn*:abc\nn*\n')).toEqual([]);
  });

  it('reads nothing from empty output', () => {
    expect(parseListeners('')).toEqual([]);
  });
});

describe('LocalServers.listFor', () => {
  let root: string;
  let inside: string;
  let outside: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-servers-')));
    inside = path.join(root, 'project');
    outside = path.join(root, 'elsewhere');
    fs.mkdirSync(path.join(inside, 'packages', 'web'), { recursive: true });
    fs.mkdirSync(outside);
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const runnerFor =
    (cwds: Record<number, string>, listening = LISTENING) =>
    async (_binary: string, args: string[]) => {
      if (args.includes('-iTCP')) return { code: 0, stdout: listening };
      const pids = (args[args.indexOf('-p') + 1] ?? '').split(',').map(Number);
      const stdout = pids
        .filter((pid) => cwds[pid] !== undefined)
        .map((pid) => `p${pid}\nn${cwds[pid]}\n`)
        .join('');
      return { code: 0, stdout };
    };

  it('lists the servers whose working folder is inside the session folder', async () => {
    const servers = new LocalServers(
      runnerFor({
        501: path.join(inside, 'packages', 'web'),
        502: outside,
        504: inside,
      }),
      'darwin',
    );
    expect(await servers.listFor(inside)).toEqual([
      { port: 5173, command: 'vite', url: 'http://localhost:5173' },
      { port: 7000, command: 'ControlCe', url: 'http://localhost:7000' },
    ]);
  });

  it('does not list a server started from a sibling folder with a shared prefix', async () => {
    const sibling = `${inside}-other`;
    fs.mkdirSync(sibling);
    const servers = new LocalServers(runnerFor({ 501: sibling }), 'linux');
    expect(await servers.listFor(inside)).toEqual([]);
  });

  it('follows a symlinked folder on either side', async () => {
    const link = path.join(root, 'link');
    fs.symlinkSync(inside, link);
    const servers = new LocalServers(runnerFor({ 501: inside }), 'linux');
    expect((await servers.listFor(link)).map((s) => s.port)).toEqual([5173]);

    const linkedCwd = new LocalServers(runnerFor({ 501: path.join(link, 'packages') }), 'linux');
    expect((await linkedCwd.listFor(inside)).map((s) => s.port)).toEqual([5173]);
  });

  it('answers nothing for a folder that does not exist', async () => {
    const servers = new LocalServers(runnerFor({ 501: inside }), 'linux');
    expect(await servers.listFor(path.join(root, 'gone'))).toEqual([]);
  });

  it('answers nothing without a folder', async () => {
    const servers = new LocalServers(runnerFor({ 501: inside }), 'linux');
    expect(await servers.listFor(undefined)).toEqual([]);
  });

  it('answers nothing when lsof cannot run', async () => {
    const servers = new LocalServers(async () => ({ code: -1, stdout: '' }), 'linux');
    expect(await servers.listFor(inside)).toEqual([]);
  });

  it('answers nothing when lsof throws', async () => {
    const servers = new LocalServers(async () => {
      throw new Error('spawn lsof ENOENT');
    }, 'linux');
    expect(await servers.listFor(inside)).toEqual([]);
  });

  it('answers nothing when the cwd lookup fails after listeners were found', async () => {
    const servers = new LocalServers(async (_binary, args) => {
      if (args.includes('-iTCP')) return { code: 0, stdout: LISTENING };
      return { code: -1, stdout: '' };
    }, 'linux');
    expect(await servers.listFor(inside)).toEqual([]);
  });

  it('answers nothing on Windows without running anything', async () => {
    let ran = false;
    const servers = new LocalServers(async () => {
      ran = true;
      return { code: 0, stdout: LISTENING };
    }, 'win32');
    expect(await servers.listFor(inside)).toEqual([]);
    expect(ran).toBe(false);
  });

  it('accepts the partial output of an lsof that exited 1', async () => {
    const run = async (_binary: string, args: string[]) =>
      args.includes('-iTCP')
        ? { code: 1, stdout: LISTENING }
        : { code: 1, stdout: `p501\nn${inside}\n` };
    const servers = new LocalServers(run, 'linux');
    expect((await servers.listFor(inside)).map((s) => s.port)).toEqual([5173]);
  });

  it('never lists this process', async () => {
    const listening = `p${process.pid}\ncElectron\nn127.0.0.1:9999\n`;
    const servers = new LocalServers(runnerFor({ [process.pid]: inside }, listening), 'linux');
    expect(await servers.listFor(inside)).toEqual([]);
  });
});
