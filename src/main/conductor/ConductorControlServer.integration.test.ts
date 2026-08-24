import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { ConductorControlServer, type ConductorControlDeps } from './ConductorControlServer';
import { makeSession, makeWorkspace } from './ConductorControlServer.test';

/** A fake conductor: the MCP SDK client over a raw socket, like the shim pipes. */
class SocketClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private readBuffer = new ReadBuffer();

  constructor(private readonly socket: net.Socket) {}

  async start(): Promise<void> {
    this.socket.on('data', (chunk) => {
      this.readBuffer.append(chunk);
      for (;;) {
        const message = this.readBuffer.readMessage();
        if (!message) break;
        this.onmessage?.(message);
      }
    });
    this.socket.on('error', (error) => this.onerror?.(error));
    this.socket.on('close', () => this.onclose?.());
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.socket.write(serializeMessage(message));
  }

  async close(): Promise<void> {
    this.socket.destroy();
  }
}

const TOOL_NAMES = [
  'consola_group_status',
  'consola_send_prompt',
  'consola_session_status',
  'consola_spawn_session',
];

let configDir: string;
let control: ConductorControlServer;
let deps: ConductorControlDeps;

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-mcp-int-'));
  deps = {
    getWorkspaces: vi.fn(() => [
      makeWorkspace({
        sessions: [
          makeSession(),
          makeSession({ id: 'w-1', name: 'worker', instanceId: 'inst-w1', kind: 'interactive' }),
        ],
      }),
    ]),
    launchSession: vi.fn(async () =>
      makeSession({ id: 'spawned-1', instanceId: 'inst-spawned', kind: 'interactive' })
    ),
    queuePrompt: vi.fn(() => true),
    getStatus: vi.fn(() => 'ready' as const),
    shimEntryPath: () => '/fake/shim.js',
    configDir: () => configDir,
  };
  control = new ConductorControlServer(deps);
});

afterEach(() => {
  control.dispose();
  fs.rmSync(configDir, { recursive: true, force: true });
});

// `{ content?: unknown }` alone is a TS "weak type": the client's
// CompatibilityCallToolResult union also includes an old-protocol
// `{ toolResult }` shape with no overlapping property, which strict mode
// then rejects outright. The index signature opts out of that check without
// changing what this reads at runtime.
function firstText(result: { content?: unknown; [key: string]: unknown }): string {
  return (result.content as Array<{ type: string; text: string }>)[0].text;
}

describe('MCP surface (in-memory)', () => {
  it('exposes exactly the four consola tools', async () => {
    const server = control.buildServerFor('cond-1');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'fake-conductor', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(TOOL_NAMES);
    await client.close();
  });

  it('answers group status tersely and spawns through the mocked launcher', async () => {
    const server = control.buildServerFor('cond-1');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'fake-conductor', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const status = await client.callTool({ name: 'consola_group_status', arguments: {} });
    expect(JSON.parse(firstText(status))).toEqual([
      { sessionId: 'cond-1', name: 'conductor', status: 'ready' },
      { sessionId: 'w-1', name: 'worker', status: 'ready' },
    ]);

    const spawned = await client.callTool({
      name: 'consola_spawn_session',
      arguments: { name: 'adapter', prompt: '[task:1] implement' },
    });
    expect(JSON.parse(firstText(spawned))).toEqual({
      sessionId: 'spawned-1',
      instanceId: 'inst-spawned',
    });
    expect(deps.launchSession).toHaveBeenCalledTimes(1);

    const rejected = await client.callTool({
      name: 'consola_send_prompt',
      arguments: { sessionId: 'not-in-group', prompt: 'hi' },
    });
    expect(rejected.isError).toBe(true);
    expect(firstText(rejected)).toMatch(/not in your group/);

    await client.close();
  });
});

describe('the socket endpoint', () => {
  async function endpointEnv(): Promise<{ socketPath: string; token: string }> {
    const configPath = await control.register(makeSession());
    const env = JSON.parse(fs.readFileSync(configPath, 'utf8')).mcpServers.consola.env;
    return { socketPath: env.CONSOLA_CONDUCTOR_SOCKET, token: env.CONSOLA_CONDUCTOR_TOKEN };
  }

  it('drops a connection with a wrong token before any MCP traffic', async () => {
    const { socketPath } = await endpointEnv();
    const socket = net.connect(socketPath);
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    socket.write(JSON.stringify({ token: 'wrong' }) + '\n');
    await new Promise<void>((resolve) => socket.once('close', () => resolve()));
    expect(socket.destroyed).toBe(true);
  });

  it('serves a full MCP session after a correct handshake', async () => {
    const { socketPath, token } = await endpointEnv();
    const socket = net.connect(socketPath);
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    socket.write(JSON.stringify({ token }) + '\n');

    const client = new Client({ name: 'fake-conductor', version: '0.0.0' });
    await client.connect(new SocketClientTransport(socket));

    const result = await client.callTool({
      name: 'consola_session_status',
      arguments: { sessionId: 'w-1' },
    });
    expect(JSON.parse(firstText(result))).toEqual({ status: 'ready', name: 'worker' });

    await client.close();
  });
});
