/**
 * The engine's MCP client (`McpClientPort`): a session per call. A stdio
 * server is spawned here, detached into a process group of its own, in an
 * empty folder, with an environment built from an allow-list, and ended as a
 * whole afterwards; the SDK is used for the protocol only. The only engine
 * file that imports `@modelcontextprotocol/sdk` (`boundary.test.ts`).
 */
import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolResultSchema,
  ErrorCode,
  type JSONRPCMessage,
  ListToolsResultSchema,
  McpError,
  type RequestId,
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
} from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import type {
  McpCallOutcome,
  McpClientPort,
  McpConnectResult,
  McpServerLaunch,
  McpSession,
  McpToolInfo,
  McpTransport,
  ServerGroup,
} from '../ports';
import { SERVER_ENV_ALLOW_LIST } from '../servers/serverFacts';
import { clipText, formatDuration, maskSecrets } from '../steps/commandIO';
import { Masker } from './runCommand';

/** How long a server's group has between SIGTERM and SIGKILL. */
export const SERVER_KILL_GRACE_MS = 5_000;
/** The largest message a server may send (spike V11: the SDK buffers any size). */
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
/** The most of a server's stderr its `server.log` keeps. */
export const SERVER_LOG_CAP_BYTES = 1024 * 1024;

/** How much of stderr's end is kept in memory, for a reason's last line. */
const STDERR_TAIL_BYTES = 4096;
/** The most of a line a reason quotes. */
const REASON_LINE_CHARS = 300;
/** How much of each stdout line is kept to quote one that is not JSON-RPC. */
const LINE_HEAD_BYTES = 1024;
/** `ps` gets this long. */
const PS_TIMEOUT_MS = 5_000;
/** How long after SIGKILL what is left is counted as having survived. */
const SURVIVOR_CHECK_MS = 200;
/** How often, during the grace, a group is checked for anything left in it. */
const GROUP_POLL_MS = 50;
/** How long a refused connect waits for a server that exited to close its pipes, for its last stderr line. */
const EXIT_SETTLE_MS = 1_000;
/** The most `tools/list` pages read. */
const MAX_TOOL_PAGES = 10;
/** How long an HTTP session's close waits for a notification still going out (a stop's cancel). */
const NOTIFICATION_SETTLE_MS = 2_000;
const LOG_CUT_LINE = Buffer.from('\n…\n');
const EMPTY = Buffer.alloc(0);
/** What a connect stopped part-way says; the engine words it its own way. */
const STOPPED = 'it was stopped';

/** CSI and OSC sequences, then any other escape. */
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]?/g;
/** Every control character but tab. */
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f]/g;

type Kill = (pid: number, signal: NodeJS.Signals) => void;

export interface NodeMcpClientOptions {
  /** The runner's own environment, the allow-list's source: on the desktop the login environment, after its retry. */
  baseEnv(): Promise<NodeJS.ProcessEnv>;
  /** Where each call's empty folder is made (`<workRoot>/call-*`); emptied once when the client is made. */
  workRoot: string;
  /** Test seams. */
  killGraceMs?: number;
  maxMessageBytes?: number;
  /** `ps` by absolute path; default `/bin/ps`, else `/usr/bin/ps`. */
  ps?: string;
  fetch?: typeof fetch;
  /** Default `process.kill`: the seam a row watches to see a quit's `SIGTERM` sent before `abort()` returns (review S5). */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Default `process.platform`: on `win32` the port offers `['http']` only (no process groups, no `/bin/ps`), else `['stdio', 'http']` (review S11). */
  platform?: NodeJS.Platform;
}

/** A byte count as a reason says it: `8 MB` for a whole number of megabytes. */
function sizeWords(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return Number.isInteger(mb) ? `${mb} MB` : `${bytes} bytes`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The client's name and version as `initialize` says them: the engine's own. */
function clientInfo(): { name: string; version: string } {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'),
    ) as { version?: unknown };
    if (typeof manifest.version === 'string') return { name: 'consola', version: manifest.version };
  } catch {
    // An engine without its manifest still says who it is.
  }
  return { name: 'consola', version: '0.0.0' };
}

/** The allow-list's names the runner's environment has (`LC_*`: every name starting `LC_`), then `env`. Nothing else. */
function serverEnvironment(
  base: NodeJS.ProcessEnv,
  env: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const name of Object.keys(base)) {
    const value = base[name];
    if (value === undefined) continue;
    const allowed = SERVER_ENV_ALLOW_LIST.some((entry) =>
      entry.endsWith('*') ? name.startsWith(entry.slice(0, -1)) : name === entry,
    );
    if (allowed) out[name] = value;
  }
  for (const [name, value] of Object.entries(env)) out[name] = value;
  return out;
}

/** An abort signal of its own that follows `parent` until it is let go, so the SDK's listeners on it go with it. */
function following(parent: AbortSignal): { signal: AbortSignal; letGo(): void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent.reason);
  if (parent.aborted) controller.abort(parent.reason);
  else parent.addEventListener('abort', onAbort, { once: true });
  return { signal: controller.signal, letGo: () => parent.removeEventListener('abort', onAbort) };
}

interface ProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
}

/** `ps`, signals and the waits between them: how a server's group is ended. */
class Processes {
  constructor(
    private readonly ps: string,
    private readonly kill: Kill,
    private readonly killGraceMs: number,
  ) {}

  /** A process's start time as `ps` prints it; `''` when there is no such process, undefined when `ps` could not tell. */
  startTime(pid: number): Promise<string | undefined> {
    return new Promise((resolve) => {
      execFile(
        this.ps,
        ['-o', 'lstart=', '-p', String(pid)],
        { timeout: PS_TIMEOUT_MS, encoding: 'utf8' },
        (error, stdout) => {
          if (!error) resolve(stdout.trim());
          // `ps` exits 1, printing nothing, for a process that does not exist.
          else if (typeof error.code === 'number' && !error.killed && stdout.trim() === '')
            resolve('');
          else resolve(undefined);
        },
      );
    });
  }

  /** Every live process's id, parent and group; undefined when `ps` could not tell. Zombies are left out. */
  table(): Promise<ProcessRow[] | undefined> {
    return new Promise((resolve) => {
      execFile(
        this.ps,
        ['-A', '-o', 'pid=,ppid=,pgid=,stat='],
        { timeout: PS_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
        (error, stdout) => {
          if (error) return resolve(undefined);
          const rows: ProcessRow[] = [];
          for (const line of stdout.split('\n')) {
            const [pid, ppid, pgid, stat] = line.trim().split(/\s+/);
            if (!pid || stat?.startsWith('Z')) continue;
            rows.push({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid) });
          }
          resolve(rows);
        },
      );
    });
  }

  /** Signals a process (or, negative, a group); false when there is none. */
  signal(target: number, name: NodeJS.Signals): boolean {
    try {
      this.kill(target, name);
      return true;
    } catch {
      return false;
    }
  }

  alive(target: number): boolean {
    try {
      process.kill(target, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  /**
   * Ends a group and what its leader started outside it: the descendants by
   * parent id from `table` (read before any signal, review S6), `SIGTERM` to
   * the group and to each of them, up to the grace for them to go, `SIGKILL`
   * to whatever is left, and how many were still alive just after.
   */
  async end(
    pgid: number,
    leader: number,
    before?: ProcessRow[] | undefined,
  ): Promise<{ survivors: number }> {
    const table = before ?? (await this.table()) ?? [];
    const outside = descendantsOf(table, leader)
      .filter((row) => row.pgid !== pgid)
      .map((row) => row.pid);
    this.signal(-pgid, 'SIGTERM');
    for (const pid of outside) this.signal(pid, 'SIGTERM');
    const left = () => this.alive(-pgid) || outside.some((pid) => this.alive(pid));
    const deadline = Date.now() + this.killGraceMs;
    while (left() && Date.now() < deadline) await sleep(GROUP_POLL_MS);
    if (!left()) return { survivors: 0 };
    this.signal(-pgid, 'SIGKILL');
    for (const pid of outside) if (this.alive(pid)) this.signal(pid, 'SIGKILL');
    await sleep(SURVIVOR_CHECK_MS);
    const after = (await this.table()) ?? [];
    return {
      survivors: after.filter((row) => row.pgid === pgid || outside.includes(row.pid)).length,
    };
  }
}

/** Every process descended from `pid` in `table`, at any depth. */
function descendantsOf(table: readonly ProcessRow[], pid: number): ProcessRow[] {
  const found: ProcessRow[] = [];
  const parents = [pid];
  const seen = new Set([pid]);
  while (parents.length > 0) {
    const parent = parents.pop() as number;
    for (const row of table) {
      if (row.ppid !== parent || seen.has(row.pid)) continue;
      seen.add(row.pid);
      found.push(row);
      parents.push(row.pid);
    }
  }
  return found;
}

/**
 * A server's stderr: masked across chunks, kept whole in `server.log` up to
 * its cap (then a final `…` line), and its last 4 KB in memory for a reason.
 */
class StderrSink {
  private readonly masker: Masker;
  private tail = EMPTY;
  private tailCutsLine = false;
  private fd: number | undefined;
  private written = 0;
  private capped = false;
  private ended = false;

  constructor(
    private readonly masks: readonly string[],
    logPath: string | undefined,
  ) {
    this.masker = new Masker(masks);
    if (logPath === undefined) return;
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      this.fd = fs.openSync(logPath, 'a');
    } catch {
      // A log that cannot be opened is a log not kept; the reason still has the tail.
    }
  }

  write(chunk: Buffer): void {
    if (!this.ended) this.emit(this.masker.push(chunk));
  }

  end(): void {
    if (this.ended) return;
    this.emit(this.masker.flush());
    this.ended = true;
    if (this.fd !== undefined) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // already closed
      }
    }
  }

  /** The last non-blank line, as plain text, masked again and clipped. */
  lastLine(): string | undefined {
    const lines = this.tail.toString('utf8').split('\n');
    // A line cut by the tail's start is not that line's start.
    if (this.tailCutsLine) lines.shift();
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = maskSecrets(
        lines[i].replace(ESCAPES, '').replace(CONTROLS, ''),
        this.masks,
      ).trim();
      if (line) return clipText(line, REASON_LINE_CHARS);
    }
    return undefined;
  }

  private emit(bytes: Buffer): void {
    if (bytes.length === 0) return;
    const joined = Buffer.concat([this.tail, bytes]);
    const start = Math.max(0, joined.length - STDERR_TAIL_BYTES);
    if (start > 0) this.tailCutsLine = joined[start - 1] !== 0x0a;
    this.tail = Buffer.from(joined.subarray(start));
    if (this.fd === undefined || this.capped) return;
    const room = SERVER_LOG_CAP_BYTES - this.written;
    const piece = bytes.length > room ? bytes.subarray(0, room) : bytes;
    try {
      writeAll(this.fd, piece);
      this.written += piece.length;
      if (bytes.length > room) {
        writeAll(this.fd, LOG_CUT_LINE);
        this.capped = true;
      }
    } catch {
      this.capped = true;
    }
  }
}

function writeAll(fd: number, bytes: Buffer): void {
  for (let offset = 0; offset < bytes.length; )
    offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
}

/** The first bytes of each stdout line, kept in step with `ReadBuffer`, so a line that is not JSON-RPC can be quoted. */
class LineHeads {
  private readonly complete: string[] = [];
  private partial = EMPTY;

  push(chunk: Buffer): void {
    let start = 0;
    for (;;) {
      const at = chunk.indexOf(0x0a, start);
      this.grow(chunk.subarray(start, at === -1 ? chunk.length : at));
      if (at === -1) return;
      this.complete.push(this.partial.toString('utf8').replace(/\r$/, ''));
      this.partial = EMPTY;
      start = at + 1;
    }
  }

  /** The line `ReadBuffer` just read as a message. */
  consume(): void {
    this.complete.shift();
  }

  /** The line `ReadBuffer` failed on. */
  current(): string {
    return this.complete[0] ?? '';
  }

  private grow(piece: Buffer): void {
    if (this.partial.length < LINE_HEAD_BYTES)
      this.partial = Buffer.concat([
        this.partial,
        piece.subarray(0, LINE_HEAD_BYTES - this.partial.length),
      ]);
  }
}

/** Why a transport closed itself. */
type TransportProblem = { kind: 'too-large' } | { kind: 'not-json-rpc'; line: string };

/** A transport over a spawned server's pipes: `ReadBuffer` (capped) in, `serializeMessage` out. */
class ChildTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  problem: TransportProblem | undefined;
  private readonly buffer: ReadBuffer;
  private readonly lines = new LineHeads();
  private closed = false;
  private started = false;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    maxMessageBytes: number,
  ) {
    this.buffer = new ReadBuffer({ maxBufferSize: maxMessageBytes });
    child.stdout.once('end', () => this.finish());
    child.stdout.once('close', () => this.finish());
  }

  async start(): Promise<void> {
    this.started = true;
    if (this.closed) {
      this.onclose?.();
      return;
    }
    this.child.stdout.on('data', this.onData);
  }

  send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) return Promise.reject(new Error('the connection is closed'));
    return new Promise((resolve, reject) => {
      this.child.stdin.write(serializeMessage(message), (error) =>
        error ? reject(error) : resolve(),
      );
    });
  }

  async close(): Promise<void> {
    this.finish();
  }

  private readonly onData = (chunk: Buffer): void => {
    if (this.closed) return;
    try {
      this.buffer.append(chunk);
    } catch {
      this.problem = { kind: 'too-large' };
      this.finish();
      return;
    }
    this.lines.push(chunk);
    for (;;) {
      let message: JSONRPCMessage | null;
      try {
        message = this.buffer.readMessage();
      } catch {
        this.problem = { kind: 'not-json-rpc', line: this.lines.current() };
        this.finish();
        return;
      }
      if (message === null) return;
      this.lines.consume();
      this.onmessage?.(message);
      if (this.closed) return;
    }
  };

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.child.stdout.off('data', this.onData);
    this.buffer.clear();
    try {
      this.child.stdin.end();
    } catch {
      // its pipe is gone already
    }
    if (this.started) this.onclose?.();
  }
}

/** What one call's request met on the wire: the id it went out with, and what answered it. */
interface CallWatch {
  id?: RequestId;
  error?: { code: number; message: string };
  resulted?: boolean;
}

/**
 * Watches a transport's traffic beside the SDK (its handlers chain onto what
 * is set before `connect`), so a server's JSON-RPC error answer is told from
 * an error the SDK made for a timeout or a closed connection (review S2).
 */
function watchTraffic(transport: Transport): {
  begin(): CallWatch;
  /** The message of the last JSON-RPC error the server answered with, in its own words. */
  serverError(): string | undefined;
  /** Whether the request sent with `id` has had no answer yet. */
  awaiting(id: RequestId): boolean;
  /** Resolves once every notification being sent has gone out, or after `ms`. */
  notificationsSent(ms: number): Promise<void>;
} {
  let current: CallWatch | undefined;
  let lastError: string | undefined;
  const pending = new Set<RequestId>();
  const notifying = new Set<Promise<void>>();
  const send = transport.send.bind(transport);
  transport.send = (message, options) => {
    if (isJSONRPCRequest(message)) {
      pending.add(message.id);
      if (current && current.id === undefined && message.method === 'tools/call')
        current.id = message.id;
    }
    const sent = send(message, options);
    if (!('id' in message)) {
      const settled = sent.then(
        () => undefined,
        () => undefined,
      );
      notifying.add(settled);
      void settled.then(() => notifying.delete(settled));
    }
    return sent;
  };
  transport.onmessage = (message) => {
    if (isJSONRPCErrorResponse(message)) {
      lastError = message.error.message;
      if (message.id !== undefined) pending.delete(message.id);
      if (current && current.id !== undefined && message.id === current.id)
        current.error = { code: message.error.code, message: message.error.message };
    } else if (isJSONRPCResultResponse(message)) {
      pending.delete(message.id);
      if (current && current.id !== undefined && message.id === current.id) current.resulted = true;
    }
  };
  return {
    begin: () => {
      current = {};
      return current;
    },
    serverError: () => lastError,
    awaiting: (id) => pending.has(id),
    notificationsSent: (ms) =>
      Promise.race([Promise.all([...notifying]).then(() => undefined), sleep(ms)]),
  };
}

type Watch = ReturnType<typeof watchTraffic>;

/** An error the adapter makes when connecting's budget is spent between requests. */
class BudgetSpent extends Error {}

async function listTools(
  client: Client,
  remaining: () => number,
  signal: AbortSignal,
): Promise<McpToolInfo[]> {
  const tools: McpToolInfo[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOL_PAGES; page++) {
    if (remaining() <= 0) throw new BudgetSpent();
    // Never `client.listTools`, which compiles every listed output schema (Call 7, review S12).
    const result = await client.request(
      { method: 'tools/list', params: cursor === undefined ? {} : { cursor } },
      ListToolsResultSchema,
      { timeout: remaining(), signal },
    );
    for (const tool of result.tools)
      tools.push({
        name: tool.name,
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
      });
    cursor = result.nextCursor;
    if (cursor === undefined) break;
  }
  return tools;
}

/** Whether `args` fit `tool`'s input schema; with `partial`, its top-level `required` narrowed to the keys given. */
function checkArgumentsWith(
  validator: AjvJsonSchemaValidator,
  tool: McpToolInfo,
  args: Readonly<Record<string, unknown>>,
  options?: { partial?: true },
): string | null {
  const schema = tool.inputSchema;
  if (schema === undefined || schema === null || typeof schema !== 'object') return null;
  let effective = schema as Record<string, unknown>;
  if (options?.partial && Array.isArray(effective.required)) {
    const given = Object.keys(args);
    effective = {
      ...effective,
      required: effective.required.filter((name) => given.includes(String(name))),
    };
  }
  let check: ReturnType<AjvJsonSchemaValidator['getValidator']>;
  try {
    check = validator.getValidator(
      effective as Parameters<AjvJsonSchemaValidator['getValidator']>[0],
    );
  } catch (error) {
    return `its input schema could not be read (${messageOf(error)})`;
  }
  const result = check(args);
  return result.valid ? null : (result.errorMessage ?? 'its arguments do not fit its input schema');
}

/** The session side every transport shares: a call's outcome, never a rejection, and never sent twice. */
async function callOver(input: {
  client: Client;
  watch: ReturnType<typeof watchTraffic>;
  problem: () => TransportProblem | undefined;
  masks: readonly string[];
  maxMessageBytes: number;
  tool: string;
  args: Readonly<Record<string, unknown>>;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<McpCallOutcome> {
  const { client, watch, tool, args, timeoutMs, signal, masks } = input;
  const unanswered = (
    why: Extract<McpCallOutcome, { kind: 'unanswered' }>['why'],
    detail: string,
  ): McpCallOutcome => ({ kind: 'unanswered', why, detail: maskSecrets(detail, masks) });
  const state = watch.begin();
  const link = following(signal);
  try {
    const result = await client.request(
      { method: 'tools/call', params: { name: tool, arguments: { ...args } } },
      CallToolResultSchema,
      {
        timeout: timeoutMs,
        maxTotalTimeout: timeoutMs,
        resetTimeoutOnProgress: false,
        signal: link.signal,
      },
    );
    return {
      kind: 'answered',
      isError: result.isError === true,
      ...(result.structuredContent !== undefined
        ? { structuredContent: result.structuredContent }
        : {}),
      content: result.content,
      bytes: Buffer.byteLength(JSON.stringify(result)),
    };
  } catch (error) {
    // The SDK wraps an abort as a timeout (review Minor 2): the signal is asked first.
    if (signal.aborted) return unanswered('stopped', STOPPED);
    if (state.error)
      return {
        kind: 'answered',
        isError: true,
        content: [{ type: 'text', text: state.error.message }],
        bytes: Buffer.byteLength(JSON.stringify(state.error)),
      };
    if (input.problem()?.kind === 'too-large')
      return unanswered('too-large', `its answer was over ${sizeWords(input.maxMessageBytes)}`);
    if (state.resulted) return unanswered('unreadable', messageOf(error));
    if (error instanceof McpError && error.code === ErrorCode.RequestTimeout)
      return unanswered('timeout', messageOf(error));
    return unanswered('closed', messageOf(error));
  } finally {
    link.letGo();
  }
}

/** Starts the protocol over `transport` and lists the tools, both within the launch's budget from `started`. Throws what failed. */
async function initializeAndList(
  client: Client,
  transport: Transport,
  launch: McpServerLaunch,
  started: number,
  signal: AbortSignal,
): Promise<McpToolInfo[]> {
  const remaining = () => launch.timeoutMs - (Date.now() - started);
  if (remaining() <= 0) throw new BudgetSpent();
  await client.connect(transport, { timeout: remaining(), signal });
  return listTools(client, remaining, signal);
}

/** Whether a connect failed on its budget: spent, or the SDK's own timeout, never a server's answer carrying the timeout's code. */
function timedOut(error: unknown, serverError: string | undefined): boolean {
  return (
    error instanceof BudgetSpent ||
    (error instanceof McpError &&
      error.code === ErrorCode.RequestTimeout &&
      serverError === undefined)
  );
}

/**
 * An abort's listener: a quit runs `quit` (stdio: the group's SIGTERM) at
 * once, inside the listener, before anything is awaited (review S5); then,
 * for any abort, the session closes on the next turn, after the SDK has sent
 * `notifications/cancelled` in the same dispatch.
 */
function abortListener(
  signal: AbortSignal,
  session: () => McpSession | undefined,
  quit?: () => void,
): () => void {
  return () => {
    if (signal.reason === 'quit') quit?.();
    const open = session();
    if (open) setImmediate(() => void open.close());
  };
}

/** The session every transport gives: `call` never rejects, and sends nothing once the session is closing. */
function sessionOver(input: {
  client: Client;
  watch: Watch;
  tools: McpToolInfo[];
  launch: McpServerLaunch;
  maxMessageBytes: number;
  problem: () => TransportProblem | undefined;
  onAbort: (signal: AbortSignal) => () => void;
  closing: () => boolean;
  close: () => Promise<{ survivors: number }>;
}): McpSession {
  const { launch } = input;
  const validator = new AjvJsonSchemaValidator();
  return {
    tools: input.tools,
    checkArguments: (tool, args, options) => checkArgumentsWith(validator, tool, args, options),
    async call(tool, args, options) {
      if (input.closing())
        return { kind: 'unanswered', why: 'closed', detail: 'the session was closed' };
      const onCallAbort = input.onAbort(options.signal);
      if (options.signal !== launch.signal)
        options.signal.addEventListener('abort', onCallAbort, { once: true });
      try {
        return await callOver({
          client: input.client,
          watch: input.watch,
          problem: input.problem,
          masks: launch.masks,
          maxMessageBytes: input.maxMessageBytes,
          tool,
          args,
          timeoutMs: options.timeoutMs,
          signal: options.signal,
        });
      } finally {
        options.signal.removeEventListener('abort', onCallAbort);
      }
    },
    close: input.close,
  };
}

interface ClientContext {
  baseEnv(): Promise<NodeJS.ProcessEnv>;
  workRoot: string;
  maxMessageBytes: number;
  processes: Processes;
  info: { name: string; version: string };
  fetch: typeof fetch;
}

/** Starts a stdio server for one call: spawn, record, initialize, list. Never rejects. */
async function connectStdio(
  launch: Extract<McpServerLaunch, { transport: 'stdio' }>,
  context: ClientContext,
): Promise<McpConnectResult> {
  const started = Date.now();
  const masks = launch.masks;
  const masked = (text: string) => maskSecrets(text, masks);
  if (launch.signal.aborted) return { ok: false, reason: STOPPED };
  let folder: string;
  let env: NodeJS.ProcessEnv;
  try {
    fs.mkdirSync(context.workRoot, { recursive: true });
    folder = fs.mkdtempSync(path.join(context.workRoot, 'call-'));
  } catch (error) {
    return { ok: false, reason: masked(`its folder could not be made (${messageOf(error)})`) };
  }
  const removeFolder = () => fs.rmSync(folder, { recursive: true, force: true });
  try {
    env = serverEnvironment(await context.baseEnv(), launch.env);
  } catch (error) {
    removeFolder();
    return { ok: false, reason: masked(`its environment could not be read (${messageOf(error)})`) };
  }
  if (launch.signal.aborted) {
    removeFolder();
    return { ok: false, reason: STOPPED };
  }

  // No shell; a bare name is found on the PATH it is given (Call 25).
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(launch.command, [...launch.args], {
      cwd: folder,
      env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    removeFolder();
    return { ok: false, reason: masked(messageOf(error)) };
  }
  const spawnFailed = new Promise<Error>((resolve) => child.once('error', resolve));
  child.on('error', () => undefined);
  child.stdin.on('error', () => undefined);
  child.stdout.on('error', () => undefined);
  child.stderr.on('error', () => undefined);
  if (child.pid === undefined) {
    const error = await spawnFailed;
    removeFolder();
    return { ok: false, reason: masked(messageOf(error)) };
  }
  const pid = child.pid;
  const pgid = pid;
  const processes = context.processes;

  const stderr = new StderrSink(masks, launch.logPath);
  child.stderr.on('data', (chunk: Buffer) => stderr.write(chunk));
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  child.once('exit', (code, signal) => {
    exit = { code, signal };
  });
  const pipesClosed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const settled = (ms: number) => Promise.race([pipesClosed, sleep(ms)]);

  // A quit signals the group inside the abort listener, before anything is awaited (review S5).
  let quitSent = false;
  const quit = () => {
    if (quitSent) return;
    quitSent = true;
    processes.signal(-pgid, 'SIGTERM');
  };
  let session: McpSession | undefined;
  const onAbort = (signal: AbortSignal) => abortListener(signal, () => session, quit);
  const onLaunchAbort = onAbort(launch.signal);
  launch.signal.addEventListener('abort', onLaunchAbort, { once: true });

  const transport = new ChildTransport(child, context.maxMessageBytes);
  const watch = watchTraffic(transport);
  const client = new Client(context.info);
  let ending: Promise<{ survivors: number }> | undefined;
  const endAll = () => {
    ending ??= (async () => {
      launch.signal.removeEventListener('abort', onLaunchAbort);
      const table = await processes.table();
      await client.close().catch(() => undefined);
      const result = await processes.end(pgid, pid, table);
      await settled(500);
      stderr.end();
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
      try {
        removeFolder();
      } catch {
        // A folder that cannot be removed is emptied at the next client.
      }
      return result;
    })();
    return ending;
  };
  const refuse = async (reason: string): Promise<McpConnectResult> => {
    await endAll();
    return { ok: false, reason: masked(reason) };
  };

  const startedAt = (await processes.startTime(pid)) ?? '';
  if (launch.signal.aborted) return refuse(STOPPED);
  try {
    // Durably, before `initialize` (m8): a rejection ends the server and refuses the connect.
    await launch.onSpawned?.({ pgid, startedAt });
  } catch (error) {
    return refuse(messageOf(error));
  }
  if (launch.signal.aborted) return refuse(STOPPED);

  const link = following(launch.signal);
  let tools: McpToolInfo[];
  try {
    tools = await initializeAndList(client, transport, launch, started, link.signal);
  } catch (error) {
    link.letGo();
    if (launch.signal.aborted) return refuse(STOPPED);
    const problem = transport.problem;
    if (problem?.kind === 'not-json-rpc')
      return refuse(
        `it printed something that is not JSON-RPC on stdout: ${clipText(problem.line.replace(ESCAPES, '').replace(CONTROLS, '').trim(), REASON_LINE_CHARS)}`,
      );
    if (problem?.kind === 'too-large')
      return refuse(`it sent a message over ${sizeWords(context.maxMessageBytes)}`);
    // A server may answer with the timeout's own code: its answer is not a timeout.
    const serverError = watch.serverError();
    if (timedOut(error, serverError)) {
      const line = stderr.lastLine();
      return refuse(
        `it did not answer within ${formatDuration(launch.timeoutMs)}${line ? `: ${line}` : ''}`,
      );
    }
    if (serverError !== undefined) return refuse(`it answered with an error: ${serverError}`);
    await settled(EXIT_SETTLE_MS);
    if (exit) {
      stderr.end();
      const line = stderr.lastLine();
      const how = exit.code !== null ? `code ${exit.code}` : `signal ${exit.signal}`;
      return refuse(`it exited (${how}) before answering${line ? `: ${line}` : ''}`);
    }
    return refuse(messageOf(error));
  }
  link.letGo();

  session = sessionOver({
    client,
    watch,
    tools,
    launch,
    maxMessageBytes: context.maxMessageBytes,
    problem: () => transport.problem,
    onAbort,
    closing: () => ending !== undefined,
    close: endAll,
  });
  return { ok: true, session };
}

/** A redirect the adapter's own `fetch` refused: its message is the whole sentence (Call 20). */
class RedirectRefused extends Error {}

/** The redirect's sentence, naming the origin it pointed at when it named one. */
function redirectSentence(location: string | null, from: string): string {
  if (location !== null) {
    try {
      const origin = new URL(location, from).origin;
      return `The server answered with a redirect to \`${origin}\`; Consola does not follow redirects. Point \`url\` at the final address.`;
    } catch {
      // A Location that is not a URL names nothing.
    }
  }
  return 'The server answered with a redirect; Consola does not follow redirects. Point `url` at the final address.';
}

/** The id of the JSON-RPC request a POST carries, if it carries one. */
function requestIdOf(body: unknown): RequestId | undefined {
  if (typeof body !== 'string') return undefined;
  try {
    const message: unknown = JSON.parse(body);
    return isJSONRPCRequest(message) ? message.id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The HTTP transport's `fetch` (Call 20, review M2): every request goes out
 * with `redirect: 'manual'`, and any 3xx is refused before the SDK sees it,
 * since the SDK's own policy follows a same-origin redirect. Every body is
 * read through a count that errors past the cap; a POST's body that breaks
 * names the request it carried.
 */
function refusingFetch(
  base: typeof fetch,
  cap: number,
  hooks: { broken(id: RequestId): void; tooLarge(): void },
): FetchLike {
  return async (url, init) => {
    const response = await base(url, { ...init, redirect: 'manual' });
    if (response.status >= 300 && response.status <= 399) {
      await response.body?.cancel().catch(() => undefined);
      throw new RedirectRefused(redirectSentence(response.headers.get('location'), String(url)));
    }
    if (!response.body) return response;
    const carried = init?.method === 'POST' ? requestIdOf(init.body) : undefined;
    const reader = response.body.getReader();
    let seen = 0;
    const counted = new ReadableStream<Uint8Array>({
      async pull(controller) {
        let next: Awaited<ReturnType<typeof reader.read>>;
        try {
          next = await reader.read();
        } catch (error) {
          if (carried !== undefined) hooks.broken(carried);
          controller.error(error);
          return;
        }
        if (next.done) {
          controller.close();
          return;
        }
        seen += next.value.byteLength;
        if (seen > cap) {
          hooks.tooLarge();
          void reader.cancel().catch(() => undefined);
          controller.error(new Error(`its answer was over ${sizeWords(cap)}`));
          return;
        }
        controller.enqueue(next.value);
      },
      cancel: (reason) => reader.cancel(reason),
    });
    return new Response(counted, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/** Why a request failed, with what `fetch` gave as its cause (`fetch failed (ECONNREFUSED)`). */
function failureWords(error: unknown): string {
  const cause =
    error instanceof Error ? (error as { cause?: { code?: unknown } }).cause : undefined;
  const code = cause && typeof cause.code === 'string' ? cause.code : undefined;
  return code ? `${messageOf(error)} (${code})` : messageOf(error);
}

/** Calls a Streamable HTTP server for one call: initialize, list. Never rejects. */
async function connectHttp(
  launch: Extract<McpServerLaunch, { transport: 'http' }>,
  context: ClientContext,
): Promise<McpConnectResult> {
  const started = Date.now();
  const masked = (text: string) => maskSecrets(text, launch.masks);
  if (launch.signal.aborted) return { ok: false, reason: STOPPED };
  let problem: TransportProblem | undefined;
  const broken = new Set<RequestId>();
  // Its rendered headers and nothing else of the machine's; never a redirect, never a resend.
  const transport = new StreamableHTTPClientTransport(new URL(launch.url), {
    requestInit: { headers: { ...launch.headers } },
    fetch: refusingFetch(context.fetch, context.maxMessageBytes, {
      broken: (id) => broken.add(id),
      tooLarge: () => {
        problem ??= { kind: 'too-large' };
      },
    }),
    // A stream that breaks is never resumed, so nothing is asked of the server again (spike E9b).
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1_000,
      maxReconnectionDelay: 1_000,
      reconnectionDelayGrowFactor: 1,
    },
  });
  const watch = watchTraffic(transport);
  // An answer's body broke, or went past the cap, before its request was answered: that answer
  // can no longer come, so the connection is closed, and the request ends with it rather than at
  // its timeout. The SDK reports a broken stream only here (it resumes none, `maxRetries: 0`).
  transport.onerror = () => {
    if (problem?.kind === 'too-large' || [...broken].some((id) => watch.awaiting(id)))
      void transport.close();
  };
  const client = new Client(context.info);
  let session: McpSession | undefined;
  const onAbort = (signal: AbortSignal) => abortListener(signal, () => session);
  const onLaunchAbort = onAbort(launch.signal);
  launch.signal.addEventListener('abort', onLaunchAbort, { once: true });
  let ending: Promise<{ survivors: number }> | undefined;
  const endAll = () => {
    ending ??= (async () => {
      launch.signal.removeEventListener('abort', onLaunchAbort);
      // Over HTTP a stop's `notifications/cancelled` is a request of its own: it goes out before the connection closes.
      await watch.notificationsSent(NOTIFICATION_SETTLE_MS);
      await client.close().catch(() => undefined);
      return { survivors: 0 };
    })();
    return ending;
  };
  const refuse = async (reason: string, whole?: true): Promise<McpConnectResult> => {
    await endAll();
    return { ok: false, reason: masked(reason), ...(whole ? { whole } : {}) };
  };

  const link = following(launch.signal);
  let tools: McpToolInfo[];
  try {
    tools = await initializeAndList(client, transport, launch, started, link.signal);
  } catch (error) {
    link.letGo();
    if (launch.signal.aborted) return refuse(STOPPED);
    if (error instanceof RedirectRefused) return refuse(error.message, true);
    if (problem?.kind === 'too-large')
      return refuse(`it sent a message over ${sizeWords(context.maxMessageBytes)}`);
    const serverError = watch.serverError();
    if (timedOut(error, serverError))
      return refuse(`it did not answer within ${formatDuration(launch.timeoutMs)}`);
    if (serverError !== undefined) return refuse(`it answered with an error: ${serverError}`);
    return refuse(clipText(failureWords(error), REASON_LINE_CHARS));
  }
  link.letGo();

  session = sessionOver({
    client,
    watch,
    tools,
    launch,
    maxMessageBytes: context.maxMessageBytes,
    problem: () => problem,
    onAbort,
    closing: () => ending !== undefined,
    close: endAll,
  });
  return { ok: true, session };
}

/** Removes the call folders a client made before (`call-*`), and nothing else. */
function emptyWorkRoot(workRoot: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(workRoot);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith('call-')) continue;
    try {
      fs.rmSync(path.join(workRoot, entry), { recursive: true, force: true });
    } catch {
      // left for the next client
    }
  }
}

export function nodeMcpClient(options: NodeMcpClientOptions): McpClientPort {
  const platform = options.platform ?? process.platform;
  const transports: readonly McpTransport[] = platform === 'win32' ? ['http'] : ['stdio', 'http'];
  const processes = new Processes(
    options.ps ?? (fs.existsSync('/bin/ps') ? '/bin/ps' : '/usr/bin/ps'),
    options.kill ?? ((pid, signal) => process.kill(pid, signal)),
    options.killGraceMs ?? SERVER_KILL_GRACE_MS,
  );
  const context: ClientContext = {
    baseEnv: options.baseEnv,
    workRoot: options.workRoot,
    maxMessageBytes: options.maxMessageBytes ?? MAX_MESSAGE_BYTES,
    processes,
    info: clientInfo(),
    fetch: options.fetch ?? fetch,
  };
  emptyWorkRoot(options.workRoot);
  return {
    transports,
    async connect(launch) {
      try {
        if (launch.transport === 'stdio') {
          if (!transports.includes('stdio'))
            return { ok: false, reason: 'this runner cannot start stdio servers' };
          return await connectStdio(launch, context);
        }
        return await connectHttp(launch, context);
      } catch (error) {
        return { ok: false, reason: maskSecrets(messageOf(error), launch.masks) };
      }
    },
    async endOrphan(group: ServerGroup) {
      // A group recorded without its start time could be anyone's by now: never signalled.
      if (group.startedAt === '') return 'unknown';
      const now = await processes.startTime(group.pgid);
      if (now === undefined) return 'unknown';
      if (now === '') {
        // Its leader is gone; members left in the group are that group, whose id is not handed out again while it has any.
        const table = await processes.table();
        if (!table) return 'unknown';
        if (!table.some((row) => row.pgid === group.pgid)) return 'gone';
        await processes.end(group.pgid, group.pgid, table);
        return 'ended';
      }
      // Another start time: the id was handed out again, so it is never signalled.
      if (now !== group.startedAt) return 'gone';
      await processes.end(group.pgid, group.pgid);
      return 'ended';
    },
  };
}
