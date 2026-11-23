import { describe, expect, it } from 'vitest';
import type { McpToolInfo } from '../ports';
import { checkServerVerdicts } from './checkServer';

describe('checkServerVerdicts (5a-2 Task 9)', () => {
  const asked: Array<{ tool: string; args: unknown; options: unknown }> = [];
  const session = (problem: string | null = null) => ({
    tools: [{ name: 'chat_post_message' }, { name: 'conversations_history' }] as McpToolInfo[],
    checkArguments: (tool: McpToolInfo, args: unknown, options?: unknown) => {
      asked.push({ tool: tool.name, args, options });
      return problem;
    },
  });

  it("says whether each call's tool is there, asking about its literal values only", () => {
    asked.length = 0;
    expect(
      checkServerVerdicts(
        [
          {
            step: 'post',
            tool: 'chat_post_message',
            with: {
              channel: 'C0SUPPORT1',
              text: '{{steps.brief.handover}}',
              blocks: [{ text: '*Brief:* {{steps.brief.handover}}' }],
            },
          },
          { step: 'other', tool: 'nope', with: {} },
        ],
        session(),
      ),
    ).toEqual([
      { step: 'post', tool: 'chat_post_message', verdict: 'fits' },
      { step: 'other', tool: 'nope', verdict: 'missing' },
    ]);
    expect(asked).toEqual([
      { tool: 'chat_post_message', args: { channel: 'C0SUPPORT1' }, options: { partial: true } },
    ]);
  });

  it("gives a literal that does not fit the server's reason", () => {
    expect(
      checkServerVerdicts(
        [{ step: 'post', tool: 'chat_post_message', with: { channel: 5 } }],
        session('/channel must be string'),
      ),
    ).toEqual([
      { step: 'post', tool: 'chat_post_message', verdict: { problem: '/channel must be string' } },
    ]);
  });
});
