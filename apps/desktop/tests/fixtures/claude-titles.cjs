#!/usr/bin/env node
// Offline Claude fixture for session titles. Never contacts a model.
//
// What it does is read from <CLAUDE_CONFIG_DIR>/fixture.json:
//   { firstPrompt?: string, title: string, titleDelayMs?: number, resumeWorkMs?: number }
// read when each process starts, so a test can change it between launches.
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const config = process.env.CLAUDE_CONFIG_DIR;

function readFixture() {
  try {
    return JSON.parse(fs.readFileSync(path.join(config, 'fixture.json'), 'utf8'));
  } catch {
    return {};
  }
}

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

/** A line every 100 ms for `ms`, so the screen reads as a turn running; then quiet. */
function work(ms) {
  let line = 0;
  const timer = setInterval(() => {
    line += 1;
    process.stdout.write(`Working ${line}\r\n`);
  }, 100);
  setTimeout(() => {
    clearInterval(timer);
    process.stdout.write('> ');
  }, ms);
}

if (args.includes('--version')) {
  console.log('2.1.327 (Claude Code)');
} else if (args.includes('--input-format')) {
  // The capabilities probe: this "CLI" has nothing to say, so no title call
  // learns of an effort level.
  process.exit(1);
} else if (args.includes('-p')) {
  // A title call: record what was asked, then answer with the fixture's title.
  let stdin = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    stdin += chunk;
  });
  process.stdin.on('end', () => {
    const fixture = readFixture();
    fs.appendFileSync(
      path.join(config, 'title-calls.jsonl'),
      `${JSON.stringify({ argv: args, stdin, cwd: process.cwd() })}\n`,
    );
    setTimeout(() => {
      process.stdout.write(
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '',
          structured_output: { title: fixture.title },
        }),
      );
    }, fixture.titleDelayMs ?? 0);
  });
} else {
  // Interactive. A new conversation is `--session-id`; a fork also carries a
  // `--resume`, so the new id wins.
  const newConversation = valueAfter('--session-id');
  const id = newConversation ?? valueAfter('--resume');
  const fixture = readFixture();
  process.stdout.write(`Claude fixture ${id}\r\n> `);
  if (newConversation && fixture.firstPrompt) {
    // The person's first message lands in the transcript as Claude writes it.
    setTimeout(() => {
      const project = path.join(config, 'projects', '-fixture');
      fs.mkdirSync(project, { recursive: true });
      fs.writeFileSync(
        path.join(project, `${newConversation}.jsonl`),
        `${JSON.stringify({
          type: 'user',
          message: { role: 'user', content: fixture.firstPrompt },
          sessionId: newConversation,
        })}\n`,
      );
      work(1500);
    }, 300);
  } else if (!newConversation && fixture.resumeWorkMs) {
    // A resumed conversation that starts working as soon as it launches.
    work(fixture.resumeWorkMs);
  }
  process.stdin.resume();
}
