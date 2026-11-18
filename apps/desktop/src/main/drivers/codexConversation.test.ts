import { describe, expect, it } from 'vitest';
import { codexConversationFromLines } from './codexConversation';

/** One rollout line, as Codex writes it. */
const line = (timestamp: string, payload: Record<string, unknown>, type = 'response_item') =>
  JSON.stringify({ timestamp, type, payload, ordinal: 1 });

const user = (text: string) => ({
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text }],
});
const assistant = (text: string) => ({
  type: 'message',
  role: 'assistant',
  content: [{ type: 'output_text', text }],
});

describe('codexConversationFromLines', () => {
  it('reads prompts, replies and tool calls, and leaves out what the person never saw', async () => {
    const record = await codexConversationFromLines([
      line('2026-11-12T10:00:00Z', { id: 'thread', cwd: '/repo' }, 'session_meta'),
      line('2026-11-12T10:00:00Z', {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'rules' }],
      }),
      line('2026-11-12T10:00:00Z', user('# AGENTS.md instructions for /repo\n\nBe nice.')),
      line(
        '2026-11-12T10:00:00Z',
        user('<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>'),
      ),
      line('2026-11-12T10:00:01Z', user('Fix the flaky test')),
      line('2026-11-12T10:00:02Z', { type: 'reasoning', summary: [], encrypted_content: 'x' }),
      line('2026-11-12T10:00:03Z', {
        type: 'function_call',
        name: 'shell',
        call_id: 'c1',
        arguments: JSON.stringify({ command: ['git', 'status'] }),
      }),
      line('2026-11-12T10:00:04Z', {
        type: 'function_call_output',
        call_id: 'c1',
        output: JSON.stringify({ output: 'boom', metadata: { exit_code: 1 } }),
      }),
      line('2026-11-12T10:00:05Z', {
        type: 'custom_tool_call',
        name: 'apply_patch',
        call_id: 'c2',
        input:
          '*** Begin Patch\n*** Update File: src/a.ts\n@@\n*** Add File: src/b.ts\n*** End Patch',
      }),
      line('2026-11-12T10:00:06Z', {
        type: 'custom_tool_call_output',
        call_id: 'c2',
        output: [{ type: 'input_text', text: 'ok' }],
      }),
      line('2026-11-12T10:00:07Z', {
        type: 'custom_tool_call',
        name: 'exec',
        call_id: 'c3',
        input: '\n  text(await tools.exec_command({cmd: "ls"}))\n',
      }),
      line('2026-11-12T10:00:08Z', { type: 'token_count', info: {} }, 'event_msg'),
      line('2026-11-12T10:00:09Z', assistant('Fixed it.')),
      '{"timestamp":"2026-11-12T10:00:10Z","type":"respo',
    ]);

    expect(record).toEqual({
      truncated: false,
      entries: [
        { kind: 'prompt', text: 'Fix the flaky test', at: '2026-11-12T10:00:01Z' },
        {
          kind: 'step',
          tool: 'shell',
          detail: 'git status',
          at: '2026-11-12T10:00:03Z',
          endedAt: '2026-11-12T10:00:04Z',
          failed: true,
        },
        {
          kind: 'step',
          tool: 'apply_patch',
          detail: 'src/a.ts, src/b.ts',
          at: '2026-11-12T10:00:05Z',
          endedAt: '2026-11-12T10:00:06Z',
        },
        {
          kind: 'step',
          tool: 'exec',
          detail: 'text(await tools.exec_command({cmd: "ls"}))',
          at: '2026-11-12T10:00:07Z',
        },
        { kind: 'text', text: 'Fixed it.', at: '2026-11-12T10:00:09Z' },
      ],
    });
  });

  it('keeps only what falls inside the window', async () => {
    const record = await codexConversationFromLines(
      [
        line('2026-11-12T09:00:00Z', user('Before')),
        line('2026-11-12T10:00:00Z', user('During')),
        line('2026-11-12T11:00:00Z', assistant('After')),
      ],
      { since: '2026-11-12T09:30:00Z', until: '2026-11-12T10:30:00Z' },
    );
    expect(record.entries.map((entry) => ('text' in entry ? entry.text : entry.tool))).toEqual([
      'During',
    ]);
  });

  it('throws on a file none of whose lines are rollout records, rather than reading as an empty conversation', async () => {
    await expect(
      codexConversationFromLines([JSON.stringify({ role: 'user', content: 'a different format' })]),
    ).rejects.toThrow(/format Consola does not recognise/);
    // An empty or cut-off file is simply a conversation with nothing in it yet.
    expect(await codexConversationFromLines(['', '{"partial'])).toEqual({
      entries: [],
      truncated: false,
    });
  });
});
