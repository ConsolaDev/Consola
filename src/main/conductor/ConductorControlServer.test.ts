import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type { Session, Workspace } from '../../shared/workspace';
import {
  ConductorControlServer,
  mcpConfigForSession,
  type ConductorControlDeps,
} from './ConductorControlServer';

let configDir: string;
let control: ConductorControlServer;
let deps: ConductorControlDeps;

/** v6 session fixture. Cast tolerates fields v6 adds beyond this plan's use. */
export function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'cond-1',
    name: 'conductor',
    workspaceId: 'ws-1',
    instanceId: 'inst-cond',
    claudeSessionId: '00000000-0000-4000-8000-000000000001',
    hasStarted: false,
    harnessId: 'default',
    scopeId: 'scope-1',
    groupId: 'grp-1',
    kind: 'conductor',
    createdAt: 0,
    lastActiveAt: 0,
    ...overrides,
  } as Session;
}

export function makeWorkspace(overrides: Record<string, unknown> = {}): Workspace {
  return {
    id: 'ws-1',
    name: 'Sympower',
    defaultHarnessId: 'default',
    scopes: [
      { id: 'scope-1', name: 'app', path: '/repos/app', isGitRepo: true, createdAt: 0 },
      { id: 'scope-2', name: 'parent', path: '/repos/parent', isGitRepo: false, createdAt: 0 },
    ],
    groups: [{ id: 'grp-1', name: 'symbalance-api', createdAt: 0 }],
    sessions: [makeSession()],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as unknown as Workspace;
}

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-mcp-'));
  deps = {
    getWorkspaces: vi.fn(() => [makeWorkspace()]),
    launchSession: vi.fn(),
    queuePrompt: vi.fn(() => true),
    getStatus: vi.fn(() => 'ready' as const),
    shimEntryPath: () => '/fake/dist/conductorShim.js',
    configDir: () => configDir,
  };
  control = new ConductorControlServer(deps);
});

afterEach(() => {
  control.dispose();
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe('register', () => {
  it('refuses a non-conductor session', async () => {
    await expect(control.register(makeSession({ kind: 'interactive' }))).rejects.toThrow(
      /not a conductor/
    );
  });

  it('writes a per-session mcp config wiring the shim to a private socket', async () => {
    const configPath = await control.register(makeSession());

    expect(configPath).toBe(path.join(configDir, 'cond-1.json'));
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const entry = config.mcpServers.consola;
    expect(entry.type).toBe('stdio');
    expect(entry.command).toBe(process.execPath);
    expect(entry.args).toEqual(['/fake/dist/conductorShim.js']);
    expect(entry.env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(entry.env.CONSOLA_CONDUCTOR_SOCKET).toBeTruthy();
    expect(entry.env.CONSOLA_CONDUCTOR_TOKEN).toMatch(/^[0-9a-f]{32}$/);
    // The socket actually listens.
    expect(fs.existsSync(entry.env.CONSOLA_CONDUCTOR_SOCKET)).toBe(true);
  });

  it('is idempotent: a second register returns the same config path', async () => {
    const first = await control.register(makeSession());
    const second = await control.register(makeSession());
    expect(second).toBe(first);
  });

  it('is idempotent under concurrency: two overlapping registers share one endpoint', async () => {
    const session = makeSession();
    const [first, second] = await Promise.all([
      control.register(session),
      control.register(session),
    ]);

    expect(second).toBe(first);
    // Only one config file was ever written — a second, losing endpoint
    // would otherwise leak a listening socket nothing can ever unregister.
    expect(fs.readdirSync(configDir)).toEqual(['cond-1.json']);
  });

  it('keeps the config file private to the user', async () => {
    const configPath = await control.register(makeSession());
    if (process.platform !== 'win32') {
      expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    }
  });
});

describe('unregister', () => {
  it('removes the config file and the socket', async () => {
    const configPath = await control.register(makeSession());
    const socketPath = JSON.parse(fs.readFileSync(configPath, 'utf8')).mcpServers.consola.env
      .CONSOLA_CONDUCTOR_SOCKET;

    control.unregister('cond-1');

    expect(fs.existsSync(configPath)).toBe(false);
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it('tolerates an unknown session id', () => {
    expect(() => control.unregister('never-registered')).not.toThrow();
  });
});

describe('connection handling', () => {
  async function socketPathFor(configPath: string): Promise<string> {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return config.mcpServers.consola.env.CONSOLA_CONDUCTOR_SOCKET;
  }

  function connectAndWait(socketPath: string): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(socketPath);
      socket.once('connect', () => resolve(socket));
      socket.once('error', reject);
    });
  }

  function waitForClose(socket: net.Socket): Promise<void> {
    return new Promise((resolve) => socket.once('close', resolve));
  }

  it('closes the socket on a syntactically valid handshake with the wrong token', async () => {
    const configPath = await control.register(makeSession());
    const socket = await connectAndWait(await socketPathFor(configPath));

    const closed = waitForClose(socket);
    socket.write(JSON.stringify({ token: 'wrong-token' }) + '\n');
    await closed;

    expect(socket.destroyed).toBe(true);
  });

  it('closes the socket on a non-JSON first line', async () => {
    const configPath = await control.register(makeSession());
    const socket = await connectAndWait(await socketPathFor(configPath));

    const closed = waitForClose(socket);
    socket.write('not json\n');
    await closed;

    expect(socket.destroyed).toBe(true);
  });

  it('closes the socket after more than the handshake byte limit with no newline', async () => {
    const configPath = await control.register(makeSession());
    const socket = await connectAndWait(await socketPathFor(configPath));

    const closed = waitForClose(socket);
    socket.write('a'.repeat(4097));
    await closed;

    expect(socket.destroyed).toBe(true);
  });

  it('unregister destroys an already-connected socket, not just the listener', async () => {
    const configPath = await control.register(makeSession());
    const socket = await connectAndWait(await socketPathFor(configPath));

    const closed = waitForClose(socket);
    control.unregister('cond-1');
    await closed;

    expect(socket.destroyed).toBe(true);
  });
});

describe('mcpConfigForSession', () => {
  it("hands a conductor its config path and an interactive session nothing", async () => {
    await expect(mcpConfigForSession(makeSession(), control)).resolves.toMatch(/cond-1\.json$/);
    await expect(
      mcpConfigForSession(makeSession({ id: 'i-1', kind: 'interactive' }), control)
    ).resolves.toBeUndefined();
  });
});

describe('tool handlers enforce the group boundary', () => {
  const worker = () =>
    makeSession({ id: 'w-1', name: 'adapter · implement', instanceId: 'inst-w1', kind: 'interactive' });
  const foreign = () =>
    makeSession({ id: 'f-1', name: 'other', instanceId: 'inst-f1', kind: 'interactive', groupId: 'grp-OTHER' });

  beforeEach(() => {
    deps.getWorkspaces = vi.fn(() => [
      makeWorkspace({ sessions: [makeSession(), worker(), foreign()] }),
    ]);
    control = new ConductorControlServer(deps);
  });

  describe('handleSpawnSession', () => {
    it('rejects a scopePath that is not one of the workspace scopes', async () => {
      await expect(
        control.handleSpawnSession('cond-1', {
          name: 'w',
          scopePath: '/somewhere/else',
          prompt: 'go',
        })
      ).rejects.toThrow(/not one of this workspace's scopes/);
      expect(deps.launchSession).not.toHaveBeenCalled();
    });

    it("forces the conductor's own group and kind interactive, whatever the args", async () => {
      deps.launchSession = vi.fn(async (_wsId, fields) =>
        makeSession({ id: 'new-1', instanceId: 'inst-new', ...fields } as Partial<Session>)
      );
      control = new ConductorControlServer(deps);

      const result = await control.handleSpawnSession('cond-1', {
        name: 'worker',
        scopePath: '/repos/parent',
        prompt: '[task:1] implement the adapter',
      });

      expect(result.sessionId).toBe('new-1');
      const fields = (deps.launchSession as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(fields.groupId).toBe('grp-1');          // the conductor's group, not an argument
      expect(fields.kind).toBe('interactive');
      expect(fields.scopeId).toBe('scope-2');        // resolved from scopePath
      expect(fields.harnessId).toBe('default');      // inherited from the conductor
      expect(fields.initialPrompt).toBe('[task:1] implement the adapter');
    });

    it("defaults to the conductor's own scope when scopePath is omitted", async () => {
      deps.launchSession = vi.fn(async () => makeSession({ id: 'new-2', instanceId: 'i2' }));
      control = new ConductorControlServer(deps);

      await control.handleSpawnSession('cond-1', { name: 'w', prompt: 'go' });

      const fields = (deps.launchSession as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(fields.scopeId).toBe('scope-1');
    });

    it('rejects a cwd outside the resolved scope', async () => {
      await expect(
        control.handleSpawnSession('cond-1', {
          name: 'w',
          scopePath: '/repos/app',
          cwd: '/repos/parent/other',
          prompt: 'go',
        })
      ).rejects.toThrow(/cwd must be inside/);
    });

    it('rejects a caller that is not a conductor — a worker id cannot drive the tools', async () => {
      await expect(
        control.handleSpawnSession('w-1', { name: 'x', prompt: 'go' })
      ).rejects.toThrow(/not a conductor/);
    });
  });

  describe('handleSendPrompt', () => {
    it('enqueues on a group member through the guarded FIFO', () => {
      const result = control.handleSendPrompt('cond-1', { sessionId: 'w-1', prompt: 'continue' });
      expect(result).toEqual({ queued: true });
      expect(deps.queuePrompt).toHaveBeenCalledWith('inst-w1', 'continue');
    });

    it('rejects a session outside the group', () => {
      expect(() =>
        control.handleSendPrompt('cond-1', { sessionId: 'f-1', prompt: 'hi' })
      ).toThrow(/not in your group/);
      expect(deps.queuePrompt).not.toHaveBeenCalled();
    });

    it('reports a dead terminal instead of silently dropping the prompt', () => {
      deps.queuePrompt = vi.fn(() => false);
      control = new ConductorControlServer(deps);
      expect(() =>
        control.handleSendPrompt('cond-1', { sessionId: 'w-1', prompt: 'hi' })
      ).toThrow(/no live terminal/);
    });
  });

  describe('handleSessionStatus', () => {
    it('answers with the terse status and name for a group member', () => {
      deps.getStatus = vi.fn(() => 'needs-attention' as const);
      control = new ConductorControlServer(deps);
      expect(control.handleSessionStatus('cond-1', { sessionId: 'w-1' })).toEqual({
        status: 'needs-attention',
        name: 'adapter · implement',
      });
    });

    it('rejects a session outside the group', () => {
      expect(() => control.handleSessionStatus('cond-1', { sessionId: 'f-1' })).toThrow(
        /not in your group/
      );
    });
  });

  describe('handleGroupStatus', () => {
    it('lists every group member with its status — the bell, not the package', () => {
      const rows = control.handleGroupStatus('cond-1');
      expect(rows).toEqual([
        { sessionId: 'cond-1', name: 'conductor', status: 'ready' },
        { sessionId: 'w-1', name: 'adapter · implement', status: 'ready' },
      ]);
    });
  });
});
