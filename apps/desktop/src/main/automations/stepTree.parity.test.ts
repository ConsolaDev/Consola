import { describe, expect, it } from 'vitest';
import { flatSteps, isStepsEntry, leafSteps, parseFactorySpec } from '@consola/factory-spec';
import {
  definitionEntries,
  definitionLeaves,
} from '../../renderer/components/Automations/approvalCard';

/**
 * The renderer may load no runtime from factory-spec (its `run.ts` imports
 * Node's crypto), so it walks a definition's step tree with a copy of its
 * own (`approvalCard.ts`). This keeps the copy and factory-spec's
 * `flatSteps`/`leafSteps` one rule, as `runFilter.parity.test.ts` does for
 * the run filter.
 */

const LOOP = [
  '- id: polish',
  '  repeat: { max: 3, until: steps.review.findings == 0 }',
  '  steps:',
  '    - id: review\n      prompt: Review it.\n      outputs: { findings: integer }',
  '    - id: address\n      if: steps.review.findings > 0\n      prompt: Address it.',
].join('\n');

function stepsOf(...lines: string[]) {
  const result = parseFactorySpec(
    `version: 1\nautomations:\n  - name: a\n    on: { github: { events: [pull_request.review_requested] } }\n    steps:\n${lines
      .map((line) => `      ${line.replace(/\n/g, '\n      ')}`)
      .join('\n')}\n`,
  );
  const automation = result.automations[0];
  if (!automation || !isStepsEntry(automation)) throw new Error(JSON.stringify(result.issues));
  return automation.steps;
}

const ENTRIES = {
  'no loop': stepsOf('- id: fix\n  prompt: Fix it.', '- id: pr\n  run: echo'),
  'a loop in the middle': stepsOf(
    '- id: fix\n  prompt: Fix it.',
    LOOP,
    '- id: pr\n  if: steps.review.findings == 0\n  run: echo',
  ),
  'a loop first and one last': stepsOf(
    LOOP,
    '- id: pr\n  run: echo',
    LOOP.replace('polish', 'again')
      .replace('id: review', 'id: second')
      .replace('steps.review.findings == 0', 'steps.second.findings == 0')
      .replace('steps.review.findings > 0', 'steps.second.findings > 0')
      .replace('id: address', 'id: answer'),
  ),
};

describe("the renderer's step tree and factory-spec's agree", () => {
  for (const [name, entries] of Object.entries(ENTRIES)) {
    it(`walks ${name} in the same record order, with the same loops`, () => {
      const spec = flatSteps(entries).map(({ step, block }) => [step.id, step.kind, block?.id]);
      const renderer = definitionEntries(entries).map(({ step, loop }) => [
        step.id,
        step.kind,
        loop,
      ]);
      expect(renderer).toEqual(spec);
    });

    it(`gives ${name} the same leaves in the same order`, () => {
      expect(definitionLeaves(entries).map((step) => step.id)).toEqual(
        leafSteps(entries).map((step) => step.id),
      );
    });
  }

  it('reads a loop at all', () => {
    expect(definitionEntries(ENTRIES['a loop in the middle'])).toHaveLength(5);
  });
});
