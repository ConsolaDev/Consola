#!/usr/bin/env node
// A stub `claude` for automation steps. Never contacts a model.
//
// Plain Node, no dependencies. `node` is not on the app's PATH in e2e, so a
// spec runs it through a generated `#!/bin/sh` wrapper that execs the test
// runner's own Node on this file with every argument.
//
//   --version            prints `2.0.0 (Claude Code)` (the health probe); logs nothing
//   --input-format …     exits 1: the capabilities probe is refused, so it
//                        neither counts as a launch nor waits out its timeout
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
//                        Both files are read again on every launch, so a resumed turn
//                        (a reminder) acts on what they hold by then. It writes a
//                        transcript where Claude would,
//                        $CLAUDE_CONFIG_DIR/projects/p/<id>.jsonl (the id from
//                        --session-id, else --resume): the prompt (after `--`), then
//                        `FINDINGS: done`. Then it prints `FINDINGS: done` and exits 0.
//   otherwise            shows an empty composer (`❯ `) and sleeps.
//
// A failure to reach the MCP server, or an error answer, is logged as
// `MCP <what went wrong>` / `TOOL <name> ERROR <message>` and the turn still
// ends cleanly, as Claude carries on without a server it could not use.
//
// Env knobs:
//   STUB_CLAUDE_LOG=path        the launch and tool log above
//   STUB_CLAUDE_HANDOVER=path   the handover to write (Markdown); absent file: none
//   STUB_CLAUDE_OUTPUTS=path    the outputs to set, as JSON; absent or not JSON: none
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const PROTOCOL_VERSION = '2025-06-18';
/** Long enough for a loaded machine; short of the test's own timeouts. */
const REQUEST_TIMEOUT_MS = 20_000;

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
  child.on('exit', (code, signal) => failAll(`the server exited (${signal ?? code}): ${firstLine(stderr.trim())}`));
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
    if (message.error) waiting.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
    else waiting.resolve(message.result);
  });
  const send = (message) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
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
  if (handover !== null) calls.push(['consola_write_artifact', { name: 'handover', content: handover }]);
  const outputs = readKnob('STUB_CLAUDE_OUTPUTS');
  if (outputs !== null) {
    try {
      calls.push(['consola_set_outputs', { outputs: JSON.parse(outputs) }]);
    } catch {
      // Not JSON (an empty file, say): the turn sets nothing.
    }
  }
  return calls;
}

async function callTools(calls) {
  const configPath = flagValue('--mcp-config');
  if (!configPath) {
    log('MCP no --mcp-config');
    return;
  }
  const server = JSON.parse(fs.readFileSync(configPath, 'utf8')).mcpServers?.consola;
  if (!server) {
    log(`MCP no mcpServers.consola in ${configPath}`);
    return;
  }
  const client = connect(server);
  try {
    await client.initialize();
    for (const [name, toolArgs] of calls) {
      try {
        const result = await client.callTool(name, toolArgs);
        const text = (result?.content ?? []).find((part) => part.type === 'text')?.text ?? '';
        log(`TOOL ${name} ${firstLine(text)}`);
      } catch (error) {
        log(`TOOL ${name} ERROR ${firstLine(error.message)}`);
      }
    }
  } catch (error) {
    log(`MCP ${firstLine(error.message)}`);
  } finally {
    client.close();
  }
}

async function printTurn() {
  const id = flagValue('--session-id') ?? flagValue('--resume');
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'p');
  fs.mkdirSync(dir, { recursive: true });
  const transcript = path.join(dir, `${id}.jsonl`);
  // Written by Node so timestamps carry milliseconds: a run's conversation is
  // the records from its start, and a second-truncated stamp would fall before it.
  const record = (type, content) => JSON.stringify({ type, timestamp: new Date().toISOString(), message: { role: type, content } });
  fs.appendFileSync(transcript, record('user', prompt) + '\n');
  const calls = plannedCalls();
  if (calls.length > 0) await callTools(calls);
  fs.appendFileSync(transcript, record('assistant', [{ type: 'text', text: 'FINDINGS: done' }]) + '\n');
  process.stdout.write('FINDINGS: done\n', () => process.exit(0));
}

if (flags.includes('--version')) {
  process.stdout.write('2.0.0 (Claude Code)\n');
} else if (flags.includes('--input-format')) {
  process.exitCode = 1;
} else {
  log(`${process.cwd()} :: ${args.join(' ')}`);
  if (flags.includes('-p')) {
    printTurn().catch((error) => {
      log(`STUB ${firstLine(error.stack ?? error.message)}`);
      process.exit(1);
    });
  } else {
    process.stdout.write('❯ ');
    setTimeout(() => {}, 300_000);
  }
}
