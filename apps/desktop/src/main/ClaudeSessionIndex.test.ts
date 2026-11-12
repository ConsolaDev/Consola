import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getDisplayName, MAX_REPLY_CHARS, readRecentReplies } from './ClaudeSessionIndex';

/**
 * Exercised through a real on-disk config directory: the module reads
 * Claude's own storage, so the fixture is the storage format itself. Each
 * test gets a fresh directory, which also keeps the module's mtime-keyed
 * index cache from ever seeing the same path twice.
 */

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

let configDir: string;
let projectDir: string;

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-index-'));
  projectDir = path.join(configDir, 'projects', '-Users-someone-code-repo');
  fs.mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
});

function writeTranscript(userMessages: string[]): void {
  const lines = userMessages.map((content) =>
    JSON.stringify({ type: 'user', message: { role: 'user', content } })
  );
  fs.writeFileSync(path.join(projectDir, `${SESSION_ID}.jsonl`), lines.join('\n') + '\n');
}

describe('getDisplayName from the transcript', () => {
  it('names a session from its opening prompt, marked as a prompt-derived name', () => {
    writeTranscript(['Fix the login redirect loop']);

    expect(getDisplayName(SESSION_ID, configDir)).toEqual({
      name: 'Fix the login redirect loop',
      source: 'prompt',
    });
  });

  it('skips <-wrapped command messages to reach real prose', () => {
    writeTranscript([
      '<command-message>brainstorm</command-message><command-name>/brainstorm</command-name>',
      'Design the session sidebar',
    ]);

    expect(getDisplayName(SESSION_ID, configDir)?.name).toBe('Design the session sidebar');
  });

  it('skips a message that opens with a markdown heading', () => {
    writeTranscript(['# Brainstorming\n\nYou MUST follow this process.', 'Rework the status dots']);

    expect(getDisplayName(SESSION_ID, configDir)?.name).toBe('Rework the status dots');
  });

  it('skips a skill preamble message', () => {
    writeTranscript([
      'Base directory for this skill: /home/user/.claude/skills/tdd\n\nWrite the test first.',
      'Add retry to the uploader',
    ]);

    expect(getDisplayName(SESSION_ID, configDir)?.name).toBe('Add retry to the uploader');
  });

  it("prefers the text after ARGUMENTS: — the user's own words in a slash-command session", () => {
    writeTranscript([
      '# Some Skill\n\nInstructions the user never typed.\n\nARGUMENTS: make the sidebar readable at a glance',
    ]);

    expect(getDisplayName(SESSION_ID, configDir)).toEqual({
      name: 'make the sidebar readable at a glance',
      source: 'prompt',
    });
  });

  it('falls past an ARGUMENTS: marker with nothing after it', () => {
    writeTranscript(['# Some Skill\n\nARGUMENTS:', 'The real question']);

    expect(getDisplayName(SESSION_ID, configDir)?.name).toBe('The real question');
  });

  it('is null when every user message is preamble', () => {
    writeTranscript(['<command-name>/foo</command-name>', '# Heading only']);

    expect(getDisplayName(SESSION_ID, configDir)).toBeNull();
  });

  it('collapses whitespace and truncates long names', () => {
    writeTranscript([`Please   ${'x'.repeat(80)}`]);

    const result = getDisplayName(SESSION_ID, configDir);
    expect(result?.name.length).toBeLessThanOrEqual(60);
    expect(result?.name.endsWith('…')).toBe(true);
    expect(result?.name.startsWith('Please x')).toBe(true);
  });
});

describe('getDisplayName from the index', () => {
  it("prefers the CLI's own summary and marks it as such", () => {
    writeTranscript(['Fix the login redirect loop']);
    fs.writeFileSync(
      path.join(projectDir, 'sessions-index.json'),
      JSON.stringify({
        version: 1,
        entries: [{ sessionId: SESSION_ID, summary: 'Login redirect fix' }],
      })
    );

    expect(getDisplayName(SESSION_ID, configDir)).toEqual({
      name: 'Login redirect fix',
      source: 'summary',
    });
  });

  it('an index entry with no summary yet still yields a prompt-sourced name', () => {
    writeTranscript(['Fix the login redirect loop']);
    fs.writeFileSync(
      path.join(projectDir, 'sessions-index.json'),
      JSON.stringify({
        version: 1,
        entries: [{ sessionId: SESSION_ID, summary: '', firstPrompt: 'Fix the login redirect loop' }],
      })
    );

    expect(getDisplayName(SESSION_ID, configDir)).toEqual({
      name: 'Fix the login redirect loop',
      source: 'prompt',
    });
  });
});

describe('readRecentReplies', () => {
  const user = (content: unknown, extra = {}) =>
    JSON.stringify({ type: 'user', message: { role: 'user', content }, ...extra });
  const assistant = (content: unknown[], extra = {}) =>
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content }, ...extra });
  const text = (t: string) => ({ type: 'text', text: t });
  const write = (lines: string[]) =>
    fs.writeFileSync(path.join(projectDir, `${SESSION_ID}.jsonl`), lines.join('\n') + '\n');

  it('returns the last replies, one per turn, oldest first', async () => {
    write([
      user('review #4221'),
      assistant([text('Looking.')]),
      assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]),
      user([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
      assistant([text('Two issues found.')]),
      user('thanks'),
      assistant([text('Done.')]),
    ]);
    expect(await readRecentReplies(SESSION_ID, configDir, 3)).toEqual([
      'Looking.\n\nTwo issues found.',
      'Done.',
    ]);
    expect(await readRecentReplies(SESSION_ID, configDir, 1)).toEqual(['Done.']);
  });

  it('skips subagent sidechains, turns with no text and partial lines', async () => {
    write([
      user('first'),
      assistant([text('Real.')]),
      assistant([text('Subagent chatter.')], { isSidechain: true }),
      user('second'),
      assistant([{ type: 'tool_use', id: 't2', name: 'Bash', input: {} }]),
      '{"type":"assistant","message":{"content":[{"type":"te',
    ]);
    expect(await readRecentReplies(SESSION_ID, configDir, 5)).toEqual(['Real.']);
  });

  it('keeps the end of a very long reply', async () => {
    write([user('go'), assistant([text('x'.repeat(MAX_REPLY_CHARS * 2) + 'THE END')])]);
    const [reply] = (await readRecentReplies(SESSION_ID, configDir, 1))!;
    expect(reply.length).toBe(MAX_REPLY_CHARS);
    expect(reply.startsWith('…')).toBe(true);
    expect(reply.endsWith('THE END')).toBe(true);
  });

  it('counts a meta user record as context, never as a turn start', async () => {
    write([
      user('review #4221'),
      assistant([text('Looking.')]),
      user('<system-reminder>injected</system-reminder>', { isMeta: true }),
      assistant([text('Two issues found.')]),
    ]);
    expect(await readRecentReplies(SESSION_ID, configDir, 5)).toEqual([
      'Looking.\n\nTwo issues found.',
    ]);
  });

  it('reads replies that span the backwards chunk boundary', async () => {
    // Each turn is ~30 KB, so 6 turns cross several 64 KB chunks and lines
    // straddle every boundary. Multi-byte text checks split characters too.
    const lines: string[] = [];
    for (let n = 0; n < 6; n++) {
      lines.push(user(`prompt ${n}`));
      lines.push(assistant([text(`reply ${n} ` + 'é✦'.repeat(5_000) + ` end${n}`)]));
    }
    write(lines);
    const replies = (await readRecentReplies(SESSION_ID, configDir, 4))!;
    expect(replies).toHaveLength(4);
    replies.forEach((reply, i) => {
      const n = i + 2;
      expect(reply.endsWith(`end${n}`)).toBe(true);
    });
    expect(await readRecentReplies(SESSION_ID, configDir, 20)).toHaveLength(6);
  });

  it('returns nothing for a count of zero', async () => {
    write([user('go'), assistant([text('Hi.')])]);
    expect(await readRecentReplies(SESSION_ID, configDir, 0)).toEqual([]);
  });

  it('is null without a transcript', async () => {
    expect(await readRecentReplies('missing', configDir, 3)).toBeNull();
  });
});
