#!/usr/bin/env node
// A stub `claude` for automation steps. Never contacts a model.
//
// Plain Node, no dependencies. `node` is not on the app's PATH in e2e, so a
// spec runs it through a generated `#!/bin/sh` wrapper that execs the test
// runner's own Node on this file with every argument.
//
//   --version            prints `2.0.0 (Claude Code)` (the health probe); logs nothing
//   --input-format …     the control protocol (below) when STUB_CLAUDE_MCP or
//                        STUB_CLAUDE_COMMANDS is set; else exits 1: the capabilities
//                        probe is refused, so it neither counts as a launch nor waits
//                        out its timeout
//   anything else        appends `<cwd> :: <argv>` to STUB_CLAUDE_LOG (newlines
//                        flattened), then:
//   -p (print mode)      reads `--mcp-config <path>`, spawns its `mcpServers.consola`
//                        (command, args, env over this process's env) and speaks MCP
//                        to it: newline-delimited JSON-RPC, `initialize` (protocol
//                        2025-06-18), `notifications/initialized`, then `tools/call`
//                        - consola_write_artifact { name: 'handover', content }
//                          when the STUB_CLAUDE_HANDOVER file exists,
//                        - consola_set_outputs { outputs } when the STUB_CLAUDE_OUTPUTS
//                          file holds JSON,
//                        logging `TOOL <name> <first line of the result>` for each.
//                        Before those, with STUB_CLAUDE_READS, it reads each document
//                        named there (below) and logs what came back.
//                        Both files are read again on every launch, so a resumed turn
//                        (a reminder) acts on what they hold by then. It writes a
//                        transcript where Claude would,
//                        $CLAUDE_CONFIG_DIR/projects/p/<id>.jsonl (the id from
//                        --session-id, else --resume): the prompt (after `--`), then
//                        `FINDINGS: done`. Then it prints `FINDINGS: done` and exits 0.
//                        Its last log line is `END <id> exit <code>`: the turn is over.
//   -p --output-format stream-json
//                        the same turn, reported as the real CLI reports a step's turn
//                        (below). Without that flag nothing of this changes, so every
//                        caller that passes none behaves exactly as before.
//   otherwise            shows an empty composer (`❯ `) and sleeps; with STUB_CLAUDE_CALLS
//                        (below) it first makes those calls, as an agent in a session would.
//
// A planned call that fails fails the turn, loudly. A tool answer with
// `isError: true` (how a server reports a failed tool) or a rejected call is
// logged as `TOOL <name> ERROR <first line>`; a server that cannot be reached
// as `MCP <what went wrong>`. The remaining calls are still made, then the
// turn writes no findings, prints nothing to stdout, says so on stderr, and
// exits 1 (in stream-json the result says so instead, below). A launch that
// plans no call (neither file usable) is not a failure.
//
// Stream-json (print mode with `--output-format stream-json`), one JSON line each:
//   first, before any hold or gate, `system`/`init`: `session_id`, `model`
//   (STUB_CLAUDE_MODEL, else `claude-stub-1`), `mcp_servers` (`consola`, connected,
//   then the STUB_CLAUDE_MCP servers that load, below, each with its knob status),
//   `tools` (`Read`, `Grep`, `Glob`, `Skill` when `--tools` lists it, then
//   `mcp__<server>__<tool>` for each loaded server's tools, both names with every
//   character outside [A-Za-z0-9_-] as `_`) and, with `--plugin-dir`, `skills` (its
//   `consola-step:<n>`); then the hooks STUB_CLAUDE_HOOKS_FILE names, but StopFailure; then
//   STUB_CLAUDE_HOLD; then the turn as above, with an `assistant` event holding one
//   `tool_use` named `mcp__consola__<tool>` before each tool it calls; then
//   STUB_CLAUDE_LIMIT's event, STUB_CLAUDE_STDERR's line and the StopFailure hook; last,
//   `result`, its first key `duration_api_ms` as the real CLI's: `subtype`
//   (STUB_CLAUDE_SUBTYPE, else `success`); `is_error` when that is not `success`, the
//   limit is set or a call failed; `num_turns` (STUB_CLAUDE_TURNS, else 3);
//   `total_cost_usd` (STUB_CLAUDE_COST, else 0.0123); `result`, the limit's text, else
//   the failed call's line, else `FINDINGS: done`, and absent for `error_max_turns`;
//   `permission_denials` (STUB_CLAUDE_DENIED). It exits 1 when `is_error`, else 0. The
//   transcript and the `END` line are written as in text mode. A knob below that is
//   only for stream-json does nothing in text mode, and none logs a line unless set.
//
// Env knobs:
//   STUB_CLAUDE_LOG=path        the launch and tool log above
//   STUB_CLAUDE_HANDOVER=path   the handover to write (Markdown); absent file: none
//   STUB_CLAUDE_OUTPUTS=path    the outputs to set, as JSON; absent or not JSON: none
//   STUB_CLAUDE_OUTPUTS_SEQ=path  a JSON array of outputs objects: each launch sets entry n
//                               (n from `<path>.n`, absent 0; past the end, the last) as
//                               STUB_CLAUDE_OUTPUTS would, and writes n + 1 to `<path>.n`, so
//                               each loop round (a new session) gets its own. It beats
//                               STUB_CLAUDE_OUTPUTS while its file exists. A `null` entry
//                               sets nothing (a step that declares no outputs, in the same run).
//   STUB_CLAUDE_RESUME_GATE=path  a resumed print turn (`--resume`, the reminder) waits
//                               until this file exists before it reads the two files
//                               above, so a test can change them between turns without
//                               racing the relaunch. It logs `GATE open` when it goes on,
//                               or `GATE timed out` and fails after 30 s: sooner than a
//                               test's own wait for the run, so the stub's failure shows first.
//   STUB_CLAUDE_READS=a,b       print mode: before its writes, calls consola_read_artifact { name }
//                               for each comma-separated ref, and logs `READ <ref> <answer>` (the
//                               whole answer, newlines flattened, so a fenced document's text is
//                               in the line), or `READ <ref> ERROR <answer>` for an error answer.
//                               An error here does not fail the turn: "no earlier run" is an answer.
//   STUB_CLAUDE_CALLS=path      an interactive launch (no -p) whose file holds `[[tool, args], …]`
//                               makes those calls once, in order, against --mcp-config's consola
//                               server, logs `TOOL <name> <first line>` for each (`TOOL <name>
//                               ERROR <first line>` for a failed one), then shows the composer.
//                               Once per file: it writes `<path>.done` after, and a relaunch that
//                               finds it makes none.
//   STUB_CLAUDE_ENV_LOG=path    every launch appends `ENV <session id> :: <every variable name,
//                               sorted, joined by spaces>`: names only, never a value; by session,
//                               since every step of a run that owns its checkout shares one cwd.
// A step that writes (slice 3-B). Each of these acts only on a launch whose `--tools` holds
// `Write`, and counts only those (review S6: a read-only step launches in the same checkout):
//   STUB_CLAUDE_WRITES=path     a JSON array, one entry per print-mode Write launch in order (n from
//                               `<path>.n`, absent 0; past the end, the last), each `{ files?: {
//                               <path in the cwd>: <text> } }`: writes each file under its cwd and
//                               logs `WROTE <paths joined ,>`. It never commits: under a sandbox an
//                               agent cannot, and Consola commits every step (review S1).
//   STUB_CLAUDE_WRITES_OPEN=path  the same for an interactive Write launch (no -p), counted in
//                               `<path>.n` of its own, which then shows the composer and stays open
//                               until `<path>.close` exists, logging `OPEN waiting`, then `OPEN
//                               closed`, and exits 0: a person's session in the checkout.
//   STUB_CLAUDE_LEAVE_PROCESS=path  the first print-mode Write launch while `<path>.done` is absent
//                               starts `sleep 300` in its cwd, in the launch's own process group (not
//                               detached: a shell's background job; it ignores the terminal's hangup,
//                               so only a signal ends it), writes its pid to `<path>`, then creates
//                               `<path>.done` (review M13: the condition and the marker are one path).
//   STUB_CLAUDE_HOLD_WRITE=path  STUB_CLAUDE_HOLD (below) for a Write launch only, after its
//                               STUB_CLAUDE_WRITES files are written: a read-only step in the same
//                               run passes, so a test can quit while a write step holds.
//   STUB_CLAUDE_MOVE_HEAD=1     a print-mode Write launch runs `git checkout -q --detach` in its cwd
//                               before it ends (no git variable reaches a step: its git finds the
//                               folder through the checkout's pointer), logging `HEAD detached`.
//   Only in stream-json:
//   STUB_CLAUDE_MODEL=name      `init`'s model; default `claude-stub-1`
//   STUB_CLAUDE_COST=usd        the result's `total_cost_usd`; default 0.0123. A comma list
//                               (`0.0015,0.003`) gives the n-th turn of a conversation its n-th
//                               value, the last once it runs out, counted by the `END <id>`
//                               lines in STUB_CLAUDE_LOG: the real CLI reports a resumed
//                               turn's cost as the conversation's running total
//   STUB_CLAUDE_TURNS=n         the result's `num_turns`; default 3. A comma list as above
//   STUB_CLAUDE_SUBTYPE=name    the result's `subtype`; default `success`. Anything else is
//                               `is_error`; `error_max_turns` has no `result` text
//   STUB_CLAUDE_HOOKS_FILE=path read at each launch when the file exists: a JSON list of
//                               `"<event>"` or `"<event>:<detail>"`, each POSTed as JSON
//                               (`{ hook_event_name, session_id }`, plus `error: <detail>` for
//                               StopFailure, `notification_type: <detail>` for Notification, and
//                               `tool_name: 'Read'`, `tool_input: { file_path: 'src/catalog.ts' }`
//                               for PermissionRequest) to the first `url` in `--settings`' hooks,
//                               in order, logging `HOOK <event> <status>` (`HOOK <event> ERROR
//                               <why>` when the post fails, `HOOK <event> no url` without one).
//                               StopFailure is posted just before the result, the rest right
//                               after `init`.
//   STUB_CLAUDE_HOLD=path       after `init` and the early hooks, waits for this file, logging
//                               `HOLD waiting`, then `HOLD open`, or `HOLD timed out` and exits 1
//                               after 60 s, before any tool call. A test holds a turn open with it.
//   STUB_CLAUDE_STDERR=text     one line on stderr before the result
//   STUB_CLAUDE_LIMIT=1         an `assistant` event with `"error":"rate_limit"` and the text
//                               `You've hit your limit · resets 3pm (Europe/Madrid)` before the
//                               result, and that text as the result's
//   STUB_CLAUDE_DENIED=a,b      each name as a `permission_denials` entry, `{ tool_name,
//                               tool_use_id: 'toolu_denied_<n>', tool_input: {} }`, in order
//
// The servers a profile has, and which of them a launch loads (stream-json and the
// control protocol alike, read again by every process):
//   STUB_CLAUDE_MCP=path        a JSON array of `{ name, scope: 'dynamic' | 'claudeai',
//                               type: 'stdio' | 'http' | 'claudeai-proxy', url?, status,
//                               tools?: string[] }`: a `dynamic` one is a user server, in the
//                               account file, so it loads only when a `--mcp-config` value (the
//                               flag takes every value up to the next flag; the first is
//                               Consola's) ends `/.claude.json`; a `claudeai` one is a
//                               connector, which loads unless `--strict-mcp-config`. Then, when
//                               `--settings` holds `allowedMcpServers`, a `stdio` server stays
//                               only by its `serverName`, and only when that name is all
//                               [A-Za-z0-9_-] (the real CLI blocks any other, canary row 22);
//                               an `http` or `claudeai-proxy` one only by its `serverUrl`, or
//                               by `serverName` while the list has no `serverUrl` entry (spike
//                               Q1f7). The ones it drops are named on stderr as the real CLI
//                               names them: `Warning: MCP server blocked by enterprise policy:
//                               <name>` (`servers`, comma-joined, for several).
//
// The control protocol (`--input-format stream-json`, only with STUB_CLAUDE_MCP or
// STUB_CLAUDE_COMMANDS set): it reads `control_request` lines and answers each with a
// `control_response`, logging `CONTROL <subtype> in <cwd> with <argv>` (newlines
// flattened; no ` :: `, so a launch filter skips it), and exits once stdin ends:
//   initialize                  `{ commands, agents: [], models: opus and haiku }`, `commands`
//                               being STUB_CLAUDE_COMMANDS' names (`a,b`), then `consola-step:<n>`
//                               for each `<--plugin-dir>/skills/<n>/SKILL.md`
//   mcp_status                  `{ mcpServers: [{ name, status, scope, config: { type, url? },
//                               tools?: [{ name }] }] }` for the STUB_CLAUDE_MCP servers that
//                               load, none when it is unset, and an error, `STUB_CLAUDE_MCP names
//                               no file`, while its file does not exist (a probe that fails until
//                               a test writes it)
//   anything else               an error at once, `the stub does not answer <subtype>`
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');

const PROTOCOL_VERSION = '2025-06-18';
/** Long enough for a loaded machine; short of the test's own timeouts. */
const REQUEST_TIMEOUT_MS = 20_000;
/** How long a resumed turn waits for STUB_CLAUDE_RESUME_GATE before failing: under the 60 s a test waits for its run. */
const GATE_TIMEOUT_MS = 30_000;
/** How long a turn waits for STUB_CLAUDE_HOLD before failing. */
const HOLD_TIMEOUT_MS = 60_000;
/** What the CLI says when a turn stops on a usage limit. */
const LIMIT_TEXT = "You've hit your limit · resets 3pm (Europe/Madrid)";

const args = process.argv.slice(2);
const dashes = args.indexOf('--');
const flags = dashes === -1 ? args : args.slice(0, dashes);
const prompt = dashes === -1 ? '' : args.slice(dashes + 1).join(' ');

function log(line) {
  if (!process.env.STUB_CLAUDE_LOG) return;
  // One write per line, so a concurrent launch cannot split it.
  fs.appendFileSync(process.env.STUB_CLAUDE_LOG, line.replace(/\n/g, ' ') + '\n');
}

function flagValue(name) {
  const at = flags.indexOf(name);
  return at === -1 ? undefined : flags[at + 1];
}

/** Every value after `name`, up to the next flag: `--mcp-config` takes several. */
function flagValues(name) {
  const at = flags.indexOf(name);
  if (at === -1) return [];
  const values = [];
  for (const value of flags.slice(at + 1)) {
    if (value.startsWith('--')) break;
    values.push(value);
  }
  return values;
}

/** A server's or tool's name as Claude writes it in a tool's name. */
function flattened(name) {
  return name.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** The only names `allowedMcpServers` keeps a stdio server by (canary row 22). */
const KEPT_BY_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * STUB_CLAUDE_MCP's servers as this launch loads them: `{ kept, blocked }`, or
 * `{ missing: true }` while the knob names a file that is not there.
 */
function loadedServers() {
  const file = process.env.STUB_CLAUDE_MCP;
  if (!file) return { kept: [], blocked: [] };
  if (!fs.existsSync(file)) return { missing: true, kept: [], blocked: [] };
  const servers = JSON.parse(fs.readFileSync(file, 'utf8'));
  const strict = flags.includes('--strict-mcp-config');
  const accountFile = flagValues('--mcp-config').some((value) => value.endsWith('/.claude.json'));
  const loads = servers.filter((server) =>
    server.scope === 'claudeai' ? !strict : server.scope === 'dynamic' && accountFile,
  );
  const settings = flagValue('--settings');
  const allowed = settings ? JSON.parse(settings).allowedMcpServers : undefined;
  if (!Array.isArray(allowed)) return { kept: loads, blocked: [] };
  const anyUrl = allowed.some((entry) => typeof entry.serverUrl === 'string');
  const byName = (name) => allowed.some((entry) => entry.serverName === name);
  const keeps = (server) =>
    server.type === 'stdio'
      ? KEPT_BY_NAME.test(server.name) && byName(server.name)
      : allowed.some((entry) => entry.serverUrl === server.url) || (!anyUrl && byName(server.name));
  return { kept: loads.filter(keeps), blocked: loads.filter((server) => !keeps(server)) };
}

/** How the real CLI names the servers its allow-list dropped, on stderr. */
function warnBlocked(blocked) {
  if (blocked.length === 0) return;
  const names = blocked.map((server) => server.name).join(', ');
  const noun = blocked.length === 1 ? 'server' : 'servers';
  process.stderr.write(`Warning: MCP ${noun} blocked by enterprise policy: ${names}\n`);
}

/** `consola-step:<n>` for each `<--plugin-dir>/skills/<n>/SKILL.md`; none without the flag. */
function pluginSkills() {
  const dir = flagValue('--plugin-dir');
  if (!dir) return [];
  const skills = path.join(dir, 'skills');
  if (!fs.existsSync(skills)) return [];
  return fs
    .readdirSync(skills)
    .sort()
    .filter((name) => fs.existsSync(path.join(skills, name, 'SKILL.md')))
    .map((name) => `consola-step:${name}`);
}

/** A launch that may write files: its `--tools` holds `Write` (slice 3-B). Only these take a write knob's entry. */
const WRITES = (flagValue('--tools') ?? '').split(',').includes('Write');

/** `<file>.n`'s count (absent 0), moved on to n + 1. */
function nextCount(file) {
  const counter = `${file}.n`;
  const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) || 0 : 0;
  fs.writeFileSync(counter, String(n + 1));
  return n;
}

/**
 * A write knob's entry for this launch (`STUB_CLAUDE_WRITES` or
 * `STUB_CLAUDE_WRITES_OPEN`): each of its files written under the cwd,
 * logged as `WROTE <paths>`. Nothing for an unset knob, a missing file, or
 * one that holds no list. Commits nothing.
 */
function writeFiles(name) {
  const text = readKnob(name);
  if (text === null) return;
  let entries;
  try {
    entries = JSON.parse(text);
  } catch {
    return;
  }
  if (!Array.isArray(entries) || entries.length === 0) return;
  const entry = entries[Math.min(nextCount(process.env[name]), entries.length - 1)] ?? {};
  const paths = Object.keys(entry.files ?? {});
  for (const relative of paths) {
    const file = path.join(process.cwd(), relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, entry.files[relative]);
  }
  if (paths.length > 0) log(`WROTE ${paths.join(',')}`);
}

/**
 * STUB_CLAUDE_LEAVE_PROCESS: once, a `sleep 300` left in the cwd, in this
 * launch's process group, as a shell's background job is. It ignores the
 * terminal's hangup (the step's terminal closes when its CLI exits), so
 * only a signal ends it: what Consola ends after the step.
 */
function leaveProcess() {
  const file = process.env.STUB_CLAUDE_LEAVE_PROCESS;
  if (!file || fs.existsSync(`${file}.done`)) return;
  const child = spawn('/bin/sh', ['-c', 'trap "" HUP; exec sleep 300'], {
    cwd: process.cwd(),
    stdio: 'ignore',
  });
  child.unref();
  fs.writeFileSync(file, String(child.pid));
  fs.writeFileSync(`${file}.done`, '');
  log(`LEFT ${child.pid}`);
}

/** STUB_CLAUDE_MOVE_HEAD=1: `HEAD` detached in the cwd, by the checkout's own git. */
function moveHead() {
  if (process.env.STUB_CLAUDE_MOVE_HEAD !== '1') return;
  const moved = spawnSync('git', ['checkout', '-q', '--detach'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  log(moved.status === 0 ? 'HEAD detached' : `HEAD ERROR ${firstLine(moved.stderr.trim())}`);
}

/** STUB_CLAUDE_ENV_LOG: this launch's variable names, sorted, never a value. */
function logEnvironment() {
  const file = process.env.STUB_CLAUDE_ENV_LOG;
  if (!file) return;
  const names = Object.keys(process.env).sort().join(' ');
  fs.appendFileSync(
    file,
    `ENV ${flagValue('--session-id') ?? flagValue('--resume')} :: ${names}\n`,
  );
}

/** Print mode reporting its turn as the real CLI's stream-json. */
const STREAM_JSON = flagValue('--output-format') === 'stream-json';
/** The conversation this launch speaks in. */
const SESSION_ID = flagValue('--session-id') ?? flagValue('--resume');

/** The first call that failed, logged as it was: a stream-json turn's result says it. */
let failure = null;

/** Logs a line that fails the turn, remembering the first. */
function logFailure(line) {
  log(line);
  failure ??= line;
}

/** One stream-json event, on its own line. */
function emit(event) {
  if (STREAM_JSON) process.stdout.write(JSON.stringify(event) + '\n');
}

/** Writes `text`, resolving once it is handed over, so what follows comes after it. */
function writeOut(stream, text) {
  return new Promise((resolve) => stream.write(text, resolve));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A file's text, or null when the knob is unset or the file is absent. */
function readKnob(name) {
  const file = process.env[name];
  if (!file || !fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8');
}

function firstLine(text) {
  return String(text).split('\n')[0];
}

/** One stdio MCP server, spoken to line by line. */
function connect(server) {
  const child = spawn(server.command, server.args ?? [], {
    env: { ...process.env, ...(server.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  const pending = new Map();
  let nextId = 1;
  const failAll = (reason) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error(reason));
    }
    pending.clear();
  };
  child.on('error', (error) => failAll(`could not start ${server.command}: ${error.message}`));
  child.on('exit', (code, signal) =>
    failAll(`the server exited (${signal ?? code}): ${firstLine(stderr.trim())}`),
  );
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    // Only answers to our requests matter; notifications and server requests are ignored.
    const waiting = message.id === undefined ? undefined : pending.get(message.id);
    if (!waiting || message.method !== undefined) return;
    pending.delete(message.id);
    clearTimeout(waiting.timer);
    if (message.error)
      waiting.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
    else waiting.resolve(message.result);
  });
  const send = (message) =>
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`no answer to ${method} within ${REQUEST_TIMEOUT_MS} ms`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      send({ id, method, params });
    });
  return {
    async initialize() {
      await request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'claude-steps-stub', version: '2.0.0' },
      });
      send({ method: 'notifications/initialized' });
    },
    callTool: (name, toolArgs) => request('tools/call', { name, arguments: toolArgs }),
    close() {
      child.stdin.end();
      child.kill();
    },
  };
}

/** The tool calls this launch makes, from the knobs' files as they are now. */
function plannedCalls() {
  const calls = [];
  const handover = readKnob('STUB_CLAUDE_HANDOVER');
  if (handover !== null)
    calls.push(['consola_write_artifact', { name: 'handover', content: handover }]);
  const sequence = readKnob('STUB_CLAUDE_OUTPUTS_SEQ');
  const outputs = sequence !== null ? nextInSequence(sequence) : readKnob('STUB_CLAUDE_OUTPUTS');
  if (outputs !== null) {
    try {
      calls.push(['consola_set_outputs', { outputs: JSON.parse(outputs) }]);
    } catch {
      // Not JSON (an empty file, say): the turn sets nothing.
    }
  }
  return calls;
}

/**
 * STUB_CLAUDE_OUTPUTS_SEQ's entry for this launch, as JSON text: entry n
 * (from `<file>.n`, absent 0; past the end, the last), and `<file>.n` moves
 * on to n + 1. Null when the file holds no list of entries.
 */
function nextInSequence(text) {
  let entries;
  try {
    entries = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const counter = `${process.env.STUB_CLAUDE_OUTPUTS_SEQ}.n`;
  const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) || 0 : 0;
  fs.writeFileSync(counter, String(n + 1));
  const entry = entries[Math.min(n, entries.length - 1)];
  // A `null` entry is a launch that sets nothing: a step that declares no outputs has no tool for them.
  return entry === null ? null : JSON.stringify(entry);
}

/**
 * Connects to --mcp-config's consola server, hands the client to `use`, and
 * closes it; false when the server cannot be reached (logged as `MCP …`), else
 * what `use` returned.
 */
async function withConsola(use) {
  const configPath = flagValue('--mcp-config');
  if (!configPath) {
    logFailure('MCP no --mcp-config');
    return false;
  }
  const server = JSON.parse(fs.readFileSync(configPath, 'utf8')).mcpServers?.consola;
  if (!server) {
    logFailure(`MCP no mcpServers.consola in ${configPath}`);
    return false;
  }
  const client = connect(server);
  try {
    await client.initialize();
    return await use(client);
  } catch (error) {
    logFailure(`MCP ${firstLine(error.message)}`);
    return false;
  } finally {
    client.close();
  }
}

let toolUses = 0;

/** One call: its text and whether it failed (an `isError` answer or a rejected call). */
async function call(client, name, toolArgs) {
  // How the real CLI's stream shows a call it is about to make.
  emit({
    type: 'assistant',
    message: {
      role: 'assistant',
      type: 'message',
      content: [
        {
          type: 'tool_use',
          id: `toolu_stub_${++toolUses}`,
          name: `mcp__consola__${name}`,
          input: toolArgs,
        },
      ],
    },
    session_id: SESSION_ID,
  });
  try {
    const result = await client.callTool(name, toolArgs);
    const text = (result?.content ?? []).find((part) => part.type === 'text')?.text ?? '';
    // How a server reports a tool that failed: an answer, not a JSON-RPC error.
    return { text, failed: result?.isError === true };
  } catch (error) {
    return { text: error.message, failed: true };
  }
}

/** Makes every call, in order, logging `TOOL …` for each; true only when each one succeeded. */
async function callTools(client, calls) {
  let ok = true;
  for (const [name, toolArgs] of calls) {
    const { text, failed } = await call(client, name, toolArgs);
    const line = `TOOL ${name} ${failed ? 'ERROR ' : ''}${firstLine(text)}`;
    if (failed) {
      ok = false;
      logFailure(line);
    } else log(line);
  }
  return ok;
}

/** Reads each document STUB_CLAUDE_READS names, logging the whole answer; never fails the turn by itself. */
async function readDocuments(client, refs) {
  for (const ref of refs) {
    const { text, failed } = await call(client, 'consola_read_artifact', { name: ref });
    log(`READ ${ref} ${failed ? 'ERROR ' : ''}${text}`);
  }
  return true;
}

/** The refs STUB_CLAUDE_READS names, in order. */
function plannedReads() {
  return (process.env.STUB_CLAUDE_READS ?? '')
    .split(',')
    .map((ref) => ref.trim())
    .filter(Boolean);
}

/** A resumed turn, with STUB_CLAUDE_RESUME_GATE set, waits for its file; false when it never came. */
async function passGate() {
  const gate = process.env.STUB_CLAUDE_RESUME_GATE;
  if (!gate || flagValue('--resume') === undefined) return true;
  const until = Date.now() + GATE_TIMEOUT_MS;
  while (!fs.existsSync(gate)) {
    if (Date.now() > until) {
      log('GATE timed out');
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  log('GATE open');
  return true;
}

/** The hooks STUB_CLAUDE_HOOKS_FILE names, as `[event, detail]`; none when it is unset or absent. */
function plannedHooks() {
  const text = readKnob('STUB_CLAUDE_HOOKS_FILE');
  if (text === null) return [];
  return JSON.parse(text).map((entry) => {
    const at = entry.indexOf(':');
    return at === -1 ? [entry, undefined] : [entry.slice(0, at), entry.slice(at + 1)];
  });
}

/** The first `url` among `--settings`' hook handlers, where Consola's endpoint listens. */
function hookUrl() {
  const settings = flagValue('--settings');
  if (!settings) return undefined;
  for (const groups of Object.values(JSON.parse(settings).hooks ?? {})) {
    for (const group of groups) {
      for (const handler of group.hooks ?? []) if (handler.url) return handler.url;
    }
  }
  return undefined;
}

/** Posts one hook as Claude's http hook would, logging `HOOK <event> <status>`. */
async function postHook([event, detail]) {
  const url = hookUrl();
  if (!url) {
    log(`HOOK ${event} no url`);
    return;
  }
  const body = { hook_event_name: event, session_id: SESSION_ID };
  if (event === 'StopFailure' && detail !== undefined) body.error = detail;
  if (event === 'Notification' && detail !== undefined) body.notification_type = detail;
  if (event === 'PermissionRequest') {
    body.tool_name = 'Read';
    body.tool_input = { file_path: 'src/catalog.ts' };
  }
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    await response.arrayBuffer();
    log(`HOOK ${event} ${response.status}`);
  } catch (error) {
    log(`HOOK ${event} ERROR ${firstLine(error.message)}`);
  }
}

/**
 * STUB_CLAUDE_HOLD (any launch), else STUB_CLAUDE_HOLD_WRITE (a Write launch
 * only): waits for its file, so a test can look at a turn mid-way; false
 * when it never came.
 */
async function hold() {
  const file =
    process.env.STUB_CLAUDE_HOLD || (WRITES ? process.env.STUB_CLAUDE_HOLD_WRITE : undefined);
  if (!file) return true;
  log('HOLD waiting');
  const until = Date.now() + HOLD_TIMEOUT_MS;
  while (!fs.existsSync(file)) {
    if (Date.now() > until) {
      log('HOLD timed out');
      return false;
    }
    await sleep(50);
  }
  log('HOLD open');
  return true;
}

/** STUB_CLAUDE_DENIED's names, as the result's `permission_denials`. */
function permissionDenials() {
  return (process.env.STUB_CLAUDE_DENIED ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name, index) => ({
      tool_name: name,
      tool_use_id: `toolu_denied_${index + 1}`,
      tool_input: {},
    }));
}

/** How many turns of this conversation ended before this one: its `END <id>` lines in the log. */
function turnsBefore() {
  const file = process.env.STUB_CLAUDE_LOG;
  if (!file || !fs.existsSync(file)) return 0;
  const ended = `END ${SESSION_ID} `;
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith(ended)).length;
}

/**
 * A number knob, or its default when unset. A comma list gives the n-th turn
 * of a conversation its n-th value (`turnsBefore`), and the last once the
 * list runs out.
 */
function numberKnob(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;
  const values = value.split(',');
  return Number(values[Math.min(turnsBefore(), values.length - 1)]);
}

async function printTurn() {
  const id = SESSION_ID;
  // The last line a turn logs, so a test can tell it is over.
  const end = (code, stream, text) => {
    if (WRITES) moveHead();
    log(`END ${id} exit ${code}`);
    stream.write(text, () => process.exit(code));
  };
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'p');
  fs.mkdirSync(dir, { recursive: true });
  const transcript = path.join(dir, `${id}.jsonl`);
  // Written by Node so timestamps carry milliseconds: a run's conversation is
  // the records from its start, and a second-truncated stamp would fall before it.
  const record = (type, content) =>
    JSON.stringify({ type, timestamp: new Date().toISOString(), message: { role: type, content } });
  const findings = () =>
    fs.appendFileSync(
      transcript,
      record('assistant', [{ type: 'text', text: 'FINDINGS: done' }]) + '\n',
    );
  fs.appendFileSync(transcript, record('user', prompt) + '\n');
  // A write step's work, before anything else, so a held turn has already written (slice 3-B).
  if (WRITES) {
    writeFiles('STUB_CLAUDE_WRITES');
    leaveProcess();
  }
  const hooks = STREAM_JSON ? plannedHooks() : [];
  if (STREAM_JSON) {
    const { kept, blocked } = loadedServers();
    warnBlocked(blocked);
    const skillTool = (flagValue('--tools') ?? '').split(',').includes('Skill') ? ['Skill'] : [];
    const serverTools = kept.flatMap((server) =>
      (server.tools ?? []).map((tool) => `mcp__${flattened(server.name)}__${flattened(tool)}`),
    );
    emit({
      type: 'system',
      subtype: 'init',
      session_id: id,
      model: process.env.STUB_CLAUDE_MODEL || 'claude-stub-1',
      mcp_servers: [
        { name: 'consola', status: 'connected' },
        ...kept.map((server) => ({ name: server.name, status: server.status })),
      ],
      tools: ['Read', 'Grep', 'Glob', ...skillTool, ...serverTools],
      ...(flagValue('--plugin-dir') === undefined ? {} : { skills: pluginSkills() }),
    });
    for (const hook of hooks) if (hook[0] !== 'StopFailure') await postHook(hook);
    if (!(await hold())) {
      end(1, process.stderr, 'stub claude: STUB_CLAUDE_HOLD never appeared\n');
      return;
    }
  }
  if (!(await passGate())) {
    end(1, process.stderr, 'stub claude: STUB_CLAUDE_RESUME_GATE never opened\n');
    return;
  }
  const calls = plannedCalls();
  const reads = plannedReads();
  const ok =
    calls.length + reads.length === 0 ||
    (await withConsola(
      async (client) => (await readDocuments(client, reads)) && callTools(client, calls),
    ));
  if (!STREAM_JSON) {
    if (!ok) {
      // A turn whose tool failed is a failed turn: no findings, a non-zero exit.
      end(1, process.stderr, 'stub claude: a step tool call failed (see STUB_CLAUDE_LOG)\n');
      return;
    }
    findings();
    end(0, process.stdout, 'FINDINGS: done\n');
    return;
  }
  const limit = process.env.STUB_CLAUDE_LIMIT === '1';
  const subtype = process.env.STUB_CLAUDE_SUBTYPE || 'success';
  const isError = subtype !== 'success' || limit || !ok;
  if (limit) {
    emit({
      type: 'assistant',
      message: {
        role: 'assistant',
        type: 'message',
        content: [{ type: 'text', text: LIMIT_TEXT }],
      },
      session_id: id,
      error: 'rate_limit',
      is_api_error_message: true,
    });
  }
  if (process.env.STUB_CLAUDE_STDERR)
    await writeOut(process.stderr, `${process.env.STUB_CLAUDE_STDERR}\n`);
  for (const hook of hooks) if (hook[0] === 'StopFailure') await postHook(hook);
  const text =
    subtype === 'error_max_turns'
      ? undefined
      : limit
        ? LIMIT_TEXT
        : !ok
          ? (failure ?? 'a step tool call failed')
          : 'FINDINGS: done';
  // As in text mode: only a turn that finished leaves its findings in the transcript.
  if (!isError) findings();
  end(
    isError ? 1 : 0,
    process.stdout,
    JSON.stringify({
      duration_api_ms: 0,
      type: 'result',
      subtype,
      is_error: isError,
      num_turns: numberKnob('STUB_CLAUDE_TURNS', 3),
      total_cost_usd: numberKnob('STUB_CLAUDE_COST', 0.0123),
      ...(text === undefined ? {} : { result: text }),
      permission_denials: permissionDenials(),
      api_error_status: null,
      session_id: id,
    }) + '\n',
  );
}

if (flags.includes('--version')) {
  process.stdout.write('2.0.0 (Claude Code)\n');
} else if (flags.includes('--input-format')) {
  if (process.env.STUB_CLAUDE_MCP || process.env.STUB_CLAUDE_COMMANDS) control();
  else process.exitCode = 1;
} else {
  log(`${process.cwd()} :: ${args.join(' ')}`);
  logEnvironment();
  if (flags.includes('-p')) {
    printTurn().catch((error) => {
      log(`STUB ${firstLine(error.stack ?? error.message)}`);
      process.exit(1);
    });
  } else {
    interactive().catch((error) => {
      log(`STUB ${firstLine(error.stack ?? error.message)}`);
      process.stdout.write('❯ ');
    });
    setTimeout(() => {}, 300_000);
  }
}

/**
 * An interactive launch: STUB_CLAUDE_CALLS' calls once, then an empty
 * composer. A Write launch with STUB_CLAUDE_WRITES_OPEN writes its entry
 * first and, once the composer shows, waits for `<path>.close`, then exits.
 */
async function interactive() {
  const open = WRITES ? process.env.STUB_CLAUDE_WRITES_OPEN : undefined;
  if (open) writeFiles('STUB_CLAUDE_WRITES_OPEN');
  const file = process.env.STUB_CLAUDE_CALLS;
  if (file && fs.existsSync(file) && !fs.existsSync(`${file}.done`)) {
    const calls = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(`${file}.done`, '');
    await withConsola((client) => callTools(client, calls));
  }
  process.stdout.write('❯ ');
  if (!open) return;
  log('OPEN waiting');
  while (!fs.existsSync(`${open}.close`)) await sleep(100);
  log('OPEN closed');
  process.exit(0);
}

/** One control request's answer: `{ response }`, or `{ error }`. */
function answer(subtype) {
  if (subtype === 'initialize') {
    const commands = (process.env.STUB_CLAUDE_COMMANDS ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    return {
      response: {
        commands: [...commands, ...pluginSkills()].map((name) => ({ name })),
        agents: [],
        models: [
          { value: 'opus', displayName: 'Opus' },
          { value: 'haiku', displayName: 'Haiku' },
        ],
      },
    };
  }
  if (subtype === 'mcp_status') {
    const { missing, kept } = loadedServers();
    if (missing) return { error: 'STUB_CLAUDE_MCP names no file' };
    return {
      response: {
        mcpServers: kept.map((server) => ({
          name: server.name,
          status: server.status,
          scope: server.scope,
          config: { type: server.type, ...(server.url === undefined ? {} : { url: server.url }) },
          ...(server.tools === undefined ? {} : { tools: server.tools.map((name) => ({ name })) }),
        })),
      },
    };
  }
  return { error: `the stub does not answer ${subtype}` };
}

/** The control protocol: each `control_request` answered in turn; done once stdin ends. */
function control() {
  warnBlocked(loadedServers().blocked);
  let writes = Promise.resolve();
  readline
    .createInterface({ input: process.stdin })
    .on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message?.type !== 'control_request') return;
      const subtype = message.request?.subtype;
      log(`CONTROL ${subtype} in ${process.cwd()} with ${args.join(' ')}`);
      const { response, error } = answer(subtype);
      const reply =
        error === undefined
          ? { subtype: 'success', request_id: message.request_id, response }
          : { subtype: 'error', request_id: message.request_id, error };
      const text = `${JSON.stringify({ type: 'control_response', response: reply })}\n`;
      writes = writes.then(() => writeOut(process.stdout, text));
    })
    .on('close', () => {
      writes.then(() => process.exit(0));
    });
}
