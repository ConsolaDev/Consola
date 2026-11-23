import { describe, expect, it } from 'vitest';
import type { AgentStep, UsesStep } from '@consola/factory-spec';
import { describeEvery, describeSteps } from './describeEntry';

describe('describeEvery', () => {
  it.each([
    [30 * 60_000, { words: '30 minutes', short: '30m' }],
    [60 * 60_000, { words: '1 hour', short: '1h' }],
    [90 * 60_000, { words: '90 minutes', short: '90m' }],
    [120 * 60_000, { words: '2 hours', short: '2h' }],
  ])('%i ms reads as %o', (ms, words) => {
    expect(describeEvery(ms)).toEqual(words);
  });
});

describe('describeSteps', () => {
  const step = (fields: Partial<AgentStep>): AgentStep => ({
    id: 'investigate',
    named: true,
    kind: 'agent',
    outputs: {},
    artifacts: [],
    reads: [],
    handover: 'optional',
    ...fields,
  });

  it("names an agent-only step by its agent, and keeps a prompt's and an action's words", () => {
    expect(
      describeSteps([
        step({ agent: 'investigator' }),
        step({ id: 'summarise', agent: 'summariser', prompt: 'Write the reply.' }),
        step({ id: 'review', agent: 'reviewer', action: 'Review' }),
        step({ id: 'plain', prompt: 'Read it.' }),
      ]).map((described) => described.summary),
    ).toEqual(['investigator', 'Prompt', 'Review action', 'Prompt']);
  });

  it("gives an agent step its agent's words and file, and a step without one neither", () => {
    const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
    const described = describeSteps(
      [
        step({ agent: 'investigator' }),
        step({ id: 'summarise', agent: 'summariser', prompt: 'Write the reply.' }),
        step({ id: 'review', agent: 'investigator', action: 'Review' }),
        step({ id: 'tidy', agent: 'tidier' }),
        step({ id: 'plain', prompt: 'Read it.' }),
      ],
      {
        investigator: { harness: 'claude-work', model: 'opus' },
        summariser: {},
        tidier: { model: 'haiku' },
      },
    );
    expect(
      described.map(({ summary, agent, agentFile }) => ({ summary, agent, agentFile })),
    ).toEqual([
      {
        summary: 'investigator · claude-work · opus',
        agent: 'investigator · claude-work · opus',
        agentFile: 'agents/investigator.md',
      },
      { summary: 'Prompt', agent: 'summariser', agentFile: 'agents/summariser.md' },
      {
        summary: 'Review action',
        agent: 'investigator · claude-work · opus',
        agentFile: 'agents/investigator.md',
      },
      { summary: 'tidier · haiku', agent: 'tidier · haiku', agentFile: 'agents/tidier.md' },
      { summary: 'Prompt', agent: undefined, agentFile: undefined },
    ]);
    expect(own(described[4], 'agent')).toBe(false);
    expect(own(described[4], 'agentFile')).toBe(false);
  });

  it("gives an agent step its agent's servers and skills as the agent file has them (2-C, review S3)", () => {
    const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
    const described = describeSteps(
      [step({ agent: 'investigator' }), step({ id: 'summarise', agent: 'summariser' })],
      {
        investigator: {
          harness: 'stub-work',
          mcpServers: [{ name: 'claude.ai Coralogix' }, { name: 'grafana', tools: ['query_logs'] }],
          skills: ['incident-triage'],
        },
        summariser: { mcpServers: [], skills: [] },
      },
    );
    expect(described[0]).toMatchObject({
      servers: [{ name: 'claude.ai Coralogix' }, { name: 'grafana', tools: ['query_logs'] }],
      skills: ['incident-triage'],
    });
    expect(own(described[0].servers![0], 'tools')).toBe(false);
    // An agent naming neither, and 2-B's map (no servers or skills key), give neither key.
    expect(own(described[1], 'servers')).toBe(false);
    expect(own(described[1], 'skills')).toBe(false);
    const twoB = describeSteps([step({ agent: 'investigator' })], {
      investigator: { harness: 'claude-work' },
    });
    expect(own(twoB[0], 'servers')).toBe(false);
    expect(own(twoB[0], 'skills')).toBe(false);
  });

  it('names an agent the map lacks by its name alone', () => {
    expect(describeSteps([step({ agent: 'investigator' })])[0]).toMatchObject({
      summary: 'investigator',
      agent: 'investigator',
      agentFile: 'agents/investigator.md',
    });
  });

  it('names a call by its server and tool, and marks one that runs in a dry run (5a-2)', () => {
    const post = (fields: Partial<UsesStep> = {}): UsesStep => ({
      id: 'post',
      named: true,
      kind: 'uses',
      uses: 'slack#chat_post_message',
      server: 'slack',
      tool: 'chat_post_message',
      with: {},
      outputs: {},
      timeoutMs: 60_000,
      dryRun: 'report',
      ...fields,
    });
    expect(describeSteps([post()])).toEqual([
      { id: 'post', kind: 'uses', summary: 'slack#chat_post_message' },
    ]);
    expect(describeSteps([post({ dryRun: 'run' })])).toEqual([
      { id: 'post', kind: 'uses', summary: 'slack#chat_post_message', dryRun: true },
    ]);
  });
});
