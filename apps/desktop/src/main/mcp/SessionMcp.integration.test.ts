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
import type { RunRecord } from '@consola/factory-spec';
import { ConductorTools, type ConductorToolsDeps } from '../conductor/ConductorTools';
import { makeSession, makeWorkspace } from '../conductor/ConductorTools.test';
import { consolaTools, type ConsolaToolDeps } from '../tools/consolaTools';
import { ToolRegistry } from '../tools/Tool';
import { buildSessionServer } from './buildSessionServer';
import { SessionMcpHost } from './SessionMcpHost';

/** A fake agent: the MCP SDK client over a raw socket, like the shim pipes. */
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

const CONSOLA_TOOLS = [
  'consola_cleanup_stale_sessions',
  'consola_delete_session',
  'consola_find_stale_sessions',
  'consola_list_automations',
  'consola_list_sessions',
  'consola_run_automation',
];
const CONDUCTOR_TOOLS = [
  'consola_group_status',
  'consola_send_prompt',
  'consola_session_status',
  'consola_spawn_session',
];

let configDir: string;
let host: SessionMcpHost;
let conductorDeps: ConductorToolsDeps;
let toolDeps: ConsolaToolDeps;
let build: (sessionId: string) => ReturnType<typeof buildSessionServer>;

const workspaces = () => [
  makeWorkspace({
    sessions: [
      makeSession(),
      makeSession({ id: 'w-1', name: 'worker', instanceId: 'inst-w1', kind: 'interactive' }),
    ],
  }),
  makeWorkspace({ id: 'ws-2', name: 'Other', sessions: [makeSession({ id: 'x-1', workspaceId: 'ws-2', kind: 'interactive' })] }),
];

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-mcp-int-'));
  conductorDeps = {
    getWorkspaces: vi.fn(workspaces),
    launchSession: vi.fn(async () =>
      makeSession({ id: 'spawned-1', instanceId: 'inst-spawned', kind: 'interactive' })
    ),
    queuePrompt: vi.fn(() => true),
    getStatus: vi.fn(() => 'ready' as const),
  };
  toolDeps = {
    cleanup: {
      previewStale: vi.fn(async () => ({ candidates: [], skipped: [], unknownSessionIds: [], summary: 'No sessions with finished pull requests.' })),
      cleanupStale: vi.fn(),
      deleteSession: vi.fn(),
    },
    getWorkspaces: workspaces,
    status: () => 'ready',
    isManagedPath: () => false,
    automations: () => ({ list: () => [], trigger: vi.fn() }),
  };
  const registry = new ToolRegistry();
  consolaTools(toolDeps).forEach((tool) => registry.register(tool));
  const conductorTools = new ConductorTools(conductorDeps);
  build = (sessionId) => buildSessionServer(sessionId, { registry, conductorTools, getWorkspaces: workspaces });
  host = new SessionMcpHost({ shimEntryPath: () => '/fake/shim.js', configDir: () => configDir, buildServer: build });
});

afterEach(() => {
  host.dispose();
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

async function clientFor(sessionId: string): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'fake-agent', version: '0.0.0' });
  await Promise.all([build(sessionId).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('MCP surface (in-memory)', () => {
  it('gives an ordinary session exactly the Consola tools', async () => {
    const client = await clientFor('w-1');
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(CONSOLA_TOOLS);
    await client.close();
  });

  it('tells the CLI which tools only read and which delete', async () => {
    const client = await clientFor('w-1');
    const { tools } = await client.listTools();
    const hints = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));
    expect(hints.consola_list_sessions).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(hints.consola_cleanup_stale_sessions).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(hints.consola_delete_session).toMatchObject({ destructiveHint: true });
    expect(hints.consola_run_automation).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    await client.close();
  });

  it('gives a conductor the Consola tools plus its four group tools', async () => {
    const client = await clientFor('cond-1');
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([...CONSOLA_TOOLS, ...CONDUCTOR_TOOLS].sort());
    await client.close();
  });

  it('scopes Consola tools to the caller’s own workspace, minus itself — from the endpoint, not the args', async () => {
    const client = await clientFor('w-1');
    const result = await client.callTool({ name: 'consola_find_stale_sessions', arguments: {} });
    expect(JSON.parse(firstText(result))).toMatchObject({ summary: 'No sessions with finished pull requests.' });
    expect(toolDeps.cleanup.previewStale).toHaveBeenCalledWith(
      { workspaceIds: ['ws-1'], excludeSessionIds: ['w-1'] },
      { prStates: ['merged', 'closed'] }
    );
    await client.close();
  });

  it('lists only the caller’s workspace, marking the caller', async () => {
    const client = await clientFor('w-1');
    const listed = JSON.parse(firstText(await client.callTool({ name: 'consola_list_sessions', arguments: {} })));
    expect(listed.sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual(['cond-1', 'w-1']);
    expect(listed.sessions[1]).toMatchObject({ sessionId: 'w-1', you: true, status: 'ready' });
    await client.close();
  });

  it('tells an agent how an automation run went, never what it found across workspaces', async () => {
    const at = '2026-11-04T09:00:00.000Z';
    const run: RunRecord = {
      id: 'run-1',
      runner: 'local',
      source: 'personal',
      automationId: 'sweep',
      actionName: 'consola#cleanup_stale_sessions',
      actionVersion: 'v1',
      mode: 'confirm',
      trigger: { kind: 'manual', at, by: 'agent', actorId: 'w-1' },
      status: 'needs-approval',
      summary: 'Would remove 1 session. An agent asked for this run.',
      // What the preview found in another workspace: none of it may reach the agent.
      result: { candidates: [{ sessionId: 'x-1', name: 'Other workspace session', cwd: '/elsewhere/x-1' }] },
      approval: { args: { session_ids: ['x-1'] } },
      attribution: { automationId: 'sweep', actionName: 'consola#cleanup_stale_sessions', triggerKind: 'manual', actorId: 'w-1' },
      createdAt: at,
      updatedAt: at,
    };
    const trigger = vi.fn(async (_name: string, _actor: { sessionId?: string }) => run);
    toolDeps.automations = () => ({ list: () => [], trigger });
    const client = await clientFor('w-1');
    const answer = JSON.parse(
      firstText(await client.callTool({ name: 'consola_run_automation', arguments: { name: 'sweep' } }))
    );
    expect(answer).toEqual({
      summary: 'Would remove 1 session. An agent asked for this run.',
      runId: 'run-1',
      status: 'needs-approval',
    });
    expect(trigger).toHaveBeenCalledWith('sweep', { sessionId: 'w-1' });
    await client.close();
  });

  it('answers bad arguments as a tool error, not a crash', async () => {
    const client = await clientFor('w-1');
    const result = await client.callTool({
      name: 'consola_cleanup_stale_sessions',
      arguments: { pr_states: ['open'] },
    });
    expect(result.isError).toBe(true);
    expect(toolDeps.cleanup.cleanupStale).not.toHaveBeenCalled();
    await client.close();
  });

  it('keeps the conductor tools group-scoped', async () => {
    const client = await clientFor('cond-1');

    const status = await client.callTool({ name: 'consola_group_status', arguments: {} });
    expect(JSON.parse(firstText(status))).toEqual([
      { sessionId: 'cond-1', name: 'conductor', status: 'ready' },
      { sessionId: 'w-1', name: 'worker', status: 'ready' },
    ]);

    const spawned = await client.callTool({
      name: 'consola_spawn_session',
      arguments: { name: 'adapter', prompt: '[task:1] implement' },
    });
    expect(JSON.parse(firstText(spawned))).toEqual({ sessionId: 'spawned-1', instanceId: 'inst-spawned' });

    const rejected = await client.callTool({
      name: 'consola_send_prompt',
      arguments: { sessionId: 'not-in-group', prompt: 'hi' },
    });
    expect(rejected.isError).toBe(true);
    expect(firstText(rejected)).toMatch(/not in your group/);
    await client.close();
  });

  it('refuses a caller whose session is gone', async () => {
    const client = await clientFor('deleted-1');
    const result = await client.callTool({ name: 'consola_list_sessions', arguments: {} });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/no longer exists/);
    await client.close();
  });
});

describe('the socket endpoint', () => {
  async function endpointEnv(sessionId: string): Promise<{ socketPath: string; token: string }> {
    const configPath = await host.register({ id: sessionId });
    const env = JSON.parse(fs.readFileSync(configPath, 'utf8')).mcpServers.consola.env;
    return { socketPath: env.CONSOLA_CONDUCTOR_SOCKET, token: env.CONSOLA_CONDUCTOR_TOKEN };
  }

  it('drops a connection with a wrong token before any MCP traffic', async () => {
    const { socketPath } = await endpointEnv('w-1');
    const socket = net.connect(socketPath);
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    socket.write(JSON.stringify({ token: 'wrong' }) + '\n');
    await new Promise<void>((resolve) => socket.once('close', () => resolve()));
    expect(socket.destroyed).toBe(true);
  });

  it('serves a full MCP session after a correct handshake, as the endpoint’s session', async () => {
    const { socketPath, token } = await endpointEnv('cond-1');
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
