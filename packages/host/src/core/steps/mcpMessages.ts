/**
 * The little of MCP the step tools' server speaks (JSON-RPC 2.0, one message per line on stdio):
 * `initialize`, `ping`, `tools/list` and `tools/call`, notifications heard and not answered, and
 * every other method refused. Pure: what a line asks, and the replies. The server
 * (`adapters/stepToolsServer.ts`) reads the lines and acts.
 */
import type { StepToolAnswer, StepToolListing } from './stepTools.ts';

/** The protocol versions it speaks, newest first; a client asking for another gets the newest. */
export const MCP_PROTOCOL_VERSIONS: readonly string[] = ['2025-06-18', '2025-03-26', '2024-11-05'];

/** The server's name and version, in `initialize`'s answer. */
export const STEP_TOOLS_SERVER_INFO = { name: 'consola-step-tools', version: '1.0.0' } as const;

type JsonRpcId = string | number;

/** What one line asks. */
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

/** Reads one line as an MCP message. Never throws. */
export function readMcpLine(line: string): McpRequest {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return { kind: 'invalid', id: null, problem: 'Parse error' };
  }
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

const result = (id: JsonRpcId, value: unknown) => ({ jsonrpc: '2.0', id, result: value });

/** JSON-RPC's codes: -32700 parse error, -32600 invalid request, -32602 invalid params, -32601 no such method. */
export function mcpError(id: JsonRpcId | null, problem: string, code?: number) {
  const known: Record<string, number> = {
    'Parse error': -32_700,
    'Invalid Request': -32_600,
    'Invalid params': -32_602,
  };
  return {
    jsonrpc: '2.0',
    id,
    error: { code: code ?? known[problem] ?? -32_600, message: problem },
  };
}

export const initializeResult = (id: JsonRpcId, protocolVersion: string) =>
  result(id, {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: STEP_TOOLS_SERVER_INFO,
  });

export const pingResult = (id: JsonRpcId) => result(id, {});

export const listToolsResult = (id: JsonRpcId, tools: readonly StepToolListing[]) =>
  result(id, { tools });

export const callToolResult = (id: JsonRpcId, answer: StepToolAnswer) =>
  result(id, { content: [{ type: 'text', text: answer.text }], isError: answer.isError });

export const unknownMethod = (id: JsonRpcId, method: string) =>
  mcpError(id, `Method not found: ${method.slice(0, 64)}`, -32_601);
