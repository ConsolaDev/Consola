import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

/*
 * Scratch MCP servers for `mcpClient.test.ts` (rule 5a-servers): each is a
 * plain `.cjs` file written into the test's own temp folder and started with
 * `process.execPath`. A server's controls are baked into its file or passed
 * as its arguments, never through its environment, which is exactly the
 * allow-list, its `env:` and its secrets (review B1). Its first argument
 * after the file is the log it appends one JSON line per event to.
 */

/** How a scratch server behaves besides its tools. */
export type ScratchBehaviour =
  | 'plain'
  /** Starts `sleep 60` in its own process group, so only the group's signal ends it. */
  | 'grandchild'
  /** Starts `sleep 60` detached, in a session of its own, and logs its pid. */
  | 'setsid_child'
  /** Logs `SIGTERM` and keeps running, after its stdin ends too. */
  | 'ignore_term'
  /** Prints `token=<SLACK_BOT_TOKEN>` on stdout before anything else. */
  | 'secret_banner'
  /** Writes `bad config` to stderr and exits 1. */
  | 'exit_at_once'
  /** Prints `Starting slack server…` on stdout before anything else. */
  | 'banner'
  /** Never answers `initialize`. */
  | 'hang'
  /** Exits during `post`, after its work. */
  | 'die_in_call'
  /** Starts `sleep 60` without `detached`, so it stays in the server's group, and exits once its stdin ends (review Minor 12). */
  | 'leader_exits'
  /** Prints 9 MiB on stdout with no line break, before anything else. */
  | 'flood_stdout'
  /** Answers `initialize` with a JSON-RPC error carrying the timeout's own code (-32001), `warming up`. */
  | 'init_error'
  /** Lists its tools over two pages (`nextCursor`). */
  | 'paged'
  /** Lists one more tool on every page, always with a `nextCursor`. */
  | 'endless_pages';

const SERVER_SOURCE = String.raw`'use strict';
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const BEHAVIOUR = __BEHAVIOUR__;
const logPath = process.argv[2];
function log(event, extra) {
  fs.appendFileSync(logPath, JSON.stringify(Object.assign({ event: event }, extra || {})) + '\n');
}
function send(message) { process.stdout.write(JSON.stringify(message) + '\n'); }
function answer(id, result) { send({ jsonrpc: '2.0', id: id, result: result }); }
function fail(id, code, message) { send({ jsonrpc: '2.0', id: id, error: { code: code, message: message } }); }
function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
function structured(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}
const POSTED = { ok: true, ts: '1700000000.000100' };
const TOOLS = [
  { name: 'env_names', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'post',
    inputSchema: {
      type: 'object',
      properties: { channel: { type: 'string' }, text: { type: 'string' } },
      required: ['channel', 'text'],
    },
    outputSchema: { type: 'object', properties: { ok: { type: 'boolean' }, ts: { type: 'string' } } },
  },
  { name: 'slow_post', inputSchema: { type: 'object', properties: {} } },
  { name: 'post_then_fail', inputSchema: { type: 'object', properties: {} } },
  { name: 'huge', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'bad_output',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'object', properties: { count: { type: 'number' } } },
  },
  { name: 'ask_client', inputSchema: { type: 'object', properties: {} } },
  { name: 'echo_stderr', inputSchema: { type: 'object', properties: {} } },
  { name: 'flood_stderr', inputSchema: { type: 'object', properties: {} } },
  { name: 'rpc_error', inputSchema: { type: 'object', properties: {} } },
  { name: 'progress_slow', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'broken_schema',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'object', $ref: '#/nope' },
  },
  { name: 'broken_input', inputSchema: { type: 'object', $ref: '#/nope' } },
  { name: 'bad_result', inputSchema: { type: 'object', properties: {} } },
];
function toolsPage(cursor) {
  if (BEHAVIOUR === 'paged') {
    return cursor === undefined
      ? { tools: TOOLS.slice(0, 5), nextCursor: 'page-2' }
      : { tools: TOOLS.slice(5) };
  }
  if (BEHAVIOUR === 'endless_pages') {
    const n = cursor === undefined ? 1 : Number(cursor.slice('page-'.length));
    return { tools: [{ name: 'tool_' + n, inputSchema: { type: 'object' } }], nextCursor: 'page-' + (n + 1) };
  }
  return { tools: TOOLS };
}
process.on('exit', function (code) { log('exit', { code: code }); });
if (BEHAVIOUR === 'ignore_term') {
  process.on('SIGTERM', function () { log('term'); });
  // Stays up once its stdin ends too: only a SIGKILL ends it.
  setInterval(function () {}, 1000);
}
if (BEHAVIOUR === 'exit_at_once') {
  process.stderr.write('bad config\n');
  process.exit(1);
}
if (BEHAVIOUR === 'banner') process.stdout.write('Starting slack server…\n');
if (BEHAVIOUR === 'flood_stdout') process.stdout.write('x'.repeat(9 * 1024 * 1024));
if (BEHAVIOUR === 'secret_banner') process.stdout.write('token=' + (process.env.SLACK_BOT_TOKEN || '') + '\n');
if (BEHAVIOUR === 'grandchild' || BEHAVIOUR === 'leader_exits') {
  const child = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
  log('child', { pid: child.pid });
}
if (BEHAVIOUR === 'setsid_child') {
  const child = spawn('/bin/sleep', ['60'], { stdio: 'ignore', detached: true });
  child.unref();
  log('child', { pid: child.pid });
}
if (BEHAVIOUR === 'leader_exits') process.stdin.on('end', function () { process.exit(0); });
let nextId = 1000;
const asked = new Map();
function ask(method, params) {
  const id = nextId++;
  send({ jsonrpc: '2.0', id: id, method: method, params: params });
  return new Promise(function (resolve) { asked.set(id, resolve); });
}
async function callTool(id, params) {
  const name = params.name;
  switch (name) {
    case 'env_names': {
      const cwd = process.cwd();
      return answer(id, structured({ names: Object.keys(process.env).sort(), cwd: cwd, entries: fs.readdirSync(cwd) }));
    }
    case 'post':
      log('work-done');
      if (BEHAVIOUR === 'die_in_call') process.exit(1);
      return answer(id, structured(POSTED));
    case 'slow_post':
      log('start');
      await sleep(1500);
      log('work-done');
      return answer(id, structured(POSTED));
    case 'post_then_fail':
      log('work-done');
      return answer(id, { content: [{ type: 'text', text: 'posted, then failed' }], isError: true });
    case 'huge':
      return answer(id, { content: [{ type: 'text', text: 'x'.repeat(9 * 1024 * 1024) }] });
    case 'bad_result':
      return answer(id, { content: 'not a list' });
    case 'bad_output':
      return answer(id, { content: [{ type: 'text', text: '{"count":"x"}' }], structuredContent: { count: 'x' } });
    case 'ask_client': {
      const asks = [
        ['sampling/createMessage', { messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }], maxTokens: 10 }],
        ['elicitation/create', { message: 'Your name?', requestedSchema: { type: 'object', properties: {} } }],
        ['roots/list', {}],
      ];
      for (const [method, askParams] of asks) {
        const reply = await ask(method, askParams);
        log('asked', { method: method, code: reply.error ? reply.error.code : null });
      }
      return answer(id, structured({ asked: asks.length }));
    }
    case 'echo_stderr': {
      const value = process.env.SLACK_BOT_TOKEN || '';
      for (let i = 0; i < value.length; i += 3) {
        process.stderr.write(value.slice(i, i + 3));
        await sleep(15);
      }
      process.stderr.write('\n');
      return answer(id, structured({ ok: true }));
    }
    case 'flood_stderr': {
      const line = 'e'.repeat(1023) + '\n';
      for (let i = 0; i < 2048; i++) process.stderr.write(line);
      return answer(id, structured({ ok: true }));
    }
    case 'rpc_error':
      log('work-done');
      return fail(id, -32603, 'internal error after post');
    case 'progress_slow': {
      const token = params._meta && params._meta.progressToken !== undefined ? params._meta.progressToken : 'scratch';
      for (let i = 1; i <= 15; i++) {
        await sleep(100);
        send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: i, total: 15 } });
        log('progress');
      }
      return answer(id, structured(POSTED));
    }
    default:
      return fail(id, -32602, 'Tool ' + name + ' not found');
  }
}
function handle(message) {
  if (message.method === undefined) {
    const resolve = asked.get(message.id);
    if (resolve) { asked.delete(message.id); resolve(message); }
    return;
  }
  switch (message.method) {
    case 'initialize':
      // What the client declared it can do: a server reads this to decide what to ask (review M2).
      log('initialize', { capabilities: message.params && message.params.capabilities });
      if (BEHAVIOUR === 'hang') return;
      if (BEHAVIOUR === 'init_error') return fail(message.id, -32001, 'warming up');
      return answer(message.id, {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'scratch', version: '1.0.0' },
      });
    case 'notifications/initialized':
      return log('initialized');
    case 'notifications/cancelled':
      return log('cancelled', { requestId: message.params && message.params.requestId });
    case 'ping':
      return answer(message.id, {});
    case 'tools/list': {
      const cursor = message.params ? message.params.cursor : undefined;
      log('list', { cursor: cursor });
      return answer(message.id, toolsPage(cursor));
    }
    case 'tools/call':
      log('call', { tool: message.params.name });
      return callTool(message.id, message.params);
    default:
      if (message.id !== undefined) fail(message.id, -32601, 'Method not found');
  }
}
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', function (chunk) {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
`;

/** Writes a scratch JSON-RPC stdio server (no dependency) into `dir`; returns its path. */
export function writeScratchServer(dir: string, behaviour: ScratchBehaviour = 'plain'): string {
  const file = path.join(dir, `scratch-${behaviour}.cjs`);
  fs.writeFileSync(file, SERVER_SOURCE.replace('__BEHAVIOUR__', JSON.stringify(behaviour)));
  return file;
}

const SDK_SERVER_SOURCE = String.raw`'use strict';
const fs = require('node:fs');
const { McpServer } = require(__MCP__);
const { StdioServerTransport } = require(__STDIO__);
const { z } = require(__ZOD__);
const logPath = process.argv[2];
function log(event) { fs.appendFileSync(logPath, JSON.stringify({ event: event }) + '\n'); }
const server = new McpServer({ name: 'sdk-scratch', version: '1.0.0' });
server.registerTool('throws', {}, async function () {
  log('work-done');
  throw new Error('rate_limited after post');
});
server.registerTool('breaks_own_schema', { outputSchema: { count: z.number() } }, async function () {
  log('work-done');
  return { content: [{ type: 'text', text: '{"count":"x"}' }], structuredContent: { count: 'x' } };
});
server.connect(new StdioServerTransport());
`;

/**
 * Writes a server built on the SDK's own `McpServer` and `StdioServerTransport`,
 * required by the absolute paths this package resolves (spike E14): `throws`
 * logs its work and throws; `breaks_own_schema` logs its work and returns
 * structured content its own output schema refuses.
 */
export function writeSdkServer(dir: string): string {
  const mcp = require.resolve('@modelcontextprotocol/sdk/server/mcp.js');
  const stdio = require.resolve('@modelcontextprotocol/sdk/server/stdio.js');
  const zod = require.resolve('zod', { paths: [path.dirname(mcp)] });
  const file = path.join(dir, 'sdk-server.cjs');
  fs.writeFileSync(
    file,
    SDK_SERVER_SOURCE.replace('__MCP__', JSON.stringify(mcp))
      .replace('__STDIO__', JSON.stringify(stdio))
      .replace('__ZOD__', JSON.stringify(zod)),
  );
  return file;
}

/** One logged event. */
export interface ScratchEvent {
  event: string;
  /** `initialize`: the capabilities the client declared. */
  capabilities?: unknown;
  tool?: string;
  pid?: number;
  code?: number | null;
  method?: string;
}

/** The events a scratch server logged so far, in order. */
export function eventsIn(logPath: string): ScratchEvent[] {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as ScratchEvent);
}

/** Whether a process with this id exists (a zombie counts until it is reaped). */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Resolves once `check` holds, or throws after `timeoutMs`. */
export async function waitFor(
  check: () => boolean,
  timeoutMs = 5000,
  what = 'a condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * The names a Node process adds to its own environment, given none: on macOS
 * CoreFoundation sets `__CF_USER_TEXT_ENCODING` as the process starts (where
 * `/usr/bin/env`, given the same environment, shows none of it). A scratch
 * server reports these beside what it was given, so they are not the adapter's.
 */
export function namesTheRuntimeAdds(): string[] {
  const out = execFileSync(
    process.execPath,
    ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env)))'],
    { env: {}, encoding: 'utf8' },
  );
  return JSON.parse(out) as string[];
}

/**
 * A `ps` for the adapter's `ps` seam, written into `dir`: `/bin/ps` itself,
 * after `delaySeconds`, or failing (exit 2) when asked for the whole table.
 */
export function writePs(dir: string, options: { delaySeconds?: number; failTable?: true }): string {
  const file = path.join(
    dir,
    `ps-${options.delaySeconds ?? 0}-${options.failTable ? 'fail' : 'ok'}`,
  );
  fs.writeFileSync(
    file,
    [
      '#!/bin/sh',
      options.delaySeconds ? `/bin/sleep ${options.delaySeconds}` : '',
      options.failTable ? 'if [ "$1" = "-A" ]; then exit 2; fi' : '',
      'exec /bin/ps "$@"',
      '',
    ].join('\n'),
  );
  fs.chmodSync(file, 0o755);
  return file;
}

/** A process's start time as `/bin/ps` prints it, as the adapter reads it. */
export function lstartOf(pid: number): string {
  return execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim();
}

/** One request a local HTTP server took: its method, path, JSON-RPC method, and header names. */
export interface HttpRequestEvent {
  event: 'request';
  method: string;
  path: string;
  /** The JSON-RPC method a POST carried. */
  rpc?: string;
  /** Every header's name, lowercased, sorted. */
  headers: string[];
  /** The value of each header the test checks by value. */
  values: Record<string, string>;
  /** An `initialize`'s: the capabilities the client declared (review M2). */
  capabilities?: unknown;
}

export type HttpEvent = HttpRequestEvent | { event: 'work-done' | 'start'; tool: string };

export interface HttpServerOptions {
  /**
   * Destroys the socket after a call's work, before answering: `true` at once, before the answer's
   * headers are written; `'mid-stream'` once its event stream has opened.
   */
  dropAfterWork?: true | 'mid-stream';
  /** Answers every request with this, and nothing else. */
  redirect?: { status: number; location?: string };
  /** How it answers `initialize`: a JSON-RPC error with the timeout's code (`warming up`), never, or with 9 MiB. */
  initialize?: 'error' | 'hang' | 'huge';
}

export interface StartedHttpServer {
  /** `http://127.0.0.1:<port>/mcp` */
  url: string;
  origin: string;
  events: HttpEvent[];
  close(): Promise<void>;
}

const CHECKED_VALUES = ['accept-encoding', 'accept-language', 'sec-fetch-mode', 'user-agent'];

/**
 * A Streamable HTTP MCP server on 127.0.0.1 (rule 5a-servers), built on the
 * SDK's `McpServer` and `StreamableHTTPServerTransport`, stateless (a server
 * and a transport per request), logging every request and each tool's work.
 */
export async function startHttpServer(options: HttpServerOptions = {}): Promise<StartedHttpServer> {
  const events: HttpEvent[] = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const text = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = undefined;
      }
      const rpc =
        body && typeof body === 'object' && 'method' in body
          ? String((body as { method: unknown }).method)
          : undefined;
      const values: Record<string, string> = {};
      for (const name of CHECKED_VALUES) {
        const value = req.headers[name];
        if (typeof value === 'string') values[name] = value;
      }
      for (const name of ['authorization', 'x-api-key'])
        values[name] = name in req.headers ? 'present' : 'absent';
      events.push({
        event: 'request',
        method: req.method ?? '',
        path: req.url ?? '',
        ...(rpc !== undefined ? { rpc } : {}),
        headers: Object.keys(req.headers).sort(),
        values,
        ...(rpc === 'initialize'
          ? { capabilities: (body as { params?: { capabilities?: unknown } }).params?.capabilities }
          : {}),
      });
      if (options.redirect) {
        res.writeHead(
          options.redirect.status,
          options.redirect.location !== undefined ? { location: options.redirect.location } : {},
        );
        res.end();
        return;
      }
      if (rpc === 'initialize' && options.initialize === 'hang') return;
      if (rpc === 'initialize' && options.initialize === 'error') {
        const id = (body as { id: unknown }).id;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32_001, message: 'warming up' } }),
        );
        return;
      }
      if (rpc === 'initialize' && options.initialize === 'huge') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('x'.repeat(9 * 1024 * 1024));
        return;
      }
      const mcp = new McpServer({ name: 'tracker-scratch', version: '1.0.0' });
      const posted = { ok: true, ts: '1700000000.000100' };
      const answer = {
        content: [{ type: 'text' as const, text: JSON.stringify(posted) }],
        structuredContent: posted,
      };
      const outputSchema = { ok: z.boolean(), ts: z.string() };
      mcp.registerTool(
        'post',
        { inputSchema: { channel: z.string().optional() }, outputSchema },
        async () => {
          events.push({ event: 'work-done', tool: 'post' });
          if (options.dropAfterWork === 'mid-stream') {
            await new Promise((resolve) => setTimeout(resolve, 300));
            req.socket.destroy();
          } else if (options.dropAfterWork) req.socket.destroy();
          return answer;
        },
      );
      mcp.registerTool('slow_post', { outputSchema }, async () => {
        events.push({ event: 'start', tool: 'slow_post' });
        await new Promise((resolve) => setTimeout(resolve, 1500));
        events.push({ event: 'work-done', tool: 'slow_post' });
        return answer;
      });
      mcp.registerTool('huge', {}, async () => ({
        content: [{ type: 'text' as const, text: 'x'.repeat(9 * 1024 * 1024) }],
      }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    url: `${origin}/mcp`,
    origin,
    events,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
