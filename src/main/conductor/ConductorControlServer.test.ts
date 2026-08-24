import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
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

describe('mcpConfigForSession', () => {
  it("hands a conductor its config path and an interactive session nothing", async () => {
    await expect(mcpConfigForSession(makeSession(), control)).resolves.toMatch(/cond-1\.json$/);
    await expect(
      mcpConfigForSession(makeSession({ id: 'i-1', kind: 'interactive' }), control)
    ).resolves.toBeUndefined();
  });
});
