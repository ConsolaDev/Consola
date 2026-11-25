import { describe, expect, it } from 'vite-plus/test';
import {
  callToolResult,
  initializeResult,
  mcpError,
  readMcpLine,
  unknownMethod,
} from './mcpMessages.ts';

const line = (message: unknown) => JSON.stringify(message);

describe('the step tools server’s MCP messages', () => {
  it('reads initialize, answering the version the client asked for when it speaks it', () => {
    expect(
      readMcpLine(
        line({
          jsonrpc: '2.0',
          id: 0,
          method: 'initialize',
          params: { protocolVersion: '2025-03-26' },
        }),
      ),
    ).toEqual({ kind: 'initialize', id: 0, protocolVersion: '2025-03-26' });
    expect(
      readMcpLine(
        line({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '1999-01-01' },
        }),
      ),
    ).toEqual({ kind: 'initialize', id: 1, protocolVersion: '2025-06-18' });
    expect(initializeResult(1, '2025-06-18')).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'consola-step-tools', version: '1.0.0' },
      },
    });
  });

  it('reads a tool call, its list and a ping', () => {
    expect(
      readMcpLine(
        line({
          jsonrpc: '2.0',
          id: 'a',
          method: 'tools/call',
          params: { name: 'consola_list_artifacts', arguments: { x: 1 } },
        }),
      ),
    ).toEqual({ kind: 'call-tool', id: 'a', name: 'consola_list_artifacts', arguments: { x: 1 } });
    expect(readMcpLine(line({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))).toEqual({
      kind: 'list-tools',
      id: 2,
    });
    expect(readMcpLine(line({ jsonrpc: '2.0', id: 3, method: 'ping' }))).toEqual({
      kind: 'ping',
      id: 3,
    });
    expect(callToolResult(4, { text: 'Set: verdict.', isError: false })).toEqual({
      jsonrpc: '2.0',
      id: 4,
      result: { content: [{ type: 'text', text: 'Set: verdict.' }], isError: false },
    });
  });

  it('answers no notification or reply, and refuses what is not JSON-RPC', () => {
    expect(readMcpLine(line({ jsonrpc: '2.0', method: 'notifications/initialized' }))).toEqual({
      kind: 'quiet',
    });
    expect(readMcpLine(line({ jsonrpc: '2.0', id: 9, result: {} }))).toEqual({ kind: 'quiet' });
    expect(readMcpLine('not json')).toEqual({ kind: 'invalid', id: null, problem: 'Parse error' });
    expect(readMcpLine(line([{ jsonrpc: '2.0', id: 1, method: 'ping' }]))).toMatchObject({
      kind: 'invalid',
    });
    expect(readMcpLine(line({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: {} }))).toEqual({
      kind: 'invalid',
      id: 5,
      problem: 'Invalid params',
    });
    expect(mcpError(5, 'Invalid params').error.code).toBe(-32602);
  });

  it('refuses every other method', () => {
    expect(readMcpLine(line({ jsonrpc: '2.0', id: 6, method: 'resources/list' }))).toEqual({
      kind: 'unknown-method',
      id: 6,
      method: 'resources/list',
    });
    expect(unknownMethod(6, 'resources/list').error.code).toBe(-32601);
  });
});
