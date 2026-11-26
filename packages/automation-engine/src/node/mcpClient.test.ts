import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServerLaunch, McpSession, ServerGroup } from '../ports';
import { maskFormsOf } from '../secrets/values';
import { SERVER_LOG_CAP_BYTES, nodeMcpClient } from './mcpClient';
import type { NodeMcpClientOptions } from './mcpClient';
import {
  alive,
  eventsIn,
  lstartOf,
  namesTheRuntimeAdds,
  startHttpServer,
  waitFor,
  writePs,
  writeScratchServer,
  writeSdkServer,
} from './mcpClient.test-helpers';
import type {
  HttpRequestEvent,
  HttpServerOptions,
  ScratchBehaviour,
  StartedHttpServer,
} from './mcpClient.test-helpers';

/*
 * The stdio adapter against scratch servers (rule 5a-servers): every server
 * is a file this test wrote into its own temp folder, started with
 * `process.execPath`; nothing here starts anything else or reaches a network.
 */

const SECRET = String.raw`stub-slack-secret-9c1e"\back%slash`;
const SLOW = 20_000;
// Every row starts processes: on a loaded machine the default 5 s is too short a budget for any of them.
vi.setConfig({ testTimeout: SLOW });

let temp: string;
let logPath: string;
/** Processes a row started itself, ended after it whatever happened. */
const strays: number[] = [];
const sessions: McpSession[] = [];

beforeEach(() => {
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-mcp-client-')));
  fs.mkdirSync(path.join(temp, 'bin'));
  logPath = path.join(temp, 'server-events.log');
});

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  fs.rmSync(temp, { recursive: true, force: true });
});

function baseEnv(): NodeJS.ProcessEnv {
  return {
    HOME: temp,
    PATH: `${temp}/bin:/usr/bin:/bin`,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C',
    TMPDIR: temp,
    PARENT_ONLY: 'x',
    GH_TOKEN: 'fake-parent-gh-token',
  };
}

function client(options: Partial<NodeMcpClientOptions> = {}) {
  return nodeMcpClient({
    baseEnv: async () => baseEnv(),
    workRoot: path.join(temp, 'work'),
    ...options,
  });
}

type StdioLaunch = Extract<McpServerLaunch, { transport: 'stdio' }>;

function launchOf(
  behaviour: ScratchBehaviour = 'plain',
  over: Partial<StdioLaunch> = {},
): StdioLaunch {
  return {
    transport: 'stdio',
    name: 'slack',
    masks: [],
    timeoutMs: 10_000,
    signal: new AbortController().signal,
    command: process.execPath,
    args: [writeScratchServer(temp, behaviour), logPath],
    env: { SLACK_TEAM_ID: 'T0SPROCKET', SLACK_BOT_TOKEN: SECRET },
    ...over,
  };
}

/** Connects and keeps the session for the after-hook; fails the row when the connect is refused. */
async function connected(
  launch: McpServerLaunch,
  options: Partial<NodeMcpClientOptions> = {},
): Promise<McpSession> {
  const result = await client(options).connect(launch);
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  sessions.push(result.session);
  return result.session;
}

/** The group a launch recorded, from its `onSpawned`. */
function recording(launch: StdioLaunch): { launch: StdioLaunch; groups: ServerGroup[] } {
  const groups: ServerGroup[] = [];
  return { launch: { ...launch, onSpawned: (group) => void groups.push(group) }, groups };
}

const events = () => eventsIn(logPath);
const count = (name: string, tool?: string) =>
  events().filter((event) => event.event === name && (tool === undefined || event.tool === tool))
    .length;
const call = (session: McpSession, tool: string, timeoutMs = 10_000, signal?: AbortSignal) =>
  session.call(tool, {}, { timeoutMs, signal: signal ?? new AbortController().signal });

describe('the environment and the folder (V7, E8)', () => {
  it('gives the server only the allow-list names its runner has, its env: and its secrets, in an empty folder of its own', async () => {
    const session = await connected(launchOf());
    const outcome = await call(session, 'env_names');
    expect(outcome.kind).toBe('answered');
    if (outcome.kind !== 'answered') return;
    const answer = outcome.structuredContent as { names: string[]; cwd: string; entries: string[] };
    expect(answer.names).toEqual(
      [
        'HOME',
        'LANG',
        'LC_ALL',
        'PATH',
        'SLACK_BOT_TOKEN',
        'SLACK_TEAM_ID',
        'TMPDIR',
        ...namesTheRuntimeAdds(),
      ].sort(),
    );
    expect(answer.names).not.toContain('PARENT_ONLY');
    expect(answer.names).not.toContain('GH_TOKEN');
    const cwd = fs.realpathSync(answer.cwd);
    expect(path.dirname(cwd)).toBe(path.join(temp, 'work'));
    expect(path.basename(cwd)).toMatch(/^call-/);
    expect(answer.entries).toEqual([]);
    await session.close();
    expect(fs.existsSync(cwd)).toBe(false);
  });

  it('finds a bare command on the PATH it gives the server (Call 25)', async () => {
    const file = writeScratchServer(temp);
    const wrapper = path.join(temp, 'bin', 'scratch-server');
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${file}' "$@"\n`);
    fs.chmodSync(wrapper, 0o755);
    const session = await connected(
      launchOf('plain', { command: 'scratch-server', args: [logPath] }),
    );
    expect((await call(session, 'post')).kind).toBe('answered');
  });

  it('empties the call folders an earlier client left when it is made, and nothing else', () => {
    const work = path.join(temp, 'work');
    fs.mkdirSync(path.join(work, 'call-left'), { recursive: true });
    fs.writeFileSync(path.join(work, 'call-left', 'x'), 'x');
    fs.writeFileSync(path.join(work, 'keep.txt'), 'kept');
    client();
    expect(fs.readdirSync(work)).toEqual(['keep.txt']);
  });
});

describe('the group is recorded as soon as it is spawned (m8)', () => {
  it('waits for onSpawned before initialize, with the start time ps prints', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const groups: ServerGroup[] = [];
    const pending = client().connect(
      launchOf('plain', {
        onSpawned: async (group) => {
          groups.push(group);
          await gate;
        },
      }),
    );
    await waitFor(() => groups.length === 1, 10_000, 'onSpawned');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(count('initialize')).toBe(0);
    expect(groups[0].startedAt).not.toBe('');
    expect(groups[0].startedAt).toBe(lstartOf(groups[0].pgid));
    release();
    const result = await pending;
    expect(result.ok).toBe(true);
    if (result.ok) sessions.push(result.session);
    expect(count('initialize')).toBe(1);
  });

  it.each([
    [
      'rejects',
      async () => {
        throw new Error('disk full');
      },
    ],
    [
      'throws',
      () => {
        throw new Error('disk full');
      },
    ],
  ])('ends the server and refuses the connect when onSpawned %s', async (_how, onSpawned) => {
    const groups: ServerGroup[] = [];
    const result = await client().connect(
      launchOf('plain', {
        onSpawned: (group) => {
          groups.push(group);
          return onSpawned();
        },
      }),
    );
    expect(result).toEqual({ ok: false, reason: 'disk full' });
    expect(groups).toHaveLength(1);
    expect(alive(groups[0].pgid)).toBe(false);
    expect(count('initialize')).toBe(0);
  });
});

describe('a connect stopped before its server is up', () => {
  it('reads nothing and starts nothing when it is stopped already', async () => {
    const read = vi.fn(async () => baseEnv());
    const kill = vi.fn((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
    const controller = new AbortController();
    controller.abort('stop');
    const { launch, groups } = recording(launchOf('plain', { signal: controller.signal }));
    expect(await client({ baseEnv: read, kill }).connect(launch)).toEqual({
      ok: false,
      reason: 'it was stopped',
    });
    expect(read).not.toHaveBeenCalled();
    expect(groups).toEqual([]);
    expect(kill).not.toHaveBeenCalled();
  });

  it('starts nothing when it is stopped while its environment is read', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reading = false;
    const kill = vi.fn((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
    const controller = new AbortController();
    const { launch, groups } = recording(launchOf('plain', { signal: controller.signal }));
    const pending = client({
      kill,
      baseEnv: async () => {
        reading = true;
        await gate;
        return baseEnv();
      },
    }).connect(launch);
    await waitFor(() => reading, 5000, 'the environment to be read');
    controller.abort('stop');
    release();
    expect(await pending).toEqual({ ok: false, reason: 'it was stopped' });
    expect(groups).toEqual([]);
    expect(kill).not.toHaveBeenCalled();
    expect(fs.readdirSync(path.join(temp, 'work'))).toEqual([]);
  });

  it(
    'reports no group, and ends the server, when it is stopped while its start time is read',
    async () => {
      const kill = vi.fn((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
      const controller = new AbortController();
      const { launch, groups } = recording(launchOf('plain', { signal: controller.signal }));
      const pending = client({ kill, ps: writePs(temp, { delaySeconds: 1 }) }).connect(launch);
      const work = path.join(temp, 'work');
      await waitFor(
        () => fs.existsSync(work) && fs.readdirSync(work).length === 1,
        5000,
        'the call folder',
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      controller.abort('stop');
      expect(await pending).toEqual({ ok: false, reason: 'it was stopped' });
      expect(groups).toEqual([]);
      expect(kill).toHaveBeenCalledWith(expect.any(Number), 'SIGTERM');
      expect(kill.mock.calls[0][0]).toBeLessThan(0);
      expect(count('initialize')).toBe(0);
    },
    SLOW,
  );
});

describe('the tool list', () => {
  it("follows the list's pages", async () => {
    const session = await connected(launchOf('paged'));
    expect(session.tools).toHaveLength(14);
    expect(session.tools.at(-1)?.name).toBe('bad_result');
    expect(count('list')).toBe(2);
  });

  it('reads at most ten pages', async () => {
    const session = await connected(launchOf('endless_pages'));
    expect(session.tools.map((tool) => tool.name)).toEqual(
      Array.from({ length: 10 }, (_, i) => `tool_${i + 1}`),
    );
    expect(count('list')).toBe(10);
  });
});

describe('calls', () => {
  it('lists every tool with its schemas, and answers one call once (E1, E2)', async () => {
    const session = await connected(launchOf());
    expect(session.tools.map((tool) => tool.name)).toEqual([
      'env_names',
      'post',
      'slow_post',
      'post_then_fail',
      'huge',
      'bad_output',
      'ask_client',
      'echo_stderr',
      'flood_stderr',
      'rpc_error',
      'progress_slow',
      'broken_schema',
      'broken_input',
      'bad_result',
    ]);
    expect(count('list')).toBe(1);
    const post = session.tools.find((tool) => tool.name === 'post');
    expect(post?.inputSchema).toMatchObject({ required: ['channel', 'text'] });
    expect(post?.outputSchema).toMatchObject({ properties: { ts: { type: 'string' } } });
    const outcome = await session.call(
      'post',
      { channel: 'C1', text: 'hi' },
      {
        timeoutMs: 10_000,
        signal: new AbortController().signal,
      },
    );
    expect(outcome).toMatchObject({
      kind: 'answered',
      isError: false,
      structuredContent: { ok: true, ts: '1700000000.000100' },
    });
    if (outcome.kind === 'answered') expect(outcome.bytes).toBeGreaterThan(0);
    expect(count('call', 'post')).toBe(1);
  });

  it('answers a result whose structured content breaks the tool output schema, as it is (Call 7)', async () => {
    const session = await connected(launchOf());
    expect(await call(session, 'bad_output')).toMatchObject({
      kind: 'answered',
      isError: false,
      structuredContent: { count: 'x' },
    });
  });

  it("reads the SDK server's thrown and schema-breaking tools as error results, after their work (E14, V17)", async () => {
    const session = await connected(launchOf('plain', { args: [writeSdkServer(temp), logPath] }));
    expect(await call(session, 'throws')).toMatchObject({ kind: 'answered', isError: true });
    expect(await call(session, 'breaks_own_schema')).toMatchObject({
      kind: 'answered',
      isError: true,
    });
    expect(count('work-done')).toBe(2);
  });

  it('reads a JSON-RPC error answer as an error result with its message, never as closed (review S2)', async () => {
    const session = await connected(launchOf());
    const outcome = await call(session, 'rpc_error');
    expect(outcome).toMatchObject({
      kind: 'answered',
      isError: true,
      content: [{ type: 'text', text: 'internal error after post' }],
    });
    if (outcome.kind === 'answered') expect(outcome.content).toHaveLength(1);
    expect(count('work-done')).toBe(1);
  });

  it("reads a result the SDK's own result schema refuses as unreadable, never as closed", async () => {
    const session = await connected(launchOf());
    const outcome = await call(session, 'bad_result');
    expect(outcome).toMatchObject({ kind: 'unanswered', why: 'unreadable' });
    expect(count('call', 'bad_result')).toBe(1);
  });

  it('connects though one listed output schema cannot be compiled (review S12)', async () => {
    const session = await connected(launchOf());
    expect(session.tools.map((tool) => tool.name)).toContain('broken_schema');
    expect((await call(session, 'post')).kind).toBe('answered');
  });

  it(
    'answers a timeout that may have landed (E5, V4)',
    async () => {
      const session = await connected(launchOf());
      expect(await call(session, 'slow_post', 300)).toMatchObject({
        kind: 'unanswered',
        why: 'timeout',
      });
      await waitFor(() => count('work-done') === 1, 5000, 'the work');
      expect(events().at(-1)?.event).toBe('work-done');
    },
    SLOW,
  );

  it(
    'lets no progress extend the timeout (E6b, review Minor 11)',
    async () => {
      const session = await connected(launchOf());
      const started = Date.now();
      expect(await call(session, 'progress_slow', 300)).toMatchObject({
        kind: 'unanswered',
        why: 'timeout',
      });
      expect(Date.now() - started).toBeLessThan(1000);
      await waitFor(() => count('progress') >= 4, 5000, 'progress after the timeout');
    },
    SLOW,
  );

  it(
    'cancels a stopped call and answers stopped, not a timeout, then ends the server (E6, V5, review Minor 2)',
    async () => {
      const { launch, groups } = recording(launchOf());
      const session = await connected(launch);
      const controller = new AbortController();
      setTimeout(() => controller.abort('stop'), 100);
      expect(await call(session, 'slow_post', 10_000, controller.signal)).toMatchObject({
        kind: 'unanswered',
        why: 'stopped',
      });
      await waitFor(() => count('cancelled') === 1, 5000, 'the cancellation');
      // Ended by the stop itself, as `close` ends it: nothing here calls close.
      await waitFor(() => !alive(groups[0].pgid), 10_000, 'the server to be ended');
    },
    SLOW,
  );

  it('sends nothing on a session that is being closed', async () => {
    const session = await connected(launchOf());
    const closing = session.close();
    expect(await call(session, 'post')).toMatchObject({ kind: 'unanswered', why: 'closed' });
    await closing;
    expect(count('call')).toBe(0);
  });

  it(
    'never sends a call again after the server dies in it (E7, V6)',
    async () => {
      const session = await connected(launchOf('die_in_call'));
      expect(await call(session, 'post')).toMatchObject({ kind: 'unanswered', why: 'closed' });
      expect(count('call', 'post')).toBe(1);
      expect(count('work-done')).toBe(1);
    },
    SLOW,
  );

  it(
    'fails a call whose answer is over 8 MB (V11)',
    async () => {
      const session = await connected(launchOf());
      expect(await call(session, 'huge')).toMatchObject({ kind: 'unanswered', why: 'too-large' });
    },
    SLOW,
  );

  it('declares no capabilities at initialize: `{}` (review M2)', async () => {
    await connected(launchOf());
    const initialize = events().filter((event) => event.event === 'initialize');
    expect(initialize).toHaveLength(1);
    expect(initialize[0].capabilities).toEqual({});
  });

  it('declares no capabilities, so a server asking for sampling, elicitation or roots is refused (V20, review M1)', async () => {
    const session = await connected(launchOf());
    expect((await call(session, 'ask_client')).kind).toBe('answered');
    expect(
      events()
        .filter((event) => event.event === 'asked')
        .map((event) => [event.method, event.code]),
    ).toEqual([
      ['sampling/createMessage', -32_601],
      ['elicitation/create', -32_601],
      ['roots/list', -32_601],
    ]);
  });
});

describe('a quit signals at once (review S5)', () => {
  it('sends the group SIGTERM before abort() returns, on the call signal', async () => {
    const kill = vi.fn((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
    const { launch, groups } = recording(launchOf());
    const session = await connected(launch, { kill });
    const controller = new AbortController();
    const pending = call(session, 'slow_post', 10_000, controller.signal);
    await waitFor(() => count('start') === 1, 5000, 'the call');
    controller.abort('quit');
    expect(kill).toHaveBeenCalledWith(-groups[0].pgid, 'SIGTERM');
    expect((await pending).kind).toBe('unanswered');
  });

  it("sends it before abort() returns on the connect's signal too, while onSpawned holds", async () => {
    const kill = vi.fn((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = new AbortController();
    const groups: ServerGroup[] = [];
    const pending = client({ kill }).connect(
      launchOf('plain', {
        signal: controller.signal,
        onSpawned: async (group) => {
          groups.push(group);
          await gate;
        },
      }),
    );
    await waitFor(() => groups.length === 1, 10_000, 'onSpawned');
    controller.abort('quit');
    expect(kill).toHaveBeenCalledWith(-groups[0].pgid, 'SIGTERM');
    release();
    expect((await pending).ok).toBe(false);
  });

  it('a stop has not signalled by the time abort() returns', async () => {
    const kill = vi.fn((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
    const session = await connected(launchOf(), { kill });
    const controller = new AbortController();
    const pending = call(session, 'slow_post', 10_000, controller.signal);
    await waitFor(() => count('start') === 1, 5000, 'the call');
    controller.abort('stop');
    expect(kill).not.toHaveBeenCalled();
    expect(await pending).toMatchObject({ kind: 'unanswered', why: 'stopped' });
  });
});

describe('ending a server ends what it started', () => {
  const childOf = () => events().find((event) => event.event === 'child')?.pid as number;

  it(
    'ends a grandchild in its group (E13 reversed, V9)',
    async () => {
      const session = await connected(launchOf('grandchild'));
      await waitFor(() => childOf() !== undefined, 5000, 'the grandchild');
      const child = childOf();
      strays.push(child);
      expect(alive(child)).toBe(true);
      expect(await session.close()).toEqual({ survivors: 0 });
      await waitFor(() => !alive(child), 2000, 'the grandchild to go');
    },
    SLOW,
  );

  it(
    'ends a child that left the group, through the parent-id walk (V18, review S6)',
    async () => {
      const session = await connected(launchOf('setsid_child'));
      await waitFor(() => childOf() !== undefined, 5000, 'the child');
      const child = childOf();
      strays.push(child);
      expect(await session.close()).toEqual({ survivors: 0 });
      await waitFor(() => !alive(child), 2000, 'the setsid child to go');
    },
    SLOW,
  );

  it(
    'kills a server that ignores SIGTERM once the grace is over',
    async () => {
      const { launch, groups } = recording(launchOf('ignore_term'));
      const session = await connected(launch, { killGraceMs: 200 });
      expect(await session.close()).toEqual({ survivors: 0 });
      expect(alive(groups[0].pgid)).toBe(false);
      expect(count('term')).toBe(1);
    },
    SLOW,
  );
});

describe('a server that never gets going (Review Focus 2)', () => {
  it('says a command is not on PATH', async () => {
    expect(
      await client().connect(launchOf('plain', { command: 'no-such-server', args: [] })),
    ).toEqual({ ok: false, reason: 'spawn no-such-server ENOENT' });
  });

  it('says a server exited, with its last stderr line', async () => {
    expect(await client().connect(launchOf('exit_at_once'))).toEqual({
      ok: false,
      reason: 'it exited (code 1) before answering: bad config',
    });
  });

  it('says a server printed something that is not JSON-RPC', async () => {
    const { launch, groups } = recording(launchOf('banner'));
    expect(await client().connect(launch)).toEqual({
      ok: false,
      reason: 'it printed something that is not JSON-RPC on stdout: Starting slack server…',
    });
    expect(alive(groups[0].pgid)).toBe(false);
  });

  it(
    'says a server sent a message over 8 MB, and ends it',
    async () => {
      const { launch, groups } = recording(launchOf('flood_stdout'));
      expect(await client().connect(launch)).toEqual({
        ok: false,
        reason: 'it sent a message over 8 MB',
      });
      expect(alive(groups[0].pgid)).toBe(false);
    },
    SLOW,
  );

  it('masks what it quotes of a line that is not JSON-RPC', async () => {
    expect(
      await client().connect(launchOf('secret_banner', { masks: maskFormsOf(SECRET) })),
    ).toEqual({
      ok: false,
      reason: 'it printed something that is not JSON-RPC on stdout: token=***',
    });
  });

  it('sends nothing once recording the group has spent the budget', async () => {
    const result = await client().connect(
      launchOf('plain', {
        timeoutMs: 300,
        onSpawned: () => new Promise((resolve) => setTimeout(resolve, 500)),
      }),
    );
    expect(result).toEqual({ ok: false, reason: 'it did not answer within 300ms' });
    expect(count('initialize')).toBe(0);
  });

  it("says a server answered initialize with an error, in the server's own words, though its code is the timeout's", async () => {
    expect(await client().connect(launchOf('init_error'))).toEqual({
      ok: false,
      reason: 'it answered with an error: warming up',
    });
  });

  it(
    'says a server did not answer within its budget, and ends it',
    async () => {
      const { launch, groups } = recording(launchOf('hang', { timeoutMs: 500 }));
      const started = Date.now();
      expect(await client().connect(launch)).toEqual({
        ok: false,
        reason: 'it did not answer within 500ms',
      });
      expect(Date.now() - started).toBeLessThan(2000);
      expect(alive(groups[0].pgid)).toBe(false);
    },
    SLOW,
  );
});

describe("the server's stderr (Review Focus 1)", () => {
  it('masks a secret in server.log though it arrived in 3-byte pieces', async () => {
    const serverLog = path.join(temp, 'attempt', 'server.log');
    const session = await connected(
      launchOf('plain', { masks: maskFormsOf(SECRET), logPath: serverLog }),
    );
    expect((await call(session, 'echo_stderr')).kind).toBe('answered');
    await session.close();
    const written = fs.readFileSync(serverLog, 'utf8');
    expect(written).toContain('***');
    for (const form of maskFormsOf(SECRET)) expect(written).not.toContain(form);
    expect(written).not.toContain('stub-slack');
  });

  it(
    'stops server.log at 1 MB, with a last line of …',
    async () => {
      const serverLog = path.join(temp, 'attempt', 'server.log');
      const session = await connected(launchOf('plain', { logPath: serverLog }));
      expect((await call(session, 'flood_stderr')).kind).toBe('answered');
      await waitFor(
        () => fs.existsSync(serverLog) && fs.readFileSync(serverLog, 'utf8').endsWith('\n…\n'),
        10_000,
        'the cap',
      );
      await session.close();
      const written = fs.readFileSync(serverLog, 'utf8');
      expect(Buffer.byteLength(written)).toBe(SERVER_LOG_CAP_BYTES + Buffer.byteLength('\n…\n'));
      expect(
        written
          .split('\n')
          .filter((line) => line !== '')
          .at(-1),
      ).toBe('…');
    },
    SLOW,
  );
});

describe('servers an earlier start left running (Review Focus 4)', () => {
  /** A scratch server this test starts and leaves running, as a quit would. */
  function leftRunning(behaviour: ScratchBehaviour = 'plain') {
    const child = spawn(process.execPath, [writeScratchServer(temp, behaviour), logPath], {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    strays.push(child.pid as number);
    return child;
  }

  it('ends a recorded group that is still that process', async () => {
    const child = leftRunning();
    const pid = child.pid as number;
    await waitFor(() => lstartOf(pid) !== '', 5000, 'the server');
    expect(await client().endOrphan({ pgid: pid, startedAt: lstartOf(pid) })).toBe('ended');
    await waitFor(() => !alive(pid), 2000, 'the orphan to go');
  });

  it('never signals a group whose start time differs (a reused id)', async () => {
    const pid = leftRunning().pid as number;
    await waitFor(() => lstartOf(pid) !== '', 5000, 'the server');
    // The same text with its seconds moved by one: another process's start.
    const other = lstartOf(pid).replace(
      /(\d\d):(\d\d):(\d\d)/,
      (_whole, h, m, s) => `${h}:${m}:${String((Number(s) + 1) % 60).padStart(2, '0')}`,
    );
    expect(other).not.toBe(lstartOf(pid));
    expect(await client().endOrphan({ pgid: pid, startedAt: other })).toBe('gone');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(alive(pid)).toBe(true);
  });

  it('never signals a group recorded without a start time', async () => {
    const pid = leftRunning().pid as number;
    expect(await client().endOrphan({ pgid: pid, startedAt: '' })).toBe('unknown');
    expect(alive(pid)).toBe(true);
  });

  it('answers unknown, signalling nothing, when ps cannot tell', async () => {
    const pid = leftRunning().pid as number;
    await waitFor(() => lstartOf(pid) !== '', 5000, 'the server');
    const startedAt = lstartOf(pid);
    const kill = vi.fn();
    const noPs = client({ kill, ps: path.join(temp, 'no-such-ps') });
    expect(await noPs.endOrphan({ pgid: pid, startedAt })).toBe('unknown');
    const child = spawn('/usr/bin/true', [], { stdio: 'ignore' });
    const gone = child.pid as number;
    await new Promise((resolve) => child.once('exit', resolve));
    await waitFor(() => !alive(gone), 2000, 'the process to be reaped');
    const noTable = client({ kill, ps: writePs(temp, { failTable: true }) });
    expect(await noTable.endOrphan({ pgid: gone, startedAt })).toBe('unknown');
    expect(kill).not.toHaveBeenCalled();
    expect(alive(pid)).toBe(true);
  });

  it('answers gone for a group no process has', async () => {
    const child = spawn('/usr/bin/true', [], { stdio: 'ignore' });
    const pid = child.pid as number;
    await new Promise((resolve) => child.once('exit', resolve));
    await waitFor(() => !alive(pid), 2000, 'the process to be reaped');
    expect(await client().endOrphan({ pgid: pid, startedAt: 'Mon Jan  1 00:00:00 2024' })).toBe(
      'gone',
    );
  });

  it(
    'ends a group whose leader exited while a member runs on (review Minor 12)',
    async () => {
      const child = leftRunning('leader_exits');
      const pid = child.pid as number;
      await waitFor(() => events().some((event) => event.event === 'child'), 5000, 'the member');
      const startedAt = lstartOf(pid);
      const member = events().find((event) => event.event === 'child')?.pid as number;
      strays.push(member);
      child.stdin?.end();
      await new Promise((resolve) => child.once('exit', resolve));
      await waitFor(() => !alive(pid), 2000, 'the leader to be reaped');
      expect(alive(member)).toBe(true);
      expect(await client().endOrphan({ pgid: pid, startedAt })).toBe('ended');
      await waitFor(() => !alive(member), 2000, 'the member to go');
    },
    SLOW,
  );
});

describe('what the port offers (review S11)', () => {
  it('offers stdio and Streamable HTTP, but only HTTP on Windows, where it starts nothing', async () => {
    expect(client({ platform: 'darwin' }).transports).toEqual(['stdio', 'http']);
    const windows = client({ platform: 'win32' });
    expect(windows.transports).toEqual(['http']);
    const groups: ServerGroup[] = [];
    expect(
      await windows.connect(launchOf('plain', { onSpawned: (group) => void groups.push(group) })),
    ).toEqual({ ok: false, reason: 'this runner cannot start stdio servers' });
    expect(groups).toEqual([]);
    expect(count('initialize')).toBe(0);
  });
});

describe('checkArguments', () => {
  it("checks arguments against the tool's input schema, and with partial leaves out what is not given", async () => {
    const session = await connected(launchOf());
    const post = session.tools.find((tool) => tool.name === 'post');
    if (!post) throw new Error('no post');
    expect(session.checkArguments(post, { channel: 1 })).toMatch(/channel/);
    expect(session.checkArguments(post, { channel: 'C' }, { partial: true })).toBeNull();
    expect(session.checkArguments(post, { channel: 'C' })).toMatch(/text/);
    expect(session.checkArguments(post, { channel: 'C', text: 'hi' })).toBeNull();
    expect(session.checkArguments({ name: 'bare' }, { anything: 1 })).toBeNull();
    const broken = session.tools.find((tool) => tool.name === 'broken_input');
    if (!broken) throw new Error('no broken_input');
    expect(session.checkArguments(broken, {})).toMatch(
      /^its input schema could not be read \(.+\)$/,
    );
  });
});

/*
 * Streamable HTTP (Task 12). Every URL this file names is `http://127.0.0.1:<port>`
 * of a server a row started itself (rule 5a-servers); the last row checks it.
 */
describe('Streamable HTTP', () => {
  type HttpLaunch = Extract<McpServerLaunch, { transport: 'http' }>;
  const servers: StartedHttpServer[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
  });
  async function started(options: HttpServerOptions = {}): Promise<StartedHttpServer> {
    const server = await startHttpServer(options);
    servers.push(server);
    return server;
  }
  function httpLaunch(url: string, over: Partial<HttpLaunch> = {}): HttpLaunch {
    return {
      transport: 'http',
      name: 'tracker',
      masks: [],
      timeoutMs: 10_000,
      signal: new AbortController().signal,
      url,
      headers: {},
      ...over,
    };
  }
  const requests = (server: StartedHttpServer) =>
    server.events.filter((event): event is HttpRequestEvent => event.event === 'request');
  const worked = (server: StartedHttpServer) =>
    server.events.filter((event) => event.event === 'work-done').length;
  const rpcs = (server: StartedHttpServer, method: string) =>
    requests(server).filter((request) => request.rpc === method).length;
  const redirectTo = (origin: string) =>
    `The server answered with a redirect to \`${origin}\`; Consola does not follow redirects. Point \`url\` at the final address.`;

  /** What Node's `fetch` adds to every request by itself, each with its fixed value: nothing of the machine's. */
  const FETCH_OWN: Record<string, string> = {
    'accept-encoding': 'gzip, deflate',
    'accept-language': '*',
    'sec-fetch-mode': 'cors',
    'user-agent': 'node',
  };
  const PROTOCOL_OWN = [
    'accept',
    'connection',
    'content-length',
    'content-type',
    'host',
    'mcp-protocol-version',
    'mcp-session-id',
    'user-agent',
  ];

  it('declares no capabilities at initialize: `{}` (review M2)', async () => {
    const server = await started();
    await connected(httpLaunch(server.url));
    const initialize = requests(server).filter((request) => request.rpc === 'initialize');
    expect(initialize).toHaveLength(1);
    expect(initialize[0].capabilities).toEqual({});
  });

  it("sends its headers on every request, and no other header but the protocol's and fetch's own (V8, E9)", async () => {
    const server = await started();
    const session = await connected(
      httpLaunch(server.url, { headers: { Authorization: 'Bearer stub-tracker-secret-4d2a' } }),
    );
    expect(
      await session.call(
        'post',
        { channel: 'C1' },
        { timeoutMs: 10_000, signal: new AbortController().signal },
      ),
    ).toMatchObject({ kind: 'answered', isError: false, structuredContent: { ok: true } });
    const seen = requests(server);
    expect(seen.map((request) => request.rpc ?? request.method)).toEqual(
      expect.arrayContaining([
        'initialize',
        'notifications/initialized',
        'tools/list',
        'tools/call',
      ]),
    );
    for (const request of seen) {
      expect(request.values.authorization).toBe('present');
      for (const name of request.headers) {
        expect([...PROTOCOL_OWN, ...Object.keys(FETCH_OWN), 'authorization']).toContain(name);
      }
      for (const [name, value] of Object.entries(FETCH_OWN)) {
        if (request.headers.includes(name)) expect(request.values[name]).toBe(value);
      }
    }
  });

  it.each([
    ['before its answer began', true as const],
    [
      'in the middle of its event stream, at once rather than at its timeout',
      'mid-stream' as const,
    ],
  ])(
    'never sends a call again when the connection drops after its work, %s (E9b, V6)',
    async (_when, dropAfterWork) => {
      const server = await started({ dropAfterWork });
      const asked = Date.now();
      const session = await connected(httpLaunch(server.url));
      expect(
        await session.call(
          'post',
          { channel: 'C1' },
          { timeoutMs: 10_000, signal: new AbortController().signal },
        ),
      ).toMatchObject({ kind: 'unanswered', why: 'closed' });
      expect(Date.now() - asked).toBeLessThan(9000);
      expect(rpcs(server, 'tools/call')).toBe(1);
      expect(worked(server)).toBe(1);
    },
    SLOW,
  );

  it('refuses a redirect to another origin, naming it, and the other origin hears nothing (V19, E16, review M2)', async () => {
    const other = await started();
    const redirector = await started({
      redirect: { status: 307, location: `${other.origin}/mcp` },
    });
    expect(
      await client().connect(
        httpLaunch(redirector.url, { headers: { 'X-Api-Key': 'stub-key-6b1f' } }),
      ),
    ).toEqual({ ok: false, reason: redirectTo(other.origin), whole: true });
    expect(requests(other)).toEqual([]);
    expect(requests(redirector)).toHaveLength(1);
  });

  it('refuses a redirect within the same origin the same way', async () => {
    const redirector = await started({ redirect: { status: 307, location: '/elsewhere/mcp' } });
    expect(await client().connect(httpLaunch(redirector.url))).toEqual({
      ok: false,
      reason: redirectTo(redirector.origin),
      whole: true,
    });
    expect(requests(redirector).map((request) => request.path)).toEqual(['/mcp']);
  });

  it('refuses a redirect that names no Location, naming no origin', async () => {
    const redirector = await started({ redirect: { status: 307 } });
    expect(await client().connect(httpLaunch(redirector.url))).toEqual({
      ok: false,
      reason:
        'The server answered with a redirect; Consola does not follow redirects. Point `url` at the final address.',
      whole: true,
    });
  });

  it("finds Node's fetch answering a 307 as itself, Location readable, with redirect: 'manual' (Call 20)", async () => {
    const other = await started();
    const redirector = await started({
      redirect: { status: 307, location: `${other.origin}/mcp` },
    });
    for (const method of ['POST', 'GET']) {
      const response = await fetch(redirector.url, {
        method,
        redirect: 'manual',
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      expect(response.status).toBe(307);
      expect(response.type).toBe('basic');
      expect(response.headers.get('location')).toBe(`${other.origin}/mcp`);
    }
    expect(requests(other)).toEqual([]);
  });

  it(
    'fails a call whose answer is over 8 MB',
    async () => {
      const server = await started();
      const session = await connected(httpLaunch(server.url));
      const asked = Date.now();
      expect(
        await session.call('huge', {}, { timeoutMs: 10_000, signal: new AbortController().signal }),
      ).toMatchObject({ kind: 'unanswered', why: 'too-large' });
      // At once, not at the call's timeout: the connection closes once the count passes the cap.
      expect(Date.now() - asked).toBeLessThan(9000);
    },
    SLOW,
  );

  it(
    'answers a timeout that may have landed',
    async () => {
      const server = await started();
      const session = await connected(httpLaunch(server.url));
      expect(
        await session.call(
          'slow_post',
          {},
          { timeoutMs: 300, signal: new AbortController().signal },
        ),
      ).toMatchObject({ kind: 'unanswered', why: 'timeout' });
      await waitFor(() => worked(server) === 1, 5000, 'the work');
    },
    SLOW,
  );

  it(
    'cancels a stopped call and answers stopped, not a timeout',
    async () => {
      const server = await started();
      const session = await connected(httpLaunch(server.url));
      const controller = new AbortController();
      setTimeout(() => controller.abort('stop'), 100);
      expect(
        await session.call('slow_post', {}, { timeoutMs: 10_000, signal: controller.signal }),
      ).toMatchObject({ kind: 'unanswered', why: 'stopped' });
      await waitFor(() => rpcs(server, 'notifications/cancelled') === 1, 5000, 'the cancellation');
      // The stop closed the session itself: nothing more is sent on it.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(
        await session.call('post', {}, { timeoutMs: 10_000, signal: new AbortController().signal }),
      ).toMatchObject({ kind: 'unanswered', why: 'closed' });
      expect(rpcs(server, 'tools/call')).toBe(1);
    },
    SLOW,
  );

  it("says a server answered initialize with an error, in the server's own words", async () => {
    const server = await started({ initialize: 'error' });
    expect(await client().connect(httpLaunch(server.url))).toEqual({
      ok: false,
      reason: 'it answered with an error: warming up',
    });
  });

  it(
    'says a server did not answer within its budget',
    async () => {
      const server = await started({ initialize: 'hang' });
      expect(await client().connect(httpLaunch(server.url, { timeoutMs: 500 }))).toEqual({
        ok: false,
        reason: 'it did not answer within 500ms',
      });
    },
    SLOW,
  );

  it(
    'says a server sent a message over 8 MB while connecting',
    async () => {
      const server = await started({ initialize: 'huge' });
      expect(await client().connect(httpLaunch(server.url))).toEqual({
        ok: false,
        reason: 'it sent a message over 8 MB',
      });
    },
    SLOW,
  );

  it('says why fetch failed, with its cause', async () => {
    const server = await startHttpServer();
    const { url } = server;
    await server.close();
    expect(await client().connect(httpLaunch(url))).toEqual({
      ok: false,
      reason: 'fetch failed (ECONNREFUSED)',
    });
  });

  it('names only servers a row started (rule 5a-servers)', () => {
    // Every http(s) URL written in this file or its helpers is 127.0.0.1's.
    for (const file of [__filename, path.join(__dirname, 'mcpClient.test-helpers.ts')]) {
      const urls = fs.readFileSync(file, 'utf8').match(/\bhttps?:\/\/[^\s'"`)<>]*/g) ?? [];
      expect(urls.length, file).toBeGreaterThan(0);
      for (const url of urls) expect(url, file).toMatch(/^http:\/\/127\.0\.0\.1:/);
    }
  });
});
