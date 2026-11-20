import { expect, type ElectronApplication } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/**
 * A session's agent, as the CLI is one: an MCP client on the session's own
 * endpoint (`SessionMcpHost`), the private socket and handshake token main
 * writes to the session's config file once its terminal is created. This is
 * the path a real agent's calls take, so whatever a test asks through it is
 * gated the way the CLI's calls are: by which session's socket it arrived on.
 */

/** The MCP SDK client over a raw socket, as `conductorShim` pipes the CLI's stdio to it. */
class SocketClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private readonly readBuffer = new ReadBuffer();

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

export interface Endpoint {
  socketPath: string;
  token: string;
}

/**
 * The session's socket and token, from the config file main hands the CLI
 * (`<userData>/session-mcp/<sessionId>.json`). It is written when the
 * session's terminal is created, so this waits for it.
 */
export async function sessionEndpoint(
  app: ElectronApplication,
  sessionId: string,
): Promise<Endpoint> {
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  const configPath = path.join(userData, 'session-mcp', `${sessionId}.json`);
  await expect
    .poll(() => fs.existsSync(configPath), { message: `no MCP config for session ${sessionId}` })
    .toBe(true);
  const env = JSON.parse(fs.readFileSync(configPath, 'utf8')).mcpServers.consola.env;
  return { socketPath: env.CONSOLA_CONDUCTOR_SOCKET, token: env.CONSOLA_CONDUCTOR_TOKEN };
}

/** One content block of a tool's answer. */
export interface AnswerBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface ToolAnswer {
  isError: boolean;
  /** The first block's text: what every browser tool answers in. */
  text: string;
  content: AnswerBlock[];
}

export interface AgentClient {
  /** The names of the tools the session's server offers this connection. */
  toolNames(): Promise<string[]>;
  call(name: string, args?: Record<string, unknown>): Promise<ToolAnswer>;
  close(): Promise<void>;
}

/** Connects to the session's endpoint with its token, and speaks MCP over the socket. */
export async function connectAgent(
  app: ElectronApplication,
  sessionId: string,
): Promise<AgentClient> {
  const { socketPath, token } = await sessionEndpoint(app, sessionId);
  const socket = net.connect(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  socket.write(`${JSON.stringify({ token })}\n`);
  const client = new Client({ name: 'browser-agent-e2e', version: '0.0.0' });
  await client.connect(new SocketClientTransport(socket));
  return {
    async toolNames() {
      return (await client.listTools()).tools.map((tool) => tool.name).sort();
    },
    async call(name, args = {}) {
      const result = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content?: AnswerBlock[];
      };
      const content = result.content ?? [];
      return { isError: result.isError === true, text: content[0]?.text ?? '', content };
    },
    close: () => client.close(),
  };
}
