import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
// 'zod/v3', not 'zod': the root import trips TS2589 in the SDK's zod-compat conditional types.
import { z } from 'zod/v3';

/**
 * Proves the MCP SDK works under this repo's CommonJS main build before
 * ConductorControlServer is built on it: subpath imports resolve, a server
 * registers a zod-typed tool, and a client can call it end to end.
 */
describe('MCP SDK interop', () => {
  it('serves a tool call over a linked in-memory transport', async () => {
    const server = new McpServer({ name: 'smoke', version: '0.0.0' });
    server.registerTool(
      'echo',
      { description: 'echo back', inputSchema: { text: z.string() } },
      async ({ text }) => ({ content: [{ type: 'text' as const, text }] })
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'smoke-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: 'echo', arguments: { text: 'ping' } });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toBe('ping');

    await client.close();
  });
});
