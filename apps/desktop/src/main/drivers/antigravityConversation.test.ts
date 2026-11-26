import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  antigravityConversationFromLines,
  extractUserPrompt,
  readAntigravityFirstPrompt,
  readAntigravityTranscript,
} from './antigravityConversation';

const step = (
  step_index: number,
  type: string,
  created_at: string,
  extra: Record<string, unknown> = {},
) => JSON.stringify({ step_index, type, status: 'DONE', created_at, ...extra });

describe('extractUserPrompt', () => {
  it('unwraps <USER_REQUEST> blocks and ignores surrounding metadata', () => {
    const content =
      '<ADDITIONAL_METADATA>\nThe current time is 2026.\n</ADDITIONAL_METADATA>\n\n' +
      '<USER_REQUEST>\n  Fix the parser bug\n</USER_REQUEST>';
    expect(extractUserPrompt(content)).toBe('Fix the parser bug');
  });

  it('strips metadata blocks from untagged messages and trims plain text', () => {
    expect(
      extractUserPrompt(
        '<USER_SETTINGS_CHANGE>mode=plan</USER_SETTINGS_CHANGE>\n  Explain this repo  ',
      ),
    ).toBe('Explain this repo');
    expect(extractUserPrompt('  Just plain text  ')).toBe('Just plain text');
  });

  it('returns null for empty, metadata-only, or non-string content', () => {
    expect(extractUserPrompt('<USER_REQUEST>   </USER_REQUEST>')).toBeNull();
    expect(extractUserPrompt('<ADDITIONAL_METADATA>meta only</ADDITIONAL_METADATA>')).toBeNull();
    expect(extractUserPrompt(null)).toBeNull();
    expect(extractUserPrompt(42)).toBeNull();
  });
});

describe('antigravityConversationFromLines', () => {
  it('reads prompts, tool calls and replies, and leaves out hidden steps', async () => {
    const record = await antigravityConversationFromLines([
      step(0, 'SYSTEM_MESSAGE', '2026-11-12T10:00:00Z', {
        source: 'SYSTEM',
        content: 'Internal system setup',
      }),
      step(1, 'USER_INPUT', '2026-11-12T10:00:01Z', {
        source: 'SYSTEM',
        content: '<USER_REQUEST>System-injected prompt</USER_REQUEST>',
      }),
      step(2, 'USER_INPUT', '2026-11-12T10:00:02Z', {
        source: 'USER_EXPLICIT',
        content:
          '<ADDITIONAL_METADATA>cwd=/repo</ADDITIONAL_METADATA>\n<USER_REQUEST>Fix the flaky test</USER_REQUEST>',
      }),
      step(3, 'PLANNER_RESPONSE', '2026-11-12T10:00:03Z', {
        source: 'MODEL',
        thinking: 'Secret reasoning text that must not appear',
        tool_calls: [
          {
            name: 'run_command',
            args: { CommandLine: String.raw`"git status\ngit diff"`, toolSummary: '"Git check"' },
          },
          {
            name: 'read_file',
            args: { Path: '"/repo/src/index.ts"' },
          },
          {
            name: 'custom_tool',
            args: {},
          },
        ],
      }),
      step(4, 'GENERIC', '2026-11-12T10:00:04Z', {
        source: 'TOOL',
        content: 'Raw tool output blob',
      }),
      step(5, 'PLANNER_RESPONSE', '2026-11-12T10:00:05Z', {
        source: 'MODEL',
        thinking: 'More hidden reasoning',
        content: 'Fixed the race condition.',
      }),
      '{"step_index":6,"type":"PLANNER_RESPO',
    ]);

    expect(record).toEqual({
      truncated: false,
      entries: [
        { kind: 'prompt', text: 'Fix the flaky test', at: '2026-11-12T10:00:02Z' },
        {
          kind: 'step',
          tool: 'run_command',
          detail: 'git status',
          at: '2026-11-12T10:00:03Z',
        },
        {
          kind: 'step',
          tool: 'read_file',
          detail: '/repo/src/index.ts',
          at: '2026-11-12T10:00:03Z',
        },
        {
          kind: 'step',
          tool: 'custom_tool',
          at: '2026-11-12T10:00:03Z',
        },
        { kind: 'text', text: 'Fixed the race condition.', at: '2026-11-12T10:00:05Z' },
      ],
    });
  });

  it('keeps only entries inside the requested time window', async () => {
    const record = await antigravityConversationFromLines(
      [
        step(0, 'USER_INPUT', '2026-11-12T09:00:00Z', {
          source: 'USER_EXPLICIT',
          content: '<USER_REQUEST>Before</USER_REQUEST>',
        }),
        step(1, 'USER_INPUT', '2026-11-12T10:00:00Z', {
          source: 'USER_EXPLICIT',
          content: '<USER_REQUEST>During</USER_REQUEST>',
        }),
        JSON.stringify({
          step_index: 2,
          type: 'PLANNER_RESPONSE',
          content: 'No timestamp counts as inside',
        }),
        step(3, 'PLANNER_RESPONSE', '2026-11-12T11:00:00Z', {
          content: 'After',
        }),
      ],
      { since: '2026-11-12T09:30:00Z', until: '2026-11-12T10:30:00Z' },
    );
    expect(record.entries.map((entry) => ('text' in entry ? entry.text : entry.tool))).toEqual([
      'During',
      'No timestamp counts as inside',
    ]);
  });

  it('throws on a file none of whose lines are Antigravity steps, while tolerating empty files', async () => {
    await expect(
      antigravityConversationFromLines([
        JSON.stringify({ role: 'user', content: 'some other harness format' }),
      ]),
    ).rejects.toThrow(/format Consola does not recognise/);

    expect(await antigravityConversationFromLines(['', '{"partial'])).toEqual({
      entries: [],
      truncated: false,
    });
  });
});

describe('readAntigravityTranscript and readAntigravityFirstPrompt', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-agy-conv-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('streams transcripts and extracts the first real user prompt from disk', async () => {
    const file = path.join(tmpDir, 'transcript.jsonl');
    fs.writeFileSync(
      file,
      [
        step(0, 'USER_INPUT', '2026-11-12T10:00:00Z', {
          source: 'SYSTEM',
          content: '<USER_REQUEST>Ignored system prompt</USER_REQUEST>',
        }),
        step(1, 'USER_INPUT', '2026-11-12T10:00:01Z', {
          source: 'USER_EXPLICIT',
          content: '<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>',
        }),
        step(2, 'USER_INPUT', '2026-11-12T10:00:02Z', {
          source: 'USER_EXPLICIT',
          content: '<USER_REQUEST>Ship the Antigravity driver</USER_REQUEST>',
        }),
        step(3, 'PLANNER_RESPONSE', '2026-11-12T10:00:03Z', {
          content: 'Done.',
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    expect(await readAntigravityFirstPrompt(file)).toBe('Ship the Antigravity driver');
    expect(await readAntigravityTranscript(file)).toEqual({
      truncated: false,
      entries: [
        { kind: 'prompt', text: 'Ship the Antigravity driver', at: '2026-11-12T10:00:02Z' },
        { kind: 'text', text: 'Done.', at: '2026-11-12T10:00:03Z' },
      ],
    });
    expect(await readAntigravityFirstPrompt(path.join(tmpDir, 'missing.jsonl'))).toBeNull();
  });
});
