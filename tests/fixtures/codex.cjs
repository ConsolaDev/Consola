#!/usr/bin/env node
// Offline Codex protocol/terminal fixture. Never contacts a model provider.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const crypto = require('node:crypto');
const args = process.argv.slice(2);
const home = process.env.CODEX_HOME;
if (args.includes('--version')) {
  console.log('codex-cli 0.114.0');
} else if (args[0] === 'login') {
  if (fs.existsSync(path.join(home, 'logged-out'))) {
    console.error('Not logged in');
    process.exitCode = 1;
  } else if (fs.existsSync(path.join(home, 'api-key'))) {
    console.error('Logged in using an API key - fixture-private-key-fragment');
  } else {
    console.error('Logged in using ChatGPT');
  }
} else if (args[0] === 'app-server') {
  let savedThread;
  let flushed = false;
  const input = readline.createInterface({ input: process.stdin });
  // Codex buffers rollout writes. Only a graceful shutdown guarantees the
  // next process can resume it; SIGTERM immediately after a reply is too early.
  input.on('close', () => {
    if (savedThread && flushed) setTimeout(() => {
      fs.writeFileSync(path.join(home, savedThread.threadId + '.json'), JSON.stringify(savedThread));
    }, 50);
  });
  input.on('line', line => {
    const { id, method, params } = JSON.parse(line);
    if (id === undefined) return;
    const mode = process.env.CONSOLA_CODEX_FIXTURE_MODE;
    if (mode === 'hang') return;
    if (mode === 'exit') process.exit(1);
    if (mode === 'invalid') { process.stdout.write('not-json\n'); return; }
    if (mode === 'reject') {
      process.stdout.write(JSON.stringify({ id, error: { message: 'fixture-private-key-fragment' } }) + '\n');
      return;
    }
    let result = {};
    if (method === 'thread/start') {
      result = { thread: { id: crypto.randomUUID() } };
    } else if (method === 'thread/name/set') {
      savedThread = params;
    } else if (method === 'thread/resume') {
      flushed = true;
      result = { thread: { id: params.threadId } };
    }
    process.stdout.write(JSON.stringify({ id, result }) + '\n');
  });
} else if (args[0] === 'resume') {
  if (!fs.existsSync(path.join(home, args[1] + '.json'))) {
    console.error('No conversation found');
    process.exit(1);
  }
  fs.appendFileSync(path.join(home, 'launches.jsonl'), JSON.stringify({ args, home }) + '\n');
  process.stdout.write('Codex fixture ready\r\n› ');
  process.stdin.resume();
} else {
  console.error('Unsupported Codex arguments');
  process.exit(1);
}
