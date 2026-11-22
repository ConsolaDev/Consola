import { describe, expect, it } from 'vitest';
import { parseFactorySpec } from './parse';
import { isStepsEntry } from './schema';
import { gateChoices, type CommandStep, type GateStep } from './steps';

/*
 * Slice 3's control flow in the format: gates, `then: stop`, and (from the
 * next tasks) loops, retries, budgets and an entry's checkout. The helpers
 * are steps.test.ts' own.
 */

/** One entry, its fields indented under `- name: a`. */
const one = (fields: string) =>
  parseFactorySpec(`version: 1\nautomations:\n  - name: a\n${fields}`);

const REVIEW = '    on: { github: pull_request.review_requested }\n';

/** An entry whose steps are the given YAML lines, each already indented as a list item under `steps:`. */
const steps = (...items: string[]) =>
  one(
    `${REVIEW}    steps:\n${items.map((item) => `      ${item.replace(/\n/g, '\n      ')}`).join('\n')}\n`,
  );

/** A single command step with `extra` lines (2-space indented keys, no leading dash). */
const command = (extra = '') => steps(`- run: echo hi${extra ? `\n${extra}` : ''}`);

const firstStep = <T>(result: ReturnType<typeof one>, index = 0) => {
  const automation = result.automations[0];
  if (!automation || !isStepsEntry(automation)) throw new Error(JSON.stringify(result.issues));
  return automation.steps[index] as unknown as T;
};

const only = (result: ReturnType<typeof one>) => {
  expect(result.automations).toEqual([]);
  expect(result.issues).toHaveLength(1);
  return result.issues[0];
};

describe('gate:', () => {
  it('parses a gate with its question, documents and choices', () => {
    const gate = firstStep<GateStep>(
      steps(
        '- id: review\n  prompt: Review it.',
        '- id: decide\n  gate:\n    ask: Post it as an approval?\n    show: [review.handover]\n    choices: [approve, comment]',
      ),
      1,
    );
    expect(gate).toEqual({
      id: 'decide',
      named: true,
      kind: 'gate',
      ask: 'Post it as an approval?',
      show: ['review.handover'],
      choices: ['approve', 'comment'],
    });
  });

  it('parses a gate with only a question: no documents, and no choices key', () => {
    const gate = firstStep<GateStep>(steps('- id: decide\n  gate: { ask: Post it? }'));
    expect(gate).toEqual({ id: 'decide', named: true, kind: 'gate', ask: 'Post it?', show: [] });
    expect(gateChoices(gate)).toEqual(['approve']);
    expect(gateChoices({ choices: ['approve', 'comment'] })).toEqual(['approve', 'comment']);
  });

  it.each([
    ['ask: ""', 'A gate asks 1 to 300 characters of text.'],
    [`ask: ${'x'.repeat(301)}`, 'A gate asks 1 to 300 characters of text.'],
    [
      'ask: ok\n    timeout: 1h',
      'A gate waits for you for as long as it takes; timeouts arrive with waiting runs (slice 4).',
    ],
    [
      'ask: ok\n    choices: [approve]',
      '`choices` lists 2 to 6 words of lowercase letters, digits and dashes, e.g. `[approve, comment]`.',
    ],
    [
      'ask: ok\n    choices: [approve, reject]',
      '`reject` is always offered; name your choices otherwise.',
    ],
    [
      'ask: ok\n    show: [a.handover, b.handover, c.handover, d.handover, e.handover, f.handover]',
      'A gate shows at most 5 documents.',
    ],
    [
      'ask: ok\n    show: [checkout.changes]',
      '`checkout.changes` arrives with write steps; it is not supported yet.',
    ],
    ['ask: ok\n    color: red', 'A gate has no `color`: it asks a person and runs nothing.'],
  ])('refuses a gate whose %s', (body, message) => {
    expect(only(steps(`- id: decide\n  gate:\n    ${body}`)).message).toBe(message);
  });

  it.each([
    [
      'ask: ok\n    choices: [Approve, comment]',
      '`choices` lists 2 to 6 words of lowercase letters, digits and dashes, e.g. `[approve, comment]`.',
    ],
    [
      'ask: ok\n    choices: [approve, approve]',
      '`choices` lists 2 to 6 words of lowercase letters, digits and dashes, e.g. `[approve, comment]`.',
    ],
    [
      'ask: ok\n    show: review.handover',
      'Name what to show as `<step>.<artifact>`, e.g. `review.handover`.',
    ],
    [
      'ask: ok\n    show: [previous.review.handover]',
      'Name what to show as `<step>.<artifact>`, e.g. `review.handover`.',
    ],
    [
      'ask: ok\n    show: [review]',
      'Name what to show as `<step>.<artifact>`, e.g. `review.handover`.',
    ],
    ['ask: "Post {{nope"', 'Unclosed `{{` in `{{nope`.'],
  ])('refuses a gate whose %s, too', (body, message) => {
    expect(only(steps(`- id: decide\n  gate:\n    ${body}`)).message).toBe(message);
  });

  it('refuses a document shown twice', () => {
    expect(
      only(
        steps(
          '- id: review\n  prompt: Review it.',
          '- gate: { ask: ok, show: [review.handover, review.handover] }',
        ),
      ).message,
    ).toBe('`review.handover` is listed twice.');
  });

  it('refuses a gate that is not a mapping', () => {
    expect(only(steps('- id: decide\n  gate: Post it?'))).toMatchObject({
      path: 'automations[0].steps[0].gate',
      message:
        'Write a gate as `gate: { ask: "<question>" }`, with `show` and `choices` if it needs them.',
    });
  });

  it('refuses a gate with no question, at its gate', () => {
    expect(only(steps('- id: decide\n  gate: { show: [] }'))).toMatchObject({
      path: 'automations[0].steps[0].gate',
      message: 'A gate asks 1 to 300 characters of text.',
    });
  });

  it('refuses run, prompt, outputs and on_failure beside gate:', () => {
    for (const key of [
      'run: echo',
      'prompt: hi',
      'outputs: { a: string }',
      'on_failure: { retry: 1 }',
    ]) {
      const name = key.split(':')[0];
      expect(only(steps(`- id: decide\n  gate: { ask: ok }\n  ${key}`))).toMatchObject({
        path: `automations[0].steps[0].${name}`,
        message: `A gate has no \`${name}\`: it asks a person and runs nothing.`,
      });
    }
  });

  it("lets if: branch on a gate's decision, typed by its choices", () => {
    expect(
      steps(
        '- id: decide\n  gate: { ask: ok, choices: [approve, comment] }',
        "- if: steps.decide.decision == 'comment'\n  run: echo",
      ).issues,
    ).toEqual([]);
    expect(
      only(
        steps(
          '- id: decide\n  gate: { ask: ok }',
          "- if: steps.decide.decision == 'comment'\n  run: echo",
        ),
      ).message,
    ).toMatch(/comment/); // not among approve
  });

  it('takes trusted paths only in ask', () => {
    expect(steps('- id: decide\n  gate: { ask: "Approve #{{item.number}}?" }').issues).toEqual([]);
    expect(only(steps('- id: decide\n  gate: { ask: "{{item.title}}?" }')).message).toMatch(
      /someone else wrote/,
    );
  });

  it("shows only an earlier step's documents", () => {
    expect(
      only(steps('- id: decide\n  gate: { ask: ok, show: [review.handover] }')).message,
    ).toMatch(/there is no step `review`/);
    const review = '- id: review\n  run: echo\n  outputs: { n: integer }';
    expect(only(steps(review, '- gate: { ask: ok, show: [review.n] }')).message).toMatch(
      /`n` is an output, not a document/,
    );
    expect(only(steps(review, '- gate: { ask: ok, show: [review.notes] }')).message).toMatch(
      /`review` has no artifact `notes`/,
    );
  });
});

describe('then: stop', () => {
  it('parses then: stop to stop: true on any step, and refuses another value', () => {
    expect(firstStep<CommandStep>(command('  then: stop')).stop).toBe(true);
    expect(only(command('  then: go')).message).toBe('`then:` takes `stop`.');
    expect(Object.prototype.hasOwnProperty.call(firstStep<CommandStep>(command()), 'stop')).toBe(
      false,
    );
    expect(firstStep<GateStep>(steps('- gate: { ask: ok }\n  then: stop')).stop).toBe(true);
  });
});
