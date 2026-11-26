// @effect-diagnostics nodeBuiltinImport:off - It starts the tests' host processes on a machine of its own.
// @effect-diagnostics globalTimers:off - A Vitest global setup, outside any Effect runtime.
/**
 * The browser tests' host (Vitest `globalSetup`, run in Node before any browser starts): the
 * host's own test entry, `consola-host session` replaying t3's recorded Claude `simple` fixture
 * (`@consola/host`'s `src/testing/replaySession.ts`), with its first message already sent, so the
 * fixture's answer is in the thread before `AgentChat` connects. It trusts a key pair made for the
 * run (`passKeys.ts`): each test is handed a pass of its own, signed as it starts (`render.tsx`'s
 * `host()`), and can ask for others, of any lifetime up to the protocol's five minutes
 * (`signHostPass`).
 *
 * Both processes run on a machine of their own, as the host's tests do (`@consola/host`'s
 * `AGENTS.md`, "Tests"): a temporary home, no CLI or API-key variable, and a `PATH` of fake
 * `claude`, `codex`, `opencode` and `pi` before `/usr/bin:/bin`. A fake records its call (the
 * host probes each CLI's version as it starts) and exits 1; teardown fails the run unless every
 * call saw this machine's home and no config folder, so no CLI of the developer's can run.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vite-plus/test/node';
import {
  cliVariablesIn,
  homeVariables,
  pathWith,
  readCalls,
  writeFakeClis,
} from '@consola/host/src/testing/machine.ts';
import type { ProvidedHost } from './hostSessionKey.ts';
import { PASS_MAX_LIFETIME_SECONDS } from '@consola/host/src/testing/cellPass.ts';
import { signPass, writePassKeys } from './passKeys.ts';
import { HOST_SESSION_KEY } from './hostSessionKey.ts';

const HOST_SRC = join(
  dirname(createRequire(import.meta.url).resolve('@consola/host/package.json')),
  'src',
);
const REPLAY_ENTRY = join(HOST_SRC, 'testing', 'replaySession.ts');
const SEND_ENTRY = fileURLToPath(new URL('./sendFixtureMessage.ts', import.meta.url));
const SESSION_ID = 'session-sprocket-agent-ui';
/** What the `simple` fixture's Claude answers (`claude_transcript.ndjson`). */
const ASSISTANT_TEXT = 'fixture simple ok';
/** What the replay's text generation titles every thread (`@consola/host`'s `REPLAY_TITLE`). */
const THREAD_TITLE = 'Sprocket replay title';
const START_TIMEOUT_MS = 60_000;
/**
 * How long a pass for the tests' host lives: the longest a pass may (`PASS_MAX_LIFETIME_SECONDS`,
 * five minutes). The setup's own pass sends the fixture's message; each test signs one as it
 * starts (`render.tsx`), so no pass has to outlast the run.
 */
const PASS_LIFETIME_SECONDS = PASS_MAX_LIFETIME_SECONDS;

type Machine = {
  readonly root: string;
  readonly home: string;
  readonly record: string;
  readonly env: NodeJS.ProcessEnv;
};

const makeMachine = (): Machine => {
  const root = mkdtempSync(join(tmpdir(), 'consola-agent-ui-host-'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const record = join(root, 'cli-calls.tsv');
  for (const dir of [home, bin]) mkdirSync(dir, { recursive: true });
  writeFileSync(record, '');
  writeFakeClis(bin, record);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of cliVariablesIn(env)) delete env[name];
  Object.assign(env, homeVariables(home), { PATH: pathWith(bin) });
  return { root, home, record, env };
};

/** Starts `node <script> <args>` on the machine, handing each stdout line to `onLine`. */
const startNode = (
  machine: Machine,
  script: string,
  args: readonly string[],
  onLine: (line: string) => void,
) => {
  // The machine's PATH holds only fake CLIs and /usr/bin:/bin, so node is named by its path.
  const child = spawn(process.execPath, [script, ...args], {
    env: machine.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buffered = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    buffered += chunk;
    for (let newline = buffered.indexOf('\n'); newline !== -1; newline = buffered.indexOf('\n')) {
      onLine(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
    }
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  return { child, exited, stderr: () => stderr.slice(-4000) };
};

const withTimeout = <A>(promise: Promise<A>, what: string, stderr: () => string): Promise<A> =>
  new Promise<A>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${what} timed out.\n${stderr()}`)),
      START_TIMEOUT_MS,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

const stop = async (child: ChildProcess, exited: Promise<unknown>) => {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await exited;
};

export default async function setup(project: TestProject) {
  const machine = makeMachine();
  const keys = writePassKeys(machine.root);
  let port: number | undefined;
  let announced = () => {};
  const started = new Promise<void>((resolve) => {
    announced = resolve;
  });
  const host = startNode(
    machine,
    REPLAY_ENTRY,
    [
      'simple',
      'full-access',
      'session',
      '--pass-public-key',
      keys.publicKeyFile,
      '--session-id',
      SESSION_ID,
      '--harness',
      'claude',
      '--port',
      '0',
    ],
    (line) => {
      const printed = JSON.parse(line) as { type?: string; port?: number };
      if (printed.type === 'ready') port = printed.port;
      if (port !== undefined) announced();
    },
  );
  const teardown = async () => {
    await stop(host.child, host.exited);
    const calls = readCalls(machine.record);
    rmSync(machine.root, { recursive: true, force: true });
    const escaped = calls.filter(
      (call) => call.home !== machine.home || call.claudeConfigDir !== '' || call.codexHome !== '',
    );
    if (escaped.length > 0) {
      throw new Error(`A CLI ran outside the tests' machine: ${JSON.stringify(escaped)}`);
    }
  };
  try {
    // Only for the fixture's message: each test signs its own (`render.tsx`).
    const pass = signPass(keys.privateKeyFile, SESSION_ID, PASS_LIFETIME_SECONDS);
    await withTimeout(
      Promise.race([
        started,
        host.exited.then((code) => {
          throw new Error(`The host exited (${code}) before it was ready.\n${host.stderr()}`);
        }),
      ]),
      'Starting the replay host',
      host.stderr,
    );
    const sender = startNode(machine, SEND_ENTRY, [String(port), pass, SESSION_ID], () => {});
    const code = await withTimeout(sender.exited, 'Sending the fixture message', sender.stderr);
    if (code !== 0) throw new Error(`Sending the fixture message failed.\n${sender.stderr()}`);
  } catch (error) {
    await teardown();
    throw error;
  }
  const session: ProvidedHost = {
    hostUrl: `http://127.0.0.1:${port}`,
    passKeyFile: keys.privateKeyFile,
    passLifetimeSeconds: PASS_LIFETIME_SECONDS,
    sessionId: SESSION_ID,
    assistantText: ASSISTANT_TEXT,
    threadTitle: THREAD_TITLE,
  };
  project.provide(HOST_SESSION_KEY as never, session as never);
  return teardown;
}
