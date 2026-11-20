#!/usr/bin/env node
// Offline Antigravity CLI fixture. Never contacts a model provider.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const args = process.argv.slice(2);
const dataDir =
  process.env.CONSOLA_AGY_FIXTURE_DIR || path.join(os.homedir(), '.gemini', 'antigravity-cli');
const mode = process.env.CONSOLA_AGY_FIXTURE_MODE;

function argValue(flag) {
  const index = args.indexOf(flag);
  if (index !== -1 && index + 1 < args.length) return args[index + 1];
  const prefixed = args.find((entry) => entry.startsWith(`${flag}=`));
  return prefixed ? prefixed.slice(flag.length + 1) : undefined;
}

if (args.includes('--version')) {
  console.log('1.5.13');
} else if (args[0] === 'models') {
  if (mode === 'hang') {
    setInterval(() => {}, 1000);
  } else if (mode === 'exit') {
    process.exit(1);
  } else if (mode === 'malformed') {
    console.log('not-a-model-line');
  } else if (mode === 'logged-out' || fs.existsSync(path.join(dataDir, 'logged-out'))) {
    console.error('Error: Please sign in to view available models.');
    process.exit(1);
  } else {
    process.stdout.write(
      [
        'gemini-4-neon-high\tGemini 4 Neon (High)',
        'gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)',
        'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
        'gemini-pro-orchestrator-neon\tOrchestrator (Neon)',
      ].join('\n') + '\n',
    );
  }
} else if (args.includes('-p') || args.includes('--print')) {
  const prompt = argValue('-p') ?? argValue('--print');
  if (mode === 'logged-out' || fs.existsSync(path.join(dataDir, 'logged-out'))) {
    console.error('Authentication required.');
    process.exit(1);
  }
  if (prompt === '/help') {
    process.stdout.write(
      JSON.stringify({
        conversation_id: '',
        status: 'SUCCESS',
        response: '',
        command: {
          name: 'help',
          data: {
            commands: [
              { name: 'help', description: 'Show available commands and keybindings' },
              {
                name: 'model',
                description: 'Set a model, or run a single prompt on another model',
              },
              { name: 'usage', aliases: ['quota'], description: 'View model quota usage' },
            ],
          },
        },
      }) + '\n',
    );
  } else if (prompt === '/skills') {
    process.stdout.write(
      JSON.stringify({
        conversation_id: '',
        status: 'SUCCESS',
        response: '',
        command: {
          name: 'skills',
          data: {
            skills: [
              { name: 'antigravity-guide', description: 'Antigravity CLI guide' },
              { name: 'model', description: 'Duplicate name ignored in favor of /help' },
            ],
          },
        },
      }) + '\n',
    );
  } else if (prompt === '/agents') {
    process.stdout.write(
      JSON.stringify({
        conversation_id: '',
        status: 'SUCCESS',
        response: '',
        command: {
          name: 'agents',
          data: {
            agents: [{ name: 'reviewer', description: 'Reviews code changes' }],
          },
        },
      }) + '\n',
    );
  } else {
    console.error(`Unsupported print prompt: ${prompt}`);
    process.exit(1);
  }
} else {
  fs.mkdirSync(dataDir, { recursive: true });
  const existing = argValue('--conversation');
  const conversationId = existing || crypto.randomUUID();
  fs.appendFileSync(
    path.join(dataDir, 'launches.jsonl'),
    JSON.stringify({ args, conversationId }) + '\n',
  );
  // Emit OSC 2 title with the active conversation ID, matching the `--settings` title command.
  process.stdout.write(`\x1b]2;${conversationId}\x07`);
  for (let line = 1; line <= 150; line++) {
    process.stdout.write(`Antigravity conversation line ${line}\r\n`);
  }
  process.stdout.write('Antigravity fixture ready\r\n> ');
  let input = '';
  process.stdin.on('data', (chunk) => {
    input += chunk.toString();
    if (!/\/new[\r\n]/.test(input)) return;
    input = '';
    const nextId = crypto.randomUUID();
    fs.writeFileSync(path.join(dataDir, 'active-conversation'), nextId);
    process.stdout.write(`\x1b]2;${nextId}\x07New conversation\r\n> `);
  });
  process.stdin.resume();
}
