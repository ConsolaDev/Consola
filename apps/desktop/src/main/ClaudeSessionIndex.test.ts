import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  copyConversation,
  MAX_CONVERSATION_ENTRIES,
  MAX_ENTRY_CHARS,
  readConversation,
  readCustomTitleSince,
  readFirstUserPrompt,
} from './ClaudeSessionIndex';

/**
 * Exercised through a real on-disk config directory: the module reads
 * Claude's own storage, so the fixture is the storage format itself. Each
 * test gets a fresh directory.
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
    JSON.stringify({ type: 'user', message: { role: 'user', content } }),
  );
  fs.writeFileSync(path.join(projectDir, `${SESSION_ID}.jsonl`), lines.join('\n') + '\n');
}

const file = () => path.join(projectDir, `${SESSION_ID}.jsonl`);
const write = (...records: unknown[]) =>
  fs.writeFileSync(file(), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
const append = (...records: unknown[]) =>
  fs.appendFileSync(file(), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
const user = (content: unknown) => ({ type: 'user', message: { role: 'user', content } });
const meta = (content: unknown) => ({ ...user(content), isMeta: true });
const side = (content: unknown) => ({ ...user(content), isSidechain: true });
const title = (customTitle: string) => ({
  type: 'custom-title',
  customTitle,
  sessionId: SESSION_ID,
});
const assistant = () => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
});

describe('readFirstUserPrompt', () => {
  const read = () => readFirstUserPrompt(SESSION_ID, configDir);

  it('returns the first prompt the person typed', async () => {
    write(user('  Design the session sidebar \n'));
    expect(await read()).toBe('Design the session sidebar');
  });

  it('joins text blocks with a space', async () => {
    write(
      user([
        { type: 'text', text: 'Look at' },
        { type: 'image', source: {} },
        { type: 'text', text: 'this' },
      ]),
    );
    expect(await read()).toBe('Look at this');
  });

  it('uses a skill command’s arguments, and skips a command without any', async () => {
    const cmd = (args: string) =>
      user(
        `<command-message>fix-bug</command-message>\n<command-name>/fix-bug</command-name>\n<command-args>${args}</command-args>`,
      );
    write(cmd(''), cmd('the login crash'));
    expect(await read()).toBe('the login crash');
  });

  it('skips built-in commands, their output, meta, sidechains, images, tool results, bash and memory lines', async () => {
    write(
      user(
        '<command-name>/rename</command-name>\n<command-message>rename</command-message>\n<command-args>Mine</command-args>',
      ),
      user('<local-command-stdout>Renamed</local-command-stdout>'),
      meta('# Skill text'),
      side('subagent ask'),
      user([{ type: 'image', source: {} }]),
      user([{ type: 'tool_result', content: 'x' }]),
      user('<bash-input>ls</bash-input>'),
      user('<task-notification>done</task-notification>'),
      user('Base directory for this skill: /x'),
      user('# remember this'),
      assistant(),
      user('The real question'),
    );
    expect(await read()).toBe('The real question');
  });

  it('is null with no transcript, and with only a partial last line', async () => {
    expect(await read()).toBeNull();
    fs.writeFileSync(file(), '{"type":"user","message":{"content":"Half');
    expect(await read()).toBeNull();
  });

  it('skips an unparsable line and a partial last line, and uses the next complete message', async () => {
    fs.writeFileSync(
      file(),
      `not json\n${JSON.stringify(user('Whole one'))}\n{"type":"user","message":{"content":"Half`,
    );
    expect(await read()).toBe('Whole one');
  });
});

describe('readCustomTitleSince', () => {
  it('returns the latest custom title and a position past the last complete line', async () => {
    write(title('A'), user('x'), title('B'));
    const first = await readCustomTitleSince(SESSION_ID, configDir, 0);
    expect(first).toEqual({ name: 'B', next: fs.statSync(file()).size });
  });

  it('reads only what was appended since, and reports no name when nothing new names one', async () => {
    write(title('A'));
    const { next } = (await readCustomTitleSince(SESSION_ID, configDir, 0))!;
    append(user('y'));
    expect((await readCustomTitleSince(SESSION_ID, configDir, next))!.name).toBeNull();
    append(title('C'));
    expect((await readCustomTitleSince(SESSION_ID, configDir, next))!.name).toBe('C');
  });

  it('does not consume a partial last line', async () => {
    write(user('x'));
    fs.appendFileSync(file(), '{"type":"custom-title","customTitle":"Hal');
    const r = (await readCustomTitleSince(SESSION_ID, configDir, 0))!;
    expect(r.name).toBeNull();
    expect(r.next).toBeLessThan(fs.statSync(file()).size);
  });

  it('completes the line once the rest is written', async () => {
    write(user('x'));
    fs.appendFileSync(file(), '{"type":"custom-title","customTitle":"Hal');
    const { next } = (await readCustomTitleSince(SESSION_ID, configDir, 0))!;
    fs.appendFileSync(file(), 'f"}\n');
    expect((await readCustomTitleSince(SESSION_ID, configDir, next))!.name).toBe('Half');
  });

  it('restarts from 0 when the position is past the end', async () => {
    write(title('Fresh'));
    const r = await readCustomTitleSince(SESSION_ID, configDir, 10_000);
    expect(r).toEqual({ name: 'Fresh', next: fs.statSync(file()).size });
  });

  it('finds a title in a file larger than one read chunk', async () => {
    write(user('x'.repeat(200_000)), title('Late'));
    expect((await readCustomTitleSince(SESSION_ID, configDir, 0))!.name).toBe('Late');
  });

  it('is null with no transcript', async () => {
    expect(await readCustomTitleSince(SESSION_ID, configDir, 0)).toBeNull();
  });
});

describe('readConversation', () => {
  function writeRecords(records: unknown[], raw = ''): void {
    fs.writeFileSync(
      path.join(projectDir, `${SESSION_ID}.jsonl`),
      records.map((r) => JSON.stringify(r)).join('\n') + '\n' + raw,
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
      {
        type: 'user',
        timestamp: '2026-11-12T10:00:00Z',
        message: { role: 'user', content: 'Review PR 12' },
      },
      { type: 'user', isMeta: true, message: { role: 'user', content: 'injected context' } },
      assistant([{ type: 'thinking', thinking: 'hmm' }], '2026-11-12T10:00:01Z'),
      assistant(
        [{ type: 'text', text: 'Looking.' }, toolUse('Read', { file_path: '/repo/a.ts' })],
        '2026-11-12T10:00:02Z',
      ),
      {
        type: 'user',
        timestamp: '2026-11-12T10:00:03Z',
        message: { role: 'user', content: [{ type: 'tool_result', content: 'file body' }] },
      },
      assistant([toolUse('Bash', { command: 'ls' })], '2026-11-12T10:00:03Z', {
        isSidechain: true,
      }),
      assistant(
        [toolUse('mcp__consola__consola_work_item_context', {}), { type: 'text', text: 'Done.' }],
        '2026-11-12T10:00:04Z',
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

  it('marks when each step came back, and the steps whose result was an error', async () => {
    const result = (id: string, timestamp: string, isError?: boolean) => ({
      type: 'user',
      timestamp,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: id,
            content: 'out',
            ...(isError ? { is_error: true } : {}),
          },
        ],
      },
    });
    writeRecords([
      assistant(
        [
          { ...toolUse('Read', { file_path: '/a' }), id: 'call-1' },
          { ...toolUse('Bash', { command: 'pnpm test' }), id: 'call-2' },
        ],
        '2026-11-12T10:00:01Z',
      ),
      result('call-1', '2026-11-12T10:00:02Z'),
      result('call-2', '2026-11-12T10:00:40Z', true),
      // Still running when the transcript was read: no result yet.
      assistant([{ ...toolUse('Grep', { pattern: 'x' }), id: 'call-3' }], '2026-11-12T10:00:41Z'),
      // A result for a call outside what was read changes nothing.
      result('call-elsewhere', '2026-11-12T10:00:42Z', true),
    ]);

    const conversation = await readConversation(SESSION_ID, configDir);

    expect(conversation!.entries).toEqual([
      {
        kind: 'step',
        tool: 'Read',
        detail: '/a',
        at: '2026-11-12T10:00:01Z',
        endedAt: '2026-11-12T10:00:02Z',
      },
      {
        kind: 'step',
        tool: 'Bash',
        detail: 'pnpm test',
        at: '2026-11-12T10:00:01Z',
        endedAt: '2026-11-12T10:00:40Z',
        failed: true,
      },
      { kind: 'step', tool: 'Grep', detail: 'x', at: '2026-11-12T10:00:41Z' },
    ]);
  });

  it("picks a step's detail from file_path, path, pattern, command, url, skill, description, query, in that order", async () => {
    const keys = [
      'file_path',
      'path',
      'pattern',
      'command',
      'url',
      'skill',
      'description',
      'query',
    ];
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
    writeRecords(
      [assistant([{ type: 'text', text: 'complete' }])],
      '{"type":"assistant","message":{"con',
    );

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

describe('copyConversation', () => {
  let otherDir: string;

  beforeEach(() => {
    otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-index-other-'));
  });

  afterEach(() => {
    fs.rmSync(otherDir, { recursive: true, force: true });
  });

  const copied = (file: string) =>
    path.join(otherDir, 'projects', '-Users-someone-code-repo', file);

  it('copies the transcript and its sibling folder into the same project folder', async () => {
    writeTranscript(['Fix the login redirect loop']);
    fs.mkdirSync(path.join(projectDir, SESSION_ID, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, SESSION_ID, 'subagents', 'agent-1.jsonl'), '{}\n');

    expect(await copyConversation(SESSION_ID, configDir, otherDir)).toBe('copied');

    expect(fs.readFileSync(copied(`${SESSION_ID}.jsonl`), 'utf8')).toBe(
      fs.readFileSync(path.join(projectDir, `${SESSION_ID}.jsonl`), 'utf8'),
    );
    expect(fs.existsSync(copied(path.join(SESSION_ID, 'subagents', 'agent-1.jsonl')))).toBe(true);
    // Nothing half-written is left beside it.
    expect(
      fs.readdirSync(path.dirname(copied('x'))).filter((name) => name.endsWith('.partial')),
    ).toEqual([]);
    // And the copy is found where Claude will look.
    expect(await readFirstUserPrompt(SESSION_ID, otherDir)).toBe('Fix the login redirect loop');
  });

  it('never overwrites a conversation the target already holds', async () => {
    writeTranscript(['Fresh text from the source']);
    fs.mkdirSync(path.dirname(copied('x')), { recursive: true });
    fs.writeFileSync(copied(`${SESSION_ID}.jsonl`), 'already here\n');

    expect(await copyConversation(SESSION_ID, configDir, otherDir)).toBe('present');
    expect(fs.readFileSync(copied(`${SESSION_ID}.jsonl`), 'utf8')).toBe('already here\n');
  });

  it('is a no-op when both harnesses share one config directory', async () => {
    writeTranscript(['Shared']);
    expect(await copyConversation(SESSION_ID, configDir, configDir)).toBe('present');
  });

  it('says so, and writes nothing, when there is no transcript to carry yet', async () => {
    expect(await copyConversation(SESSION_ID, configDir, otherDir)).toBe('missing');
    expect(fs.existsSync(path.join(otherDir, 'projects'))).toBe(false);
  });
});
