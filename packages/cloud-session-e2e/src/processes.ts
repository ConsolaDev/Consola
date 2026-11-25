// @effect-diagnostics nodeBuiltinImport:off - It starts processes and finds free ports on this machine.
// @effect-diagnostics globalTimers:off - Its waits poll outside any Effect runtime.
// @effect-diagnostics globalDate:off - Its waits read the wall clock.
/**
 * What both end-to-end tests start their processes with: node scripts whose output they keep, a
 * wait that polls, a free port for the cell, and the processes below a runner (its sandboxes), so
 * the teardown leaves nothing running.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import type { Server } from 'node:http';
import { type AddressInfo, createServer as createNetServer } from 'node:net';

/** Starting node and loading t3 takes seconds; under load, far more. */
export const WAIT_MS = 90_000;

export type Exited = { readonly code: number | null; readonly signal: NodeJS.Signals | null };

/** A process the test started: what it printed, and how it ended. */
export type Started = {
  readonly child: ChildProcess;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly exited: Promise<Exited>;
};

export const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** `probe`'s first answer that is not undefined, asked every 100 ms until `timeoutMs`. */
export const waitFor = async <A>(
  probe: () => A | undefined | Promise<A | undefined>,
  what: string,
  timeoutMs: number = WAIT_MS,
): Promise<A> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const answer = await probe();
    if (answer !== undefined) return answer;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
};

/** Starts `node <script> <args>` with `env`, collecting what it prints. */
export const startNode = (
  script: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): Started => {
  // The machine's PATH holds only fake CLIs and /usr/bin:/bin, so node is named by its path.
  const child = spawn(process.execPath, [script, ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<Exited>((done) =>
    child.on('exit', (code, signal) => done({ code, signal })),
  );
  return { child, stdout: () => stdout, stderr: () => stderr, exited };
};

export const isRunning = (child: ChildProcess) =>
  child.exitCode === null && child.signalCode === null;

export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Every process below `pid`: a runner's sandboxes are its children. */
export const descendantsOf = (pid: number): number[] => {
  const table = execFileSync('ps', ['-A', '-o', 'pid=', '-o', 'ppid='], { encoding: 'utf8' })
    .split('\n')
    .map((row) => row.trim().split(/\s+/).map(Number))
    .filter((row): row is [number, number] => row.length === 2 && row.every(Number.isFinite));
  const found: number[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const [child, ppid] of table) {
      if (ppid === parent && !found.includes(child)) {
        found.push(child);
        queue.push(child);
      }
    }
  }
  return found;
};

/** A port nothing listens on just now, for the cell (its `PORT` takes no 0). */
export const freePort = () =>
  new Promise<number>((done, fail) => {
    const server = createNetServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => done(port));
    });
  });

export const portOf = (server: Server) => (server.address() as AddressInfo).port;

/** Waits until none of `pids` is alive. */
export const noneAlive = (pids: ReadonlyArray<number>, what: string) =>
  waitFor(() => (pids.every((pid) => !isAlive(pid)) ? true : undefined), what);
