import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SessionMcpHost, mcpConfigForSession } from './SessionMcpHost';

let configDir: string;
let host: SessionMcpHost;
let buildServer: Mock<(sessionId: string) => McpServer>;

const session = (id = 'sess-1') => ({ id });

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-mcp-'));
  buildServer = vi.fn((_sessionId: string) => new McpServer({ name: 'consola', version: '0.0.0' }));
  host = new SessionMcpHost({
    shimEntryPath: () => '/fake/dist/conductorShim.js',
    configDir: () => configDir,
    buildServer,
  });
});

afterEach(() => {
  host.dispose();
  fs.rmSync(configDir, { recursive: true, force: true });
});

function envOf(configPath: string): Record<string, string> {
  return JSON.parse(fs.readFileSync(configPath, 'utf8')).mcpServers.consola.env;
}

describe('register', () => {
  it('writes a per-session mcp config wiring the shim to a private socket, for any session', async () => {
    const configPath = await host.register(session());

    expect(configPath).toBe(path.join(configDir, 'sess-1.json'));
    const entry = JSON.parse(fs.readFileSync(configPath, 'utf8')).mcpServers.consola;
    expect(entry.type).toBe('stdio');
    expect(entry.command).toBe(process.execPath);
    expect(entry.args).toEqual(['/fake/dist/conductorShim.js']);
    expect(entry.env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(entry.env.CONSOLA_CONDUCTOR_TOKEN).toMatch(/^[0-9a-f]{32}$/);
    // The socket actually listens.
    expect(fs.existsSync(entry.env.CONSOLA_CONDUCTOR_SOCKET)).toBe(true);
  });

  it('is idempotent: a second register returns the same config path', async () => {
    const first = await host.register(session());
    expect(await host.register(session())).toBe(first);
  });

  it('is idempotent under concurrency: two overlapping registers share one endpoint', async () => {
    const [first, second] = await Promise.all([host.register(session()), host.register(session())]);
    expect(second).toBe(first);
    // A second, losing endpoint would leak a listening socket nothing can unregister.
    expect(fs.readdirSync(configDir)).toEqual(['sess-1.json']);
  });

  it('gives each session its own socket and token', async () => {
    const a = envOf(await host.register(session('a')));
    const b = envOf(await host.register(session('b')));
    expect(a.CONSOLA_CONDUCTOR_SOCKET).not.toBe(b.CONSOLA_CONDUCTOR_SOCKET);
    expect(a.CONSOLA_CONDUCTOR_TOKEN).not.toBe(b.CONSOLA_CONDUCTOR_TOKEN);
  });

  it('keeps the config file private to the user', async () => {
    const configPath = await host.register(session());
    if (process.platform !== 'win32') {
      expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    }
  });
});

describe('unregister', () => {
  it('removes the config file and the socket', async () => {
    const configPath = await host.register(session());
    const socketPath = envOf(configPath).CONSOLA_CONDUCTOR_SOCKET;

    host.unregister('sess-1');

    expect(fs.existsSync(configPath)).toBe(false);
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it('tolerates an unknown session id', () => {
    expect(() => host.unregister('never-registered')).not.toThrow();
  });

  it('tears down an endpoint whose session was deleted while it was being set up', async () => {
    const registering = host.register(session());
    host.unregister('sess-1');
    await expect(registering).rejects.toThrow(/deleted while its MCP endpoint/);
    expect(fs.readdirSync(configDir)).toEqual([]);
    // A later session with the same id is not haunted by the cancellation.
    await expect(host.register(session())).resolves.toMatch(/sess-1\.json$/);
  });
});

describe('connection handling', () => {
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

  async function connected(): Promise<net.Socket> {
    return connectAndWait(envOf(await host.register(session())).CONSOLA_CONDUCTOR_SOCKET);
  }

  it('closes the socket on a syntactically valid handshake with the wrong token', async () => {
    const socket = await connected();
    const closed = waitForClose(socket);
    socket.write(JSON.stringify({ token: 'wrong-token' }) + '\n');
    await closed;
    expect(socket.destroyed).toBe(true);
    expect(buildServer).not.toHaveBeenCalled();
  });

  it('closes the socket on a non-JSON first line', async () => {
    const socket = await connected();
    const closed = waitForClose(socket);
    socket.write('not json\n');
    await closed;
    expect(socket.destroyed).toBe(true);
  });

  it('closes the socket after more than the handshake byte limit with no newline', async () => {
    const socket = await connected();
    const closed = waitForClose(socket);
    socket.write('a'.repeat(4097));
    await closed;
    expect(socket.destroyed).toBe(true);
  });

  it('builds a server for the endpoint’s own session id after a correct handshake', async () => {
    const configPath = await host.register(session());
    const env = envOf(configPath);
    const socket = await connectAndWait(env.CONSOLA_CONDUCTOR_SOCKET);
    socket.write(JSON.stringify({ token: env.CONSOLA_CONDUCTOR_TOKEN }) + '\n');
    await vi.waitFor(() => expect(buildServer).toHaveBeenCalledWith('sess-1'));
    socket.destroy();
  });

  it('unregister destroys an already-connected socket, not just the listener', async () => {
    const socket = await connected();
    const closed = waitForClose(socket);
    host.unregister('sess-1');
    await closed;
    expect(socket.destroyed).toBe(true);
  });
});

describe('mcpConfigForSession', () => {
  it('hands every kind of session its config path', async () => {
    await expect(mcpConfigForSession({ id: 'c', kind: 'conductor' }, host)).resolves.toMatch(/c\.json$/);
    await expect(mcpConfigForSession({ id: 'i', kind: 'interactive' }, host)).resolves.toMatch(/i\.json$/);
  });

  it('launches an ordinary session without MCP when the endpoint cannot be set up', async () => {
    const broken = { register: () => Promise.reject(new Error('EACCES')) };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(mcpConfigForSession({ id: 'i', kind: 'interactive' }, broken)).resolves.toBeUndefined();
  });

  it('refuses to launch a conductor without its control tools', async () => {
    const broken = { register: () => Promise.reject(new Error('EACCES')) };
    await expect(mcpConfigForSession({ id: 'c', kind: 'conductor' }, broken)).rejects.toThrow('EACCES');
  });
});
