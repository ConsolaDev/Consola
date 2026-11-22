import { describe, expect, it } from 'vitest';
import type { AgentStep } from '@consola/factory-spec';
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
});
