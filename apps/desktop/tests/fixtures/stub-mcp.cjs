#!/usr/bin/env node
// A stand-in MCP server for the e2e tests (rule 5a-servers): plain Node, no
// dependency, newline-delimited JSON-RPC over stdio, as the MCP SDK's stdio
// transport speaks it. Consola starts it by an absolute path
// (`command: <node>`, `args: [<this file>, …]`) for a `uses:` step or a
// person's Check server.
//
// Its controls are its arguments, never environment variables: a factory
// server's environment is exactly the allow-list, its `env:` and its secrets,
// so a variable set for the app never reaches it.
//
//   --log <path>     appends one JSON line per event:
//                      { event: 'list' }                       tools/list answered
//                      { event: 'call', tool, arguments, tokenSha256 }
//                      { event: 'start' | 'work-done', tool }  a tool's work
//                    each with `at` (ms since the epoch). `tokenSha256` is the
//                    sha-256 hex of the SLACK_BOT_TOKEN it was given, or null
//                    without one: the value itself is never written or printed.
//   --pids <path>    appends its pid as it starts.
//   --slow-ms <n>    how long slow_post works (default 4000).
//   --quiet          accepted and ignored (an edit that changes nothing).
//
// Tools:
//   chat_post_message      { channel, text } → { ts }, with an outputSchema
//   conversations_history  { channel } → a text block
//   slow_post              { channel, text } → { ts }: logs `start` at once, then
//                          works --slow-ms, ignoring SIGTERM and the end of its
//                          stdin meanwhile, logs `work-done`, then answers (and
//                          exits, if it was asked to end while it worked)
//   post_then_fail         { channel, text }: logs its work, then answers isError
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

function optionsOf(argv) {
  const options = { log: null, pids: null, slowMs: 4000 };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--log') options.log = argv[++index];
    else if (arg === '--pids') options.pids = argv[++index];
    else if (arg === '--slow-ms') options.slowMs = Number(argv[++index]);
    // --quiet, and anything else, is accepted and ignored.
  }
  return options;
}

const options = optionsOf(process.argv.slice(2));

function log(event) {
  if (options.log)
    fs.appendFileSync(options.log, `${JSON.stringify({ ...event, at: Date.now() })}\n`);
}

if (options.pids) fs.appendFileSync(options.pids, `${process.pid}\n`);

const token = process.env.SLACK_BOT_TOKEN;
const tokenSha256 =
  token === undefined ? null : crypto.createHash('sha256').update(token, 'utf8').digest('hex');

const TS = '1700000000.0001';
const POST_INPUT = {
  type: 'object',
  properties: { channel: { type: 'string' }, text: { type: 'string' } },
  required: ['channel', 'text'],
};
const TS_OUTPUT = {
  type: 'object',
  properties: { ts: { type: 'string' } },
  required: ['ts'],
};
const TOOLS = [
  {
    name: 'chat_post_message',
    description: 'Posts a message to a channel.',
    inputSchema: POST_INPUT,
    outputSchema: TS_OUTPUT,
  },
  {
    name: 'conversations_history',
    description: "Lists a channel's recent messages.",
    inputSchema: {
      type: 'object',
      properties: { channel: { type: 'string' } },
      required: ['channel'],
    },
  },
  {
    name: 'slow_post',
    description: 'Posts a message, slowly.',
    inputSchema: POST_INPUT,
    outputSchema: TS_OUTPUT,
  },
  {
    name: 'post_then_fail',
    description: 'Posts a message, then reports an error.',
    inputSchema: POST_INPUT,
  },
];

// A slow_post at work ignores SIGTERM and the end of its stdin; asked to end
// meanwhile, it ends once it has answered.
let working = false;
let ending = false;
const end = () => {
  ending = true;
  if (!working) process.exit(0);
};
process.on('SIGTERM', end);
process.stdin.on('end', end);
// Consola may have closed the pipe before a late answer: that is not this server's error.
process.stdout.on('error', () => undefined);

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

const posted = () => ({
  content: [{ type: 'text', text: JSON.stringify({ ts: TS }) }],
  structuredContent: { ts: TS },
});

function call(id, params) {
  const tool = params?.name;
  const args = params?.arguments ?? {};
  log({ event: 'call', tool, arguments: args, tokenSha256 });
  switch (tool) {
    case 'chat_post_message':
      return send({ id, result: posted() });
    case 'conversations_history':
      return send({ id, result: { content: [{ type: 'text', text: '[]' }] } });
    case 'slow_post':
      log({ event: 'start', tool });
      working = true;
      setTimeout(() => {
        log({ event: 'work-done', tool });
        working = false;
        send({ id, result: posted() });
        if (ending) setTimeout(() => process.exit(0), 50);
      }, options.slowMs);
      return;
    case 'post_then_fail':
      log({ event: 'work-done', tool });
      return send({
        id,
        result: {
          content: [{ type: 'text', text: 'posted, then failed: channel_archived' }],
          isError: true,
        },
      });
    default:
      return send({
        id,
        result: { content: [{ type: 'text', text: `Tool ${tool} not found` }], isError: true },
      });
  }
}

function handle(message) {
  // A notification (no id) asks for nothing; a cancel is ignored, as a slow tool's work is.
  if (message.id === undefined || typeof message.method !== 'string') return;
  const { id, method, params } = message;
  switch (method) {
    case 'initialize':
      return send({
        id,
        result: {
          protocolVersion: params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'stub-mcp', version: '1.0.0' },
        },
      });
    case 'tools/list':
      log({ event: 'list' });
      return send({ id, result: { tools: TOOLS } });
    case 'tools/call':
      return call(id, params);
    case 'ping':
      return send({ id, result: {} });
    default:
      return send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      try {
        handle(JSON.parse(line));
      } catch {
        // Not JSON-RPC: nothing to answer.
      }
    }
    newline = buffer.indexOf('\n');
  }
});
