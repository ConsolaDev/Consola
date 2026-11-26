import { describe, expect, it } from 'vitest';
import { parseEntryCheckout } from './flow';
import { parseFactorySpec } from './parse';
import { isStepsEntry, type StepsAutomation } from './schema';
import {
  flatSteps,
  gateChoices,
  leafSteps,
  stepItemFields,
  type CommandStep,
  type GateStep,
} from './steps';

/*
 * Slice 3's control flow in the format: gates, `then: stop`, and (from the
 * next tasks) loops, retries, budgets and an entry's checkout. The helpers
 * are steps.test.ts' own.
 */

/** One entry, its fields indented under `- name: a`. */
const one = (fields: string) =>
  parseFactorySpec(`version: 1\nautomations:\n  - name: a\n${fields}`);

const REVIEW = '    on: { github: { events: [pull_request.review_requested] } }\n';

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
    // Slice 3-B: a gate may show the run's own checkout's diff, on an entry that has one.
    [
      'ask: ok\n    show: [checkout.changes]',
      "`checkout.changes` is a run's own checkout's diff; it needs `checkout: { repo, branch }`.",
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
      'outputs: { a: { type: string } }',
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
    const review = '- id: review\n  run: echo\n  outputs: { n: { type: integer } }';
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

const LOOP = [
  '- id: polish',
  '  repeat: { max: 3, until: steps.review.findings == 0 }',
  '  steps:',
  '    - id: review\n      prompt: Review it.\n      outputs: { findings: { type: integer } }',
  '    - id: address\n      if: steps.review.findings > 0\n      prompt: Address it.\n      reads: [review.handover]',
].join('\n');

/** The loop with its header line replaced. */
const loopWith = (header: string) =>
  LOOP.replace('  repeat: { max: 3, until: steps.review.findings == 0 }', `  ${header}`);

/** The loop with `extra` lines (2-space indented keys of the block) after its id. */
const loopPlus = (extra: string) => LOOP.replace('- id: polish', `- id: polish\n${extra}`);

describe('repeat:', () => {
  it('parses a loop, its steps in order, and flattens to record order', () => {
    const result = steps(
      '- id: fix\n  prompt: Fix it.',
      LOOP,
      '- id: pr\n  if: steps.review.findings == 0\n  run: echo',
    );
    expect(result.issues).toEqual([]);
    const entries = (result.automations[0] as StepsAutomation).steps;
    expect(flatSteps(entries).map(({ step, block }) => [step.id, block?.id])).toEqual([
      ['fix', undefined],
      ['polish', undefined],
      ['review', 'polish'],
      ['address', 'polish'],
      ['pr', undefined],
    ]);
    expect(flatSteps(entries).map(({ path }) => path)).toEqual([
      [0],
      [1],
      [1, 'steps', 0],
      [1, 'steps', 1],
      [2],
    ]);
    expect(leafSteps(entries).map((step) => step.id)).toEqual(['fix', 'review', 'address', 'pr']);
    expect(entries[1]).toMatchObject({
      kind: 'repeat',
      id: 'polish',
      named: true,
      max: 3,
      until: 'steps.review.findings == 0',
    });
    expect(Object.prototype.hasOwnProperty.call(entries[1], 'onExhausted')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(entries[1], 'if')).toBe(false);
  });

  it.each([
    [
      'repeat: { until: steps.review.findings == 0 }',
      "`repeat` without `max` arrives with waiting runs (slice 4), bounded by a wait's timeout.",
    ],
    [
      'repeat: { max: 11, until: steps.review.findings == 0 }',
      '`max` is a whole number from 1 to 10.',
    ],
    [
      'repeat: { max: 0, until: steps.review.findings == 0 }',
      '`max` is a whole number from 1 to 10.',
    ],
    [
      'repeat: { max: 2.5, until: steps.review.findings == 0 }',
      '`max` is a whole number from 1 to 10.',
    ],
    ['repeat: { max: 3 }', 'Say when the loop is done: `until: steps.review.findings == 0`.'],
    [
      'repeat: { max: 3, until: 3 }',
      'Say when the loop is done: `until: steps.review.findings == 0`.',
    ],
  ])('refuses %s', (header, message) => {
    expect(only(steps(loopWith(header))).message).toBe(message);
  });

  it.each([
    ['repeat: 3', 'Write a loop as `repeat: { max: 3, until: steps.review.findings == 0 }`.'],
    [
      'repeat: { max: 3, until: steps.review.findings == 0, every: 1h }',
      'Unrecognized key in `repeat`: every.',
    ],
    [`repeat: { max: 3, until: "${'x'.repeat(501)}" }`, 'An `until` is at most 500 characters.'],
  ])('refuses the header %s', (header, message) => {
    expect(only(steps(loopWith(header))).message).toBe(message);
  });

  it('refuses a loop in a loop, a loop without an id, then: and on_failure on a loop', () => {
    const inner = [
      '- id: outer',
      '  repeat: { max: 2, until: steps.review.findings == 0 }',
      '  steps:',
      `    ${LOOP.replace(/\n/g, '\n    ')}`,
    ].join('\n');
    expect(only(steps(inner))).toMatchObject({
      path: 'automations[0].steps[0].steps[0]',
      message: 'A loop inside a loop is not supported.',
    });
    expect(only(steps(LOOP.replace('- id: polish\n  repeat', '- repeat')))).toMatchObject({
      path: 'automations[0].steps[0]',
      message: 'A loop needs an `id`, e.g. `id: polish`.',
    });
    expect(only(steps(loopPlus('  then: stop')))).toMatchObject({
      path: 'automations[0].steps[0].then',
      message: '`then:` goes on a step; a loop ends by its `until` or its `on_exhausted`.',
    });
    expect(only(steps(loopPlus('  on_failure: { retry: 1 }')))).toMatchObject({
      path: 'automations[0].steps[0].on_failure',
      message:
        "`on_failure` goes on a step or on the automation; a loop's rounds are bounded by `max`.",
    });
    expect(only(steps(loopPlus('  colour: red'))).message).toBe(
      'Unrecognized key in a loop: colour.',
    );
  });

  it('holds a loop to 1 to 10 steps', () => {
    expect(
      only(steps('- id: polish\n  repeat: { max: 2, until: "true" }\n  steps: []')).message,
    ).toBe('A loop has 1 to 10 steps.');
    const eleven = Array.from({ length: 11 }, (_, i) => `    - id: s${i}\n      run: echo`).join(
      '\n',
    );
    expect(
      only(steps(`- id: polish\n  repeat: { max: 2, until: "true" }\n  steps:\n${eleven}`)).message,
    ).toBe('A loop has 1 to 10 steps.');
  });

  it('counts inner steps toward 20 and keeps ids unique across them', () => {
    const eighteen = Array.from({ length: 18 }, (_, i) => `- id: s${i}\n  run: echo`);
    const three = [
      '- id: polish',
      '  repeat: { max: 2, until: steps.a.n == 0 }',
      '  steps:',
      '    - id: a\n      run: echo\n      outputs: { n: { type: integer } }',
      '    - id: b\n      run: echo',
      '    - id: c\n      run: echo',
    ].join('\n');
    expect(only(steps(...eighteen, three)).message).toBe(
      'An entry with `steps:` has 1 to 20 steps, written as a list.',
    );
    expect(steps(...eighteen.slice(1), three).issues).toEqual([]);
    expect(only(steps('- id: review\n  run: echo', LOOP))).toMatchObject({
      path: 'automations[0].steps[1].steps[0].id',
      message: 'Step ids are unique; `review` is used twice.',
    });
    expect(only(steps('- id: polish\n  run: echo', LOOP))).toMatchObject({
      path: 'automations[0].steps[1].id',
      message: 'Step ids are unique; `polish` is used twice.',
    });
  });

  it('names an unnamed step by its place in the record', () => {
    const result = steps(LOOP, '- run: echo');
    const entries = (result.automations[0] as StepsAutomation).steps;
    expect(flatSteps(entries).map(({ step }) => step.id)).toEqual([
      'polish',
      'review',
      'address',
      'step-4',
    ]);
  });

  it("lets a later step read the loop's latest round, and refuses an inner step reading a later one", () => {
    expect(steps(LOOP, '- id: pr\n  if: steps.review.findings == 0\n  run: echo').issues).toEqual(
      [],
    );
    const reversed = LOOP.replace(
      '      prompt: Review it.\n',
      '      prompt: Review it.\n      reads: [address.handover]\n',
    );
    expect(only(steps(reversed)).message).toBe(
      "`address.handover`: `address` is not before this step: it is a later step, so it has not run when this one's turn comes",
    );
    expect(
      only(steps(LOOP, '- id: pr\n  if: steps.polish.findings == 0\n  run: echo')).message,
    ).toMatch(/`polish` is a loop/);
  });

  it('checks until against every inner step', () => {
    expect(only(steps(loopWith('repeat: { max: 3, until: steps.address.done }'))).message).toBe(
      '`steps.address.done`: `address` has no output `done` (it has none)',
    );
    expect(
      only(steps(loopWith('repeat: { max: 3, until: "steps.review.findings == " }'))).message,
    ).toMatch(/^Cannot read this `until`/);
    expect(
      only(
        steps(
          loopWith('repeat: { max: 3, until: steps.later.n == 0 }'),
          '- id: later\n  run: echo\n  outputs: { n: { type: integer } }',
        ),
      ).message,
    ).toBe(
      "`steps.later.n`: `later` is not before this step: it is a later step, so it has not run when this one's turn comes",
    );
  });

  it.each([
    ['fail', 'fail'],
    ['continue', 'continue'],
    [
      '{ gate: { ask: "Open the pull request anyway?" } }',
      { ask: 'Open the pull request anyway?', show: [] },
    ],
    [
      '{ gate: { ask: "Anyway?", show: [review.handover] } }',
      { ask: 'Anyway?', show: ['review.handover'] },
    ],
  ])('parses on_exhausted: %s', (value, parsed) => {
    const result = steps(loopPlus(`  on_exhausted: ${value}`));
    expect(result.issues).toEqual([]);
    expect((result.automations[0] as StepsAutomation).steps[0]).toMatchObject({
      onExhausted: parsed,
    });
  });

  const SHAPE =
    '`on_exhausted` is `fail`, `continue` or `{ gate: { ask: "<question>", show: [...] } }`, `show` when it needs one.';
  it.each([
    ['stop', '', SHAPE],
    ['{ retry: 1 }', '', SHAPE],
    ['{ gate: ok, then: stop }', '', SHAPE],
    ['{ gate: 3 }', '.gate', SHAPE],
    ['{ gate: { ask: "" } }', '.gate.ask', 'A gate asks 1 to 300 characters of text.'],
    [
      '{ gate: "Open it anyway?" }',
      '.gate',
      'A gate\'s question goes under `ask:`, as a gate step\'s does: write `on_exhausted: { gate: { ask: "Open it anyway?" } }`.',
    ],
    ['{ gate: { ask: ok, choices: [a, b] } }', '.gate.choices', SHAPE],
  ])('refuses on_exhausted: %s', (value, at, message) => {
    expect(only(steps(loopPlus(`  on_exhausted: ${value}`)))).toMatchObject({
      path: `automations[0].steps[0].on_exhausted${at}`,
      message,
    });
  });

  it("checks an exhaustion gate's question and documents against the loop's steps", () => {
    expect(
      only(steps(loopPlus('  on_exhausted: { gate: { ask: ok, show: [nowhere.handover] } }')))
        .message,
    ).toMatch(/there is no step `nowhere`/);
    expect(
      only(steps(loopPlus('  on_exhausted: { gate: { ask: "{{item.title}}?" } }'))).message,
    ).toMatch(/someone else wrote/);
  });

  it('refuses on_exhausted outside a loop', () => {
    expect(only(command('  on_exhausted: fail')).message).toBe(
      '`on_exhausted` goes on a `repeat` block.',
    );
  });

  it("lets a loop's if: read the steps before it", () => {
    expect(
      steps(
        '- id: triage\n  run: echo\n  outputs: { bug: { type: boolean } }',
        loopPlus('  if: steps.triage.bug'),
      ).issues,
    ).toEqual([]);
    expect(only(steps(loopPlus('  if: steps.review.findings > 0'))).message).toMatch(
      /`review` is not before this step/,
    );
  });
});

describe('a loop, read by every other part of the format', () => {
  it('names a loop as no step to read from, in previous too', () => {
    expect(
      only(steps(LOOP, '- id: post\n  run: echo\n  env: { NOTES: "{{previous.polish.handover}}" }'))
        .message,
    ).toBe('`{{previous.polish.handover}}`: `polish` is a loop; name one of its steps');
  });

  it("points at a loop's step that names an agent, read without its folder", () => {
    const issue = only(
      steps(
        '- id: polish\n  repeat: { max: 2, until: steps.look.done }\n  steps:\n    - id: look\n      agent: reviewer\n      outputs: { done: { type: boolean } }',
      ),
    );
    expect(issue).toMatchObject({
      path: 'automations[0].steps[0].steps[0].agent',
      message:
        '`agent: reviewer` names agents/reviewer.md, and this factory.yml is read without its folder.',
    });
  });

  it("lists the item fields a loop's if, until, exhaustion gate and steps use", () => {
    const result = steps(
      [
        '- id: polish',
        '  if: "item.number > 1"',
        '  repeat: { max: 2, until: "item.number > 2" }',
        '  on_exhausted: { gate: { ask: "Approve #{{item.number}} anyway?" } }',
        '  steps:',
        '    - id: look\n      prompt: "Look at {{item.url}}."',
      ].join('\n'),
    );
    const entries = (result.automations[0] as StepsAutomation).steps;
    expect(stepItemFields(entries)).toEqual([
      { step: 'polish', field: 'number', where: 'if' },
      { step: 'polish', field: 'number', where: 'if' },
      { step: 'polish', field: 'number', where: 'prompt' },
      { step: 'look', field: 'url', where: 'prompt' },
    ]);
  });
});

const DAILY = '    on: { cron: "0 9 * * 1-5" }\n';

/** Every issue's message. */
const issueMessages = (result: ReturnType<typeof one>) =>
  result.issues.map((issue) => issue.message);

describe('on_failure, budget and checkout', () => {
  it('parses on_failure on a step and on the entry, and budget and checkout on the entry', () => {
    const result = one(
      `${REVIEW}    checkout: { pr: item }\n    budget: { usd: 5 }\n    on_failure: { retry: 1 }\n    steps:\n      - id: fresh\n        run: echo\n        dry_run: run\n        on_failure: { retry: 2 }\n`,
    );
    expect(result.issues).toEqual([]);
    expect(result.automations[0]).toMatchObject({
      checkout: { pr: 'item' },
      budget: { usd: 5 },
      onFailure: { retry: 1 },
      steps: [{ id: 'fresh', onFailure: { retry: 2 } }],
    });
  });

  it('leaves every new key out of an entry and a step that do not write it', () => {
    const result = steps('- id: look\n  prompt: Look.', '- id: fresh\n  run: echo');
    const automation = result.automations[0] as StepsAutomation;
    for (const key of ['checkout', 'budget', 'onFailure'])
      expect(Object.prototype.hasOwnProperty.call(automation, key)).toBe(false);
    for (const step of automation.steps)
      expect(Object.prototype.hasOwnProperty.call(step, 'onFailure')).toBe(false);
  });

  it('takes a retry of 0 to 3 on an agent step, and a budget of cents', () => {
    const result = one(
      `${REVIEW}    budget: { usd: 0.01 }\n    on_failure: { retry: 0 }\n    steps:\n      - id: look\n        prompt: Look.\n        on_failure: { retry: 3 }\n`,
    );
    expect(result.issues).toEqual([]);
    expect(result.automations[0]).toMatchObject({
      budget: { usd: 0.01 },
      onFailure: { retry: 0 },
      steps: [{ id: 'look', onFailure: { retry: 3 } }],
    });
    expect(
      issueMessages(one(`${REVIEW}    budget: { usd: 1000 }\n    steps:\n      - prompt: hi\n`)),
    ).toEqual([]);
  });

  it.each([
    ['    budget: { usd: 0 }\n', '`budget:` is `{ usd: <n> }`, with n from 0.01 to 1000.'],
    ['    budget: { usd: 1001 }\n', '`budget:` is `{ usd: <n> }`, with n from 0.01 to 1000.'],
    ['    on_failure: { retry: 4 }\n', '`on_failure:` is `{ retry: <n> }`, with n from 0 to 3.'],
    ['    checkout: { pr: head }\n', '`pr:` takes `item`.'],
    [
      '    checkout: { pr: item }\n    scope: catalog-portal\n',
      'The checkout says where this runs; remove `scope:`.',
    ],
    ['    gate: { ask: ok }\n', 'A gate is a step; put it in `steps:`.'],
    ['    repeat: { max: 2, until: x }\n', 'A loop is a step; put it in `steps:`.'],
    ['    then: stop\n', '`then:` goes on a step.'],
  ])('refuses on an entry: %s', (lines, message) => {
    expect(issueMessages(one(`${REVIEW}${lines}    steps:\n      - prompt: hi\n`))).toContain(
      message,
    );
  });

  it.each([
    ['    budget: 5\n', 'budget', '`budget:` is `{ usd: <n> }`, with n from 0.01 to 1000.'],
    [
      '    budget: { usd: "5" }\n',
      'budget',
      '`budget:` is `{ usd: <n> }`, with n from 0.01 to 1000.',
    ],
    [
      '    budget: { usd: 5, eur: 4 }\n',
      'budget',
      '`budget:` is `{ usd: <n> }`, with n from 0.01 to 1000.',
    ],
    [
      '    on_failure: retry\n',
      'on_failure',
      '`on_failure:` is `{ retry: <n> }`, with n from 0 to 3.',
    ],
    [
      '    on_failure: { retry: 1.5 }\n',
      'on_failure',
      '`on_failure:` is `{ retry: <n> }`, with n from 0 to 3.',
    ],
    [
      '    on_failure: { retry: -1 }\n',
      'on_failure',
      '`on_failure:` is `{ retry: <n> }`, with n from 0 to 3.',
    ],
    [
      '    on_failure: { retry: 1, wait: 5m }\n',
      'on_failure',
      '`on_failure:` is `{ retry: <n> }`, with n from 0 to 3.',
    ],
    [
      '    checkout: item\n',
      'checkout',
      'Write the checkout as `checkout: { pr: item }` or `checkout: { repo: …, branch: … }`.',
    ],
    [
      '    checkout: {}\n',
      'checkout',
      'Write the checkout as `checkout: { pr: item }` or `checkout: { repo: …, branch: … }`.',
    ],
    [
      '    checkout: { pr: item, depth: 1 }\n',
      'checkout.depth',
      'Unrecognized key in `checkout`: depth.',
    ],
    [
      '    checkout: { pr: item, branch: x }\n',
      'checkout',
      'A checkout is `{ pr: item }` or `{ repo, branch }`, not both.',
    ],
  ])('refuses the shape %s, at its key', (lines, at, message) => {
    const issue = only(one(`${REVIEW}${lines}    steps:\n      - prompt: hi\n`));
    expect(issue).toMatchObject({ path: `automations[0].${at}`, message });
  });

  it('refuses pr: item where items are never pull requests', () => {
    expect(
      issueMessages(
        one(
          `${DAILY}    scope: catalog-portal\n    checkout: { pr: item }\n    steps:\n      - prompt: hi\n`,
        ),
      ),
    ).toContain('`pr: item` needs items that are pull requests.');
  });

  it.each([
    ['a schedule', `${DAILY}    scope: api\n`],
    ['a run on demand with no item', '    on: manual\n    scope: api\n'],
    ['a run on demand on issues', '    on: manual\n    applies_to: [issue]\n'],
    [
      'a poll with key:',
      '    on: { poll: { every: 5m, run: "echo []", key: .id } }\n    scope: api\n',
    ],
  ])('refuses pr: item on %s, and only that', (_, head) => {
    const issue = only(one(`${head}    checkout: { pr: item }\n    steps:\n      - prompt: hi\n`));
    expect(issue).toMatchObject({
      path: 'automations[0].checkout',
      message: '`pr: item` needs items that are pull requests.',
    });
  });

  it('says only what to fix first on a schedule with pr: item and no scope', () => {
    expect(
      issueMessages(one(`${DAILY}    checkout: { pr: item }\n    steps:\n      - prompt: hi\n`)),
    ).toEqual(['`pr: item` needs items that are pull requests.']);
  });

  it.each([
    ['an event', REVIEW],
    ['a run on demand on pull requests', '    on: manual\n    applies_to: [pr]\n'],
    ['a run on demand on either', '    on: manual\n    applies_to: [pr, issue]\n'],
    [
      'a poll with item:',
      '    on: { poll: { every: 5m, run: "echo []", item: { github: .url } } }\n',
    ],
  ])('takes pr: item on %s', (_, head) => {
    const result = one(`${head}    checkout: { pr: item }\n    steps:\n      - prompt: hi\n`);
    expect(result.issues).toEqual([]);
    expect(result.automations[0]).toMatchObject({ checkout: { pr: 'item' } });
  });

  it('refuses checkout, budget and on_failure on a step, and on a run: entry', () => {
    expect(only(command('  budget: { usd: 1 }')).message).toBe(
      '`budget:` belongs to the automation: one budget per run.',
    );
    expect(only(command('  checkout: { pr: item }')).message).toBe(
      '`checkout:` belongs to the automation: one checkout per run.',
    );
    expect(
      issueMessages(one(`${REVIEW}    run: { action: Review }\n    budget: { usd: 1 }\n`)),
    ).toContain('`budget` goes with `steps:`.');
    for (const [key, value] of [
      ['checkout', '{ pr: item }'],
      ['on_failure', '{ retry: 1 }'],
    ]) {
      expect(
        only(one(`${REVIEW}    run: { action: Review }\n    ${key}: ${value}\n`)),
      ).toMatchObject({
        path: `automations[0].${key}`,
        message: `\`${key}\` goes with \`steps:\`.`,
      });
    }
  });

  it("refuses checkout and budget on a loop, in a step's words", () => {
    expect(only(steps(loopPlus('  budget: { usd: 1 }')))).toMatchObject({
      path: 'automations[0].steps[0].budget',
      message: '`budget:` belongs to the automation: one budget per run.',
    });
    expect(only(steps(loopPlus('  checkout: { pr: item }')))).toMatchObject({
      path: 'automations[0].steps[0].checkout',
      message: '`checkout:` belongs to the automation: one checkout per run.',
    });
  });

  it("refuses a step's on_failure that is not a retry of 0 to 3, at its key", () => {
    expect(only(command('  on_failure: { retry: 4 }'))).toMatchObject({
      path: 'automations[0].steps[0].on_failure',
      message: '`on_failure:` is `{ retry: <n> }`, with n from 0 to 3.',
    });
  });

  it('refuses a declared retry on a command that may have acted', () => {
    expect(only(steps('- id: pr\n  run: git push\n  on_failure: { retry: 1 }'))).toMatchObject({
      path: 'automations[0].steps[0].on_failure',
      message:
        '`pr` runs a command that may push or post, so it never retries by itself; a person retries it from the run page.',
    });
    expect(steps('- id: pr\n  run: git push\n  on_failure: { retry: 0 }').issues).toEqual([]);
    expect(
      steps('- id: pr\n  run: git push\n  dry_run: run\n  on_failure: { retry: 1 }').issues,
    ).toEqual([]);
  });

  it("refuses a declared retry on a loop's command that may have acted, at its own line", () => {
    expect(
      only(
        steps(
          '- id: polish\n  repeat: { max: 2, until: steps.look.done }\n  steps:\n    - id: look\n      prompt: Look.\n      outputs: { done: { type: boolean } }\n    - id: post\n      run: gh pr comment\n      on_failure: { retry: 2 }',
        ),
      ),
    ).toMatchObject({
      path: 'automations[0].steps[0].steps[1].on_failure',
      message:
        '`post` runs a command that may push or post, so it never retries by itself; a person retries it from the run page.',
    });
  });
});

describe('parseEntryCheckout: a checkout the run owns (slice 3-B)', () => {
  const parse = (value: unknown) => parseEntryCheckout(value, () => {});
  const failures = (value: unknown) => {
    const messages: string[] = [];
    parseEntryCheckout(value, (message) => messages.push(message));
    return messages;
  };
  const at = (value: unknown) => {
    const paths: Array<Array<string | number>> = [];
    parseEntryCheckout(value, (_message, path = []) => paths.push(path));
    return paths;
  };

  it('takes a run-owned checkout', () =>
    expect(
      parse({ repo: 'sprocket/catalog-portal', branch: 'fix/{{item.key}}', from: 'release' }),
    ).toEqual({ repo: 'sprocket/catalog-portal', branch: 'fix/{{item.key}}', from: 'release' }));

  it('leaves from out when it is not written', () => {
    const checkout = parse({ repo: 'sprocket/catalog-portal', branch: 'consola/run-{{run.id}}' });
    expect(checkout).toEqual({ repo: 'sprocket/catalog-portal', branch: 'consola/run-{{run.id}}' });
    expect(Object.prototype.hasOwnProperty.call(checkout, 'from')).toBe(false);
  });

  it("keeps 3-A's { pr: item }", () => expect(parse({ pr: 'item' })).toEqual({ pr: 'item' }));

  it.each([
    [{ repo: 'sprocket/catalog-portal' }, 'Name the branch the run cuts'],
    [{ branch: 'fix/x' }, 'Each entry of `repos:`'],
    [
      { repo: 'x/y', branch: 'fix/{{item.key}}', from: 'item' },
      "Writing on a pull request's own head is not supported",
    ],
    [{ repo: 'x/y', branch: 'fix/{{item.key}}', from: 'a..b' }, '`from:` names a branch'],
    [{ repo: 'x/y', branch: '{{item.key}}' }, 'A branch starts with a literal folder'],
    [{ pr: 'item', repo: 'x/y', branch: 'fix/a' }, 'not both'],
    // Beyond the plan's rows.
    [{ repo: 'catalog-portal', branch: 'fix/a' }, 'Each entry of `repos:`'],
    [{ repo: 'x/y', branch: 7 }, 'Name the branch the run cuts'],
    [{ repo: 'x/y', branch: 'fix/{{item.title}}' }, 'A branch takes only'],
    [{ repo: 'x/y', branch: 'fix/a', from: '{{item.key}}' }, '`from:` names a branch'],
    [{ repo: 'x/y', branch: 'fix/a', from: 3 }, '`from:` names a branch'],
    [{ repo: 'x/y', branch: 'fix/a', depth: 1 }, 'Unrecognized key in `checkout`: depth.'],
  ])('refuses %j', (value, words) =>
    expect(failures(value)).toContainEqual(expect.stringContaining(words)),
  );

  it('says the fixed words, each at its key', () => {
    expect(failures({ repo: 'x/y' })).toEqual([
      'Name the branch the run cuts: `branch: "fix/{{item.key}}"`.',
    ]);
    expect(at({ repo: 'x/y' })).toEqual([['checkout', 'branch']]);
    expect(failures({ repo: 'x/y', branch: 'fix/a', from: 'item' })).toEqual([
      "Writing on a pull request's own head is not supported: a write step cuts its branch from one of `repos:` (invariant 9).",
    ]);
    expect(at({ repo: 'x/y', branch: 'fix/a', from: 'item' })).toEqual([['checkout', 'from']]);
    expect(failures({ repo: 'x/y', branch: 'fix/a', from: 'a..b' })).toEqual([
      '`from:` names a branch of the repository, e.g. `from: main`.',
    ]);
    expect(failures({ pr: 'item', repo: 'x/y', branch: 'fix/a' })).toEqual([
      'A checkout is `{ pr: item }` or `{ repo, branch }`, not both.',
    ]);
    expect(at({ repo: 'nope', branch: 'fix/a' })).toEqual([['checkout', 'repo']]);
    expect(at({ repo: 'x/y', branch: '{{item.key}}' })).toEqual([['checkout', 'branch']]);
  });

  it('says every key a run-owned checkout lacks, each at its key', () => {
    const result = one(`${REVIEW}    checkout: { from: main }\n    steps:\n      - prompt: hi\n`);
    expect(result.automations).toEqual([]);
    expect(result.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      {
        path: 'automations[0].checkout.repo',
        message:
          'Each entry of `repos:` is a repository as `owner/name`, e.g. `sprocket/catalog-portal`.',
      },
      {
        path: 'automations[0].checkout.branch',
        message: 'Name the branch the run cuts: `branch: "fix/{{item.key}}"`.',
      },
    ]);
  });

  it('takes a run-owned checkout on a steps entry, with no scope', () => {
    const result = one(
      `${REVIEW}    checkout: { repo: sprocket/catalog-portal, branch: "fix/{{item.key}}" }\n    steps:\n      - prompt: hi\n`,
    );
    expect(result.issues).toEqual([]);
    expect(result.automations[0]).toMatchObject({
      checkout: { repo: 'sprocket/catalog-portal', branch: 'fix/{{item.key}}' },
    });
  });
});
