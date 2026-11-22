import { describe, expect, it } from 'vitest';
import {
  parseFactorySpec,
  type AgentStep,
  type Automation,
  type GateStep,
} from '@consola/factory-spec';
import {
  describeEvery,
  describeKind,
  describeRun,
  describeSteps,
  dryRunStarts,
} from './describeEntry';

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

  it('describes a gate by its question, with its choices and no command', () => {
    const gate: GateStep = {
      id: 'decide',
      named: true,
      kind: 'gate',
      if: "steps.investigate.verdict == 'approve'",
      ask: 'Post it as an approval?',
      show: ['investigate.handover'],
      choices: ['approve', 'comment'],
    };
    expect(describeSteps([gate, { ...gate, id: 'plain', choices: undefined }])).toEqual([
      {
        id: 'decide',
        kind: 'gate',
        if: "steps.investigate.verdict == 'approve'",
        summary: 'Post it as an approval?',
        ask: 'Post it as an approval?',
        choices: ['approve', 'comment'],
      },
      {
        id: 'plain',
        kind: 'gate',
        if: "steps.investigate.verdict == 'approve'",
        summary: 'Post it as an approval?',
        ask: 'Post it as an approval?',
      },
    ]);
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
});

/** One parsed entry on review requests whose steps are the given lines. */
function looped(...lines: string[]): Automation {
  const result = parseFactorySpec(
    `version: 1\nautomations:\n  - name: a\n    on: { github: pull_request.review_requested }\n    steps:\n${lines
      .map((line) => `      ${line.replace(/\n/g, '\n      ')}`)
      .join('\n')}\n`,
  );
  if (result.issues.length > 0) throw new Error(JSON.stringify(result.issues));
  return result.automations[0];
}

const POLISH = [
  '- id: polish',
  '  repeat: { max: 3, until: steps.review.findings == 0 }',
  '  on_exhausted: { gate: "Open it anyway?" }',
  '  steps:',
  '    - id: review\n      prompt: Review it.\n      outputs: { findings: integer }',
  '    - id: address\n      if: steps.review.findings > 0\n      run: echo\n      dry_run: run',
].join('\n');

describe('an entry with a loop (slice 3)', () => {
  it('is an agent entry when its only agent step is inside the loop', () => {
    expect(describeKind(looped('- id: fetch\n  run: gh pr view', POLISH))).toBe('agent');
    expect(describeKind(looped('- id: fetch\n  run: gh pr view'))).toBe('tool');
  });

  it("says what it runs with the loop's steps in line", () => {
    expect(describeRun(looped('- id: fetch\n  run: gh pr view', POLISH))).toBe(
      'Steps: fetch → review → address',
    );
  });

  it('describes the loop, then its steps marked with it', () => {
    const automation = looped('- id: fetch\n  run: gh pr view', POLISH, '- id: pr\n  run: echo');
    if (!automation.steps) throw new Error('steps');
    const described = describeSteps(automation.steps);
    expect(described.map(({ id, kind, loop }) => [id, kind, loop])).toEqual([
      ['fetch', 'run', undefined],
      ['polish', 'repeat', undefined],
      ['review', 'agent', 'polish'],
      ['address', 'run', 'polish'],
      ['pr', 'run', undefined],
    ]);
    expect(described[1]).toEqual({
      id: 'polish',
      kind: 'repeat',
      summary: 'up to 3 rounds · until review.findings == 0',
      max: 3,
      until: 'steps.review.findings == 0',
      exhausted: 'gate',
    });
  });

  it("counts a loop's agent, or its dry_run: run command, as starting in a dry run", () => {
    const inner = (step: string) =>
      looped(
        `- id: polish\n  repeat: { max: 2, until: steps.s.ok }\n  steps:\n    - id: s\n${step.replace(/^/gm, '      ')}\n      outputs: { ok: boolean }`,
      );
    expect(dryRunStarts(inner('prompt: Look.').steps!)).toBe(true);
    expect(dryRunStarts(inner('run: echo\ndry_run: run').steps!)).toBe(true);
    expect(dryRunStarts(inner('run: echo').steps!)).toBe(false);
  });
});
