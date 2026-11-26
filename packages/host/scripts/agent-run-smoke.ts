// @effect-diagnostics nodeBuiltinImport:off - A tool a person runs: it plays the cell on loopback.
// @effect-diagnostics globalDate:off - It stamps its lines and passes with the wall clock.
// @effect-diagnostics globalTimers:off - Plain Node, no Effect: its timers are Node's.
/**
 * Plays the cell for one agent run, against the real runner, from the repository's root:
 *
 *   node --env-file=packages/host/.env packages/host/scripts/agent-run-smoke.ts \
 *     --repository <owner/name> --agent-run <file.json> [--harness claude] [--timeout-minutes 45]
 *
 * It listens on a free loopback port as the cell's runner socket (`/api/runner`, the bearer
 * `CONSOLA_RUNNER_SECRET`), starts `consola-host runner` against it with this environment, and
 * once the runner says `hello` sends one `session.start` carrying the agent run read from the file
 * (`readAgentRun`), with a fresh session id and a fresh Ed25519 key, whose private half signs the
 * passes it prints. Each `session.update` is one line on stdout; once the session runs, a URL for
 * `@consola/agent-ui`'s dev page (`pnpm --filter @consola/agent-ui dev`, port 5176) to watch the
 * chat, again every four minutes (a pass lives five) and on SIGUSR1. On the run's `done` or
 * `failed`, the session's end, the timeout or Ctrl-C it sends `session.stop`, waits for the
 * session's end, stops the runner (SIGTERM) and exits: 0 for `done`, 1 otherwise. What it prints
 * is scrubbed of the runner's secrets (`RUNNER_SECRET_VARIABLES`); a pass is printed on purpose.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  HARNESSES,
  isRepository,
  PASS_MAX_LIFETIME_SECONDS,
  PASS_TYPE,
  passClaims,
  RUNNER_SOCKET_FRAME_LIMIT_BYTES,
  readAgentRun,
  readRunnerMessage,
} from '@consola/runner-protocol';
import type {
  AgentRun,
  AgentRunReport,
  Harness,
  SessionStart,
  SessionUpdate,
} from '@consola/runner-protocol';
import { SignJWT } from 'jose';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { scrubSecrets, secretValuesOf } from '../src/core/runnerDecisions.ts';

const PACKAGE = join(import.meta.dirname, '..');
const RUNNER_ID = 'agent-run-smoke';
const DEV_PAGE = 'http://localhost:5176/';
/** A fresh pass this often: a pass lives `PASS_MAX_LIFETIME_SECONDS` (five minutes). */
const PASS_EVERY_MS = 4 * 60 * 1000;
/** How long the session's end may take after `session.stop`, and the runner's after SIGTERM. */
const STOP_WAIT_MS = 60_000;
const RUNNER_EXIT_WAIT_MS = 20_000;

const USAGE = `node --env-file=packages/host/.env packages/host/scripts/agent-run-smoke.ts \\
  --repository <owner/name> --agent-run <file.json> [--harness claude] [--timeout-minutes 45]`;

const secrets = secretValuesOf(process.env);
const say = (text: string) => process.stdout.write(`${scrubSecrets(text, secrets)}\n`);
const note = (text: string) =>
  process.stderr.write(`agent-run-smoke: ${scrubSecrets(text, secrets)}\n`);
const refuse = (problem: string): never => {
  note(problem);
  process.stderr.write(`usage: ${USAGE}\n`);
  process.exit(2);
};
const time = () => new Date().toISOString().slice(11, 19);

const { values } = (() => {
  try {
    return parseArgs({
      args: process.argv.slice(2),
      strict: true,
      options: {
        repository: { type: 'string' },
        'agent-run': { type: 'string' },
        harness: { type: 'string', default: 'claude' },
        'timeout-minutes': { type: 'string', default: '45' },
        // Undocumented: another runner's entry, `src/testing/replayRunner.ts` to try this tool.
        runner: { type: 'string' },
      },
    });
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }
})();

const repository = isRepository(values.repository)
  ? values.repository
  : refuse('--repository must be owner/name.');
const harness: Harness =
  HARNESSES.find((each) => each === values.harness) ??
  refuse(`--harness must be one of ${HARNESSES.join(', ')}.`);
const timeoutMinutes = Number(values['timeout-minutes']);
if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
  refuse('--timeout-minutes must be a number of minutes above 0.');
}
const runFile = values['agent-run'] ?? refuse('--agent-run is required.');
const agentRun: AgentRun = (() => {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(runFile, 'utf8'));
  } catch (error) {
    return refuse(
      `${runFile} is not a JSON file: ${error instanceof Error ? error.message : error}`,
    );
  }
  const read = readAgentRun(json);
  return read.ok ? read.value : refuse(`${runFile} is not an agent run: ${read.reason}`);
})();
const secret = process.env.CONSOLA_RUNNER_SECRET ?? '';
if (secret === '') refuse('CONSOLA_RUNNER_SECRET is not set: the runner and this cell share it.');
const runnerEntry = resolve(values.runner ?? join(PACKAGE, 'src', 'main.ts'));

const sessionId = `agent-run-smoke-${randomUUID()}`;
const keys = generateKeyPairSync('ed25519');
const passPublicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();

/** A pass for the session, signed as the cell's `passSigner` signs one. */
const signPass = async (): Promise<string> => {
  const claims = passClaims({
    personId: 'agent-run-smoke',
    workspaceId: 'agent-run-smoke',
    sessionId,
    issuedAt: Math.floor(Date.now() / 1000),
    lifetimeSeconds: PASS_MAX_LIFETIME_SECONDS,
  });
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'EdDSA', typ: PASS_TYPE })
    .sign(keys.privateKey);
};

/** The session's host as the dev page dials it: its address, over ws: or wss:. */
const socketAddressOf = (hostUrl: string): string => hostUrl.replace(/^http/, 'ws');

let hostUrl: string | null = null;
const printWatchUrl = async () => {
  if (hostUrl === null) return;
  const query = new URLSearchParams({
    host: socketAddressOf(hostUrl),
    pass: await signPass(),
    session: sessionId,
  });
  say(`[${time()}] watch (pass for 5 minutes): ${DEV_PAGE}?${query}`);
};

const describeReport = (report: AgentRunReport): string => {
  const agents = (report.agents ?? []).map(
    (agent) =>
      `${agent.agent}(${agent.id}) ${agent.status}${agent.summary === undefined ? '' : `: ${oneLine(agent.summary, 120)}`}`,
  );
  return `agent run ${report.state}${agents.length === 0 ? '' : `; agents: ${agents.join(', ')}`}`;
};

const oneLine = (text: string, max: number): string => {
  const line = text.replaceAll(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
};

/** One readable line (or a few, for a run's last summary) per update. */
const printUpdate = (update: SessionUpdate) => {
  const parts: string[] = [];
  if (update.status !== undefined) parts.push(`status ${update.status}`);
  if (update.hostUrl !== undefined) parts.push(`at ${update.hostUrl}`);
  if (update.title !== undefined) parts.push(`title "${update.title}"`);
  if (update.error !== undefined) parts.push(`error: ${update.error}`);
  if (update.agentRun !== undefined) parts.push(describeReport(update.agentRun));
  say(`[${time()}] ${parts.join(' | ') || '(an empty update)'}`);
  const report = update.agentRun;
  if (report !== undefined && (report.state === 'done' || report.state === 'failed')) {
    say(`--- summary (${report.state}) ---`);
    say(report.summary ?? '(no summary)');
    for (const agent of report.agents ?? []) {
      if (agent.summary !== undefined) {
        say(`--- ${agent.agent} (${agent.id}, ${agent.status}) ---\n${agent.summary}`);
      }
    }
    say('---');
  }
};

// The cell: one runner, admitted with the shared secret, as the cell's runner socket admits one.
const bearer = Buffer.from(`Bearer ${secret}`);
const admits = (request: IncomingMessage): boolean => {
  const given = Buffer.from(request.headers.authorization ?? '');
  return (
    new URL(request.url ?? '/', 'http://cell').pathname === '/api/runner' &&
    given.length === bearer.length &&
    timingSafeEqual(given, bearer)
  );
};
const server = new WebSocketServer({
  host: '127.0.0.1',
  port: 0,
  maxPayload: RUNNER_SOCKET_FRAME_LIMIT_BYTES,
  verifyClient: ({ req }, done) => done(admits(req), 401),
});
await new Promise<void>((ready) => server.once('listening', () => ready()));
const address = server.address();
const port =
  address !== null && typeof address === 'object'
    ? address.port
    : refuse('The cell could not listen.');
const cellUrl = `ws://127.0.0.1:${port}/api/runner`;

let socket: WebSocket | null = null;
let started = false;
/** Set once the session's end is heard (`stopped` or `failed`, in an update or a `hello`). */
let ended: { status: string; error?: string } | null = null;
const endListeners: Array<() => void> = [];
const heardEnd = (end: { status: string; error?: string }) => {
  if (ended !== null) return;
  ended = end;
  for (const listener of endListeners.splice(0)) listener();
};
let finishing = false;

const send = (message: SessionStart | { type: 'session.stop'; sessionId: string }) => {
  if (socket === null || socket.readyState !== socket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
};

server.on('connection', (connection) => {
  socket = connection;
  note('the runner connected');
  connection.on('message', (data) => {
    let json: unknown;
    try {
      json = JSON.parse(data.toString());
    } catch {
      return note('refused a message from the runner: it is not JSON');
    }
    const read = readRunnerMessage(json);
    if (!read.ok) return note(`refused a message from the runner: ${read.reason}`);
    const message = read.value;
    if (message.type === 'hello') {
      const end = message.endedSessions.find((each) => each.sessionId === sessionId);
      if (end !== undefined) {
        printUpdate({ type: 'session.update', ...end });
        heardEnd(end);
        void finish(end.status === 'stopped' ? 'the session stopped' : 'the session failed', 1);
        return;
      }
      if (started || finishing) return;
      started = true;
      note(`starting session ${sessionId} (${harness}, ${repository}, agent ${agentRun.agent})`);
      send({
        type: 'session.start',
        sessionId,
        workspaceId: 'agent-run-smoke',
        repository,
        harness,
        passPublicKeyPem,
        agentRun,
      });
      return;
    }
    if (message.sessionId !== sessionId) return;
    printUpdate(message);
    if (message.status === 'running' && message.hostUrl !== undefined) {
      const first = hostUrl === null;
      hostUrl = message.hostUrl;
      if (first) void printWatchUrl();
    }
    if (message.status === 'stopped' || message.status === 'failed') {
      heardEnd(
        message.error === undefined
          ? { status: message.status }
          : { status: message.status, error: message.error },
      );
      void finish(`the session ${message.status}`, 1);
      return;
    }
    const state = message.agentRun?.state;
    if (state === 'done') void finish('the agent run is done', 0);
    if (state === 'failed') void finish('the agent run failed', 1);
  });
  connection.on('close', () => {
    if (socket === connection) socket = null;
  });
});

note(`listening as the cell at ${cellUrl}; starting the runner (${runnerEntry})`);
const runner: ChildProcess = spawn(
  process.execPath,
  [
    runnerEntry,
    'runner',
    '--cell-url',
    cellUrl,
    '--runner-id',
    RUNNER_ID,
    // A backstop: the sandbox's own cap, a few minutes past this tool's timeout.
    '--max-session-minutes',
    String(Math.ceil(timeoutMinutes) + 5),
  ],
  { env: process.env, stdio: ['ignore', 'inherit', 'inherit'] },
);
let runnerExited = false;
const runnerExit = new Promise<number | null>((exited) =>
  runner.once('exit', (code) => {
    runnerExited = true;
    exited(code);
    if (!finishing) void finish(`the runner exited (${code ?? 'signal'})`, 1);
  }),
);

const within = <A>(promise: Promise<A>, ms: number): Promise<A | 'late'> =>
  Promise.race([promise, new Promise<'late'>((late) => setTimeout(() => late('late'), ms))]);

/** Stops the session (unless it ended), then the runner, then exits with `code`. */
async function finish(why: string, code: number): Promise<void> {
  if (finishing) return;
  finishing = true;
  note(`${why}; stopping`);
  if (started && ended === null && send({ type: 'session.stop', sessionId })) {
    const heard = await within(new Promise<void>((done) => endListeners.push(done)), STOP_WAIT_MS);
    if (heard === 'late') note(`the session did not end within ${STOP_WAIT_MS / 1000} s`);
  }
  if (!runnerExited) {
    runner.kill('SIGTERM');
    if ((await within(runnerExit, RUNNER_EXIT_WAIT_MS)) === 'late') {
      note('the runner did not stop in time; killing it');
      runner.kill('SIGKILL');
      await runnerExit;
    }
  }
  server.close();
  process.exit(code);
}

const passTimer = setInterval(() => void printWatchUrl(), PASS_EVERY_MS);
passTimer.unref();
setTimeout(
  () => void finish(`no end within ${timeoutMinutes} minutes`, 1),
  timeoutMinutes * 60 * 1000,
).unref();
process.on('SIGUSR1', () => void printWatchUrl());
process.on('SIGINT', () => void finish('interrupted', 1));
process.on('SIGTERM', () => void finish('terminated', 1));
