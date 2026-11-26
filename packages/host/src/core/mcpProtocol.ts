/**
 * The little of MCP the host's `/mcp` endpoint speaks (JSON-RPC 2.0 over MCP's Streamable HTTP, as
 * a stateless tool server): `initialize`, `ping`, `tools/list` and `tools/call`; notifications and
 * replies are heard and not answered, and every other method is refused. Pure: what a message asks,
 * and the replies. `adapters/mcpHttp.ts` reads the request and answers it.
 */
import type { ToolAnswer, ToolListing } from './agentRunTools.ts';

/** The protocol versions it speaks, newest first; a client asking for another gets the newest. */
export const MCP_PROTOCOL_VERSIONS: readonly string[] = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];

/** The server's name and version, in `initialize`'s answer. */
export const MCP_SERVER_INFO = { name: 'consola-agent-run', version: '1.0.0' } as const;

export type JsonRpcId = string | number;

/** What one JSON-RPC message asks. */
export type McpRequest =
  | { readonly kind: 'initialize'; readonly id: JsonRpcId; readonly protocolVersion: string }
  | { readonly kind: 'ping'; readonly id: JsonRpcId }
  | { readonly kind: 'list-tools'; readonly id: JsonRpcId }
  | {
      readonly kind: 'call-tool';
      readonly id: JsonRpcId;
      readonly name: string;
      readonly arguments: unknown;
    }
  /** A notification, or a reply to nothing this server asked: nothing to answer. */
  | { readonly kind: 'quiet' }
  | { readonly kind: 'unknown-method'; readonly id: JsonRpcId; readonly method: string }
  | { readonly kind: 'invalid'; readonly id: JsonRpcId | null; readonly problem: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is JsonRpcId =>
  typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));

/** Reads one JSON-RPC message (already parsed from JSON). Never throws. */
export function readMcpMessage(message: unknown): McpRequest {
  if (!isRecord(message) || message.jsonrpc !== '2.0') {
    return { kind: 'invalid', id: null, problem: 'Invalid Request' };
  }
  const { id, method, params } = message;
  if (typeof method !== 'string') {
    // A reply (to a request this server never makes) or nothing: either way, not answered.
    return 'result' in message || 'error' in message
      ? { kind: 'quiet' }
      : { kind: 'invalid', id: isId(id) ? id : null, problem: 'Invalid Request' };
  }
  if (id === undefined) return { kind: 'quiet' };
  if (!isId(id)) return { kind: 'invalid', id: null, problem: 'Invalid Request' };
  switch (method) {
    case 'initialize': {
      const asked = isRecord(params) ? params.protocolVersion : undefined;
      const version =
        typeof asked === 'string' && MCP_PROTOCOL_VERSIONS.includes(asked)
          ? asked
          : (MCP_PROTOCOL_VERSIONS[0] as string);
      return { kind: 'initialize', id, protocolVersion: version };
    }
    case 'ping':
      return { kind: 'ping', id };
    case 'tools/list':
      return { kind: 'list-tools', id };
    case 'tools/call': {
      const name = isRecord(params) ? params.name : undefined;
      if (typeof name !== 'string') return { kind: 'invalid', id, problem: 'Invalid params' };
      return {
        kind: 'call-tool',
        id,
        name,
        arguments: isRecord(params) ? (params.arguments ?? {}) : {},
      };
    }
    default:
      return { kind: 'unknown-method', id, method };
  }
}

const result = (id: JsonRpcId, value: unknown) => ({ jsonrpc: '2.0' as const, id, result: value });

const ERROR_CODES: Readonly<Record<string, number>> = {
  'Parse error': -32_700,
  'Invalid Request': -32_600,
  'Invalid params': -32_602,
};

/** JSON-RPC's codes: -32700 parse error, -32600 invalid request, -32602 invalid params. */
export const mcpError = (id: JsonRpcId | null, problem: string, code?: number) => ({
  jsonrpc: '2.0' as const,
  id,
  error: { code: code ?? ERROR_CODES[problem] ?? -32_600, message: problem },
});

export const initializeResult = (id: JsonRpcId, protocolVersion: string) =>
  result(id, {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: MCP_SERVER_INFO,
  });

export const pingResult = (id: JsonRpcId) => result(id, {});

export const listToolsResult = (id: JsonRpcId, tools: readonly ToolListing[]) =>
  result(id, { tools });

/** A tool's answer as MCP carries it: its JSON as text (and as structured content), or an error. */
export const callToolResult = (id: JsonRpcId, answer: ToolAnswer) =>
  answer.isError
    ? result(id, { content: [{ type: 'text', text: answer.text }], isError: true })
    : result(id, {
        content: [{ type: 'text', text: JSON.stringify(answer.value, null, 2) }],
        structuredContent: answer.value,
        isError: false,
      });

export const unknownMethod = (id: JsonRpcId, method: string) =>
  mcpError(id, `Method not found: ${method.slice(0, 64)}`, -32_601);
