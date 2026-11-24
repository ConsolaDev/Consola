import { describe, expect, it } from 'vitest';
import type { ConversationEntry } from '../../shared/conversation';
import type { ConversationLink, Session } from '../../shared/workspace';
import { handoffPrompt, MAX_HANDOFF_CHARS, openingFor, renderHandoff } from './handoff';
import type { HandoffContext } from './handoff';

const context: HandoffContext = {
  sessionName: 'Fix the flaky test',
  from: 'Claude - Personal',
  to: 'Codex',
  folder: '/code/repo',
  switchedAt: new Date('2026-11-17T21:00:00Z'),
};

describe('renderHandoff', () => {
  it('writes the conversation as history the next agent can read', () => {
    const entries: ConversationEntry[] = [
      { kind: 'prompt', text: 'Fix the flaky test', at: '2026-11-17T20:00:00Z' },
      { kind: 'step', tool: 'Bash', detail: 'npm test `--watch`' },
      { kind: 'step', tool: 'Edit', detail: 'src/a.test.ts', failed: true },
      { kind: 'text', text: 'It was a race in the setup.' },
      { kind: 'prompt', text: 'Now add a regression test' },
    ];
    const markdown = renderHandoff({ entries, truncated: false }, context);

    expect(markdown).toBe(
      [
        '---',
        'consola-handoff: 1',
        'session: "Fix the flaky test"',
        'from: "Claude - Personal"',
        'to: "Codex"',
        'switched: 2026-11-17T21:00:00.000Z',
        'folder: "/code/repo"',
        'previous: none',
        'truncated: false',
        '---',
        '',
        '# Conversation handed over from Claude - Personal',
        '',
        'This session ran on Claude - Personal until it switched to Codex. What follows is that conversation, ' +
          'as history: the prompts, the replies, and the tools the agent used, without what those tools ' +
          'returned. The working folder (/code/repo) may be further along than this describes.',
        '',
        '## User · 2026-11-17 20:00 UTC',
        '',
        'Fix the flaky test',
        '',
        "- `Bash` npm test '--watch'",
        '- `Edit` src/a.test.ts — failed',
        '',
        '## Agent',
        '',
        'It was a race in the setup.',
        '',
        '## User',
        '',
        'Now add a regression test',
        '',
      ].join('\n'),
    );
  });

  it('points back at the handoff this conversation began from', () => {
    const markdown = renderHandoff(
      { entries: [{ kind: 'prompt', text: 'Read the handoff' }], truncated: false },
      { ...context, previous: '/data/handoffs/s/1-personal.md' },
    );
    expect(markdown).toContain('previous: "/data/handoffs/s/1-personal.md"');
    expect(markdown).toContain('the earlier part is in /data/handoffs/s/1-personal.md');
  });

  it('drops the oldest replies past its budget, never the opening prompt, and says so', () => {
    const big = 'x'.repeat(MAX_HANDOFF_CHARS / 4);
    const entries: ConversationEntry[] = [
      { kind: 'prompt', text: 'The goal' },
      ...Array.from(
        { length: 6 },
        (_, index): ConversationEntry => ({ kind: 'text', text: `${index}${big}` }),
      ),
    ];
    const markdown = renderHandoff({ entries, truncated: false }, context);

    expect(markdown.length).toBeLessThan(MAX_HANDOFF_CHARS + 2_000);
    expect(markdown).toContain('The goal');
    expect(markdown).toContain(`5${big}`);
    expect(markdown).not.toContain(`0${big}`);
    expect(markdown).toContain('truncated: true');
    expect(markdown).toContain(
      '_Part of the middle of this conversation was too long to include._',
    );
  });

  it('carries the reader’s own truncation through', () => {
    const markdown = renderHandoff(
      { entries: [{ kind: 'prompt', text: 'Go' }], truncated: true },
      context,
    );
    expect(markdown).toContain('truncated: true');
  });
});

describe('handoffPrompt', () => {
  it('names where the transcript is and what to do with it, and no CLI', () => {
    const prompt = handoffPrompt('/data/handoffs/s/1-personal.md');
    expect(prompt).toContain('/data/handoffs/s/1-personal.md');
    expect(prompt).toMatch(/Read all of it/);
    expect(prompt).toMatch(/without redoing finished work/);
    expect(prompt).not.toMatch(/Claude|Codex|had to stop/);
    expect(prompt).not.toContain('\n');
  });
});

describe('openingFor', () => {
  const base: Session = {
    id: 's',
    name: 'n',
    workspaceId: 'w',
    instanceId: 'i',
    claudeSessionId: 'current',
    hasStarted: true,
    harnessId: 'work',
    scopeId: 'scope',
    kind: 'interactive',
    createdAt: 0,
    lastActiveAt: 0,
  };
  const link = (fields: Partial<ConversationLink>): ConversationLink => ({
    harnessId: 'personal',
    claudeSessionId: 'before',
    continuedAs: 'current',
    endedAt: 1,
    carried: 'native',
    ...fields,
  });

  it('forks again from what a native switch carried', () => {
    expect(openingFor({ ...base, priorConversations: [link({})] })).toEqual({ forkFrom: 'before' });
  });

  it('hands over again what a handoff carried', () => {
    const opening = openingFor({
      ...base,
      priorConversations: [link({ carried: 'handoff', handoffPath: '/h/1.md' })],
    });
    expect(opening).toEqual({ prompt: handoffPrompt('/h/1.md') });
  });

  it('is nothing for a conversation no switch began, such as a fresh one since', () => {
    expect(openingFor(base)).toBeUndefined();
    expect(
      openingFor({ ...base, priorConversations: [link({ continuedAs: 'an-earlier-one' })] }),
    ).toBeUndefined();
  });
});
