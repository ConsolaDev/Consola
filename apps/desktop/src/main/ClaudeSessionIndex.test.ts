import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  getDisplayName,
  MAX_CONVERSATION_ENTRIES,
  MAX_ENTRY_CHARS,
  MAX_REPLY_CHARS,
  readConversation,
  readRecentReplies,
} from './ClaudeSessionIndex';

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

describe('readConversation', () => {
  function writeRecords(records: unknown[], raw = ''): void {
    fs.writeFileSync(
      path.join(projectDir, `${SESSION_ID}.jsonl`),
      records.map((r) => JSON.stringify(r)).join('\n') + '\n' + raw
    );
  }
  const assistant = (content: unknown[], timestamp?: string, extra = {}) => ({
    type: 'assistant',
    timestamp,
    message: { role: 'assistant', content },
    ...extra,
  });
  const toolUse = (name: string, input: unknown) => ({ type: 'tool_use', name, input });

  it('reads the prompt, each tool call with its main argument, and the text, in order', async () => {
    writeRecords([
      { type: 'user', timestamp: '2026-11-12T10:00:00Z', message: { role: 'user', content: 'Review PR 12' } },
      { type: 'user', isMeta: true, message: { role: 'user', content: 'injected context' } },
      assistant([{ type: 'thinking', thinking: 'hmm' }], '2026-11-12T10:00:01Z'),
      assistant(
        [{ type: 'text', text: 'Looking.' }, toolUse('Read', { file_path: '/repo/a.ts' })],
        '2026-11-12T10:00:02Z'
      ),
      {
        type: 'user',
        timestamp: '2026-11-12T10:00:03Z',
        message: { role: 'user', content: [{ type: 'tool_result', content: 'file body' }] },
      },
      assistant([toolUse('Bash', { command: 'ls' })], '2026-11-12T10:00:03Z', { isSidechain: true }),
      assistant(
        [toolUse('mcp__consola__consola_work_item_context', {}), { type: 'text', text: 'Done.' }],
        '2026-11-12T10:00:04Z'
      ),
    ]);

    const result = await readConversation(SESSION_ID, configDir);

    expect(result).toEqual({
      truncated: false,
      entries: [
        { kind: 'prompt', text: 'Review PR 12', at: '2026-11-12T10:00:00Z' },
        { kind: 'text', text: 'Looking.', at: '2026-11-12T10:00:02Z' },
        { kind: 'step', tool: 'Read', detail: '/repo/a.ts', at: '2026-11-12T10:00:02Z' },
        { kind: 'step', tool: 'consola_work_item_context', at: '2026-11-12T10:00:04Z' },
        { kind: 'text', text: 'Done.', at: '2026-11-12T10:00:04Z' },
      ],
    });
  });

  it("picks a step's detail from file_path, path, pattern, command, url, skill, description, query, in that order", async () => {
    const keys = ['file_path', 'path', 'pattern', 'command', 'url', 'skill', 'description', 'query'];
    const calls = keys.map((_, i) => {
      // Everything from key i onwards is present: the earliest must win.
      const input: Record<string, string> = {};
      for (const key of keys.slice(i)) input[key] = `${key} value`;
      return toolUse('T', input);
    });
    calls.push(toolUse('T', { command: `first line ${'x'.repeat(200)}\nsecond line` }));
    writeRecords([assistant(calls)]);

    const result = await readConversation(SESSION_ID, configDir);

    const details = result!.entries.map((e) => (e.kind === 'step' ? e.detail : undefined));
    expect(details.slice(0, 8)).toEqual(keys.map((key) => `${key} value`));
    expect(details[8]).toBe(`first line ${'x'.repeat(200)}`.slice(0, 120));
  });

  it('keeps only records inside the window', async () => {
    const at = (second: number) => `2026-11-12T10:00:0${second}Z`;
    writeRecords([
      assistant([{ type: 'text', text: 'before' }], at(1)),
      assistant([{ type: 'text', text: 'inside' }], at(3)),
      assistant([{ type: 'text', text: 'after' }], at(5)),
    ]);

    const bounded = await readConversation(SESSION_ID, configDir, { since: at(2), until: at(4) });
    const open = await readConversation(SESSION_ID, configDir, { since: at(2) });

    expect(bounded!.entries.map((e) => (e as { text: string }).text)).toEqual(['inside']);
    expect(open!.entries.map((e) => (e as { text: string }).text)).toEqual(['inside', 'after']);
  });

  it('treats a record without a timestamp as inside the window', async () => {
    writeRecords([assistant([{ type: 'text', text: 'undated' }])]);

    const result = await readConversation(SESSION_ID, configDir, { since: '2026-11-12T10:00:00Z' });

    expect(result!.entries).toHaveLength(1);
  });

  it('skips an unparsable line, such as one mid-write', async () => {
    writeRecords([assistant([{ type: 'text', text: 'complete' }])], '{"type":"assistant","message":{"con');

    const result = await readConversation(SESSION_ID, configDir);

    expect(result!.entries).toEqual([{ kind: 'text', text: 'complete' }]);
  });

  it('caps entries and text', async () => {
    writeRecords([
      { type: 'user', message: { role: 'user', content: 'Do the thing' } },
      assistant(Array.from({ length: 2500 }, (_, i) => toolUse('Read', { file_path: `/f${i}` }))),
      assistant([{ type: 'text', text: 'final answer' }]),
    ]);
    const capped = await readConversation(SESSION_ID, configDir);
    expect(capped!.entries).toHaveLength(MAX_CONVERSATION_ENTRIES);
    expect(capped!.truncated).toBe(true);
    expect(capped!.entries[0]).toEqual({ kind: 'prompt', text: 'Do the thing' });
    expect(capped!.entries[1]).toEqual({ kind: 'step', tool: 'Read', detail: '/f502' });
    expect(capped!.entries.at(-1)).toEqual({ kind: 'text', text: 'final answer' });

    writeRecords([assistant([{ type: 'text', text: 'y'.repeat(30_000) }])]);
    const long = await readConversation(SESSION_ID, configDir);
    const text = (long!.entries[0] as { text: string }).text;
    expect(text).toHaveLength(MAX_ENTRY_CHARS);
    expect(text.endsWith('…')).toBe(true);
    expect(long!.truncated).toBe(false);
  });

  it('is null when there is no transcript', async () => {
    expect(await readConversation(SESSION_ID, configDir)).toBeNull();
  });
});
