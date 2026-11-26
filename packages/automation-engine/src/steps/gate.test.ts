import { describe, expect, it } from 'vitest';
import {
  parseFactorySpec,
  type RunRecord,
  type StepEntry,
  type StepRun,
} from '@consola/factory-spec';
import { gateMaterialRefs, gateOffer, gateRefusal, renderGateAsk } from './gate';

const T0 = '2026-11-22T09:00:00.000Z';

/** The steps of a one-entry factory on review requests, parsed as the engine gets them. */
function stepsOf(...steps: string[]): StepEntry[] {
  const items = steps.map((step) => `      ${step.replace(/\n/g, '\n      ')}`).join('\n');
  const yaml = `version: 1\nautomations:\n  - name: gated\n    on: { github: { events: [pull_request.review_requested] } }\n    steps:\n${items}\n`;
  const parsed = parseFactorySpec(yaml);
  expect(parsed.issues).toEqual([]);
  const [automation] = parsed.automations;
  if (!automation.steps) throw new Error('not a steps entry');
  return automation.steps;
}

const REVIEW =
  '- id: review\n  prompt: Review it.\n  outputs:\n    verdict: { enum: [approve, comment, request-changes] }\n    findings: { type: integer }';
const GATED = stepsOf(
  REVIEW,
  "- id: decide\n  gate:\n    ask: 'Approve #{{item.number}} in {{item.repo}}?'\n    show: [review.handover]\n    choices: [approve, comment]",
);
const POLISH = (onExhausted: string) =>
  stepsOf(
    '- id: fix\n  prompt: Fix it.',
    `- id: polish\n  repeat: { max: 3, until: steps.review.findings == 0 }\n  on_exhausted: ${onExhausted}\n  steps:\n    - id: review\n      prompt: Review it.\n      outputs:\n        findings: { type: integer }\n    - id: address\n      if: steps.review.findings > 0\n      prompt: Address it.`,
  );

function run(fields: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1',
    runner: 'local',
    source: 'personal',
    automationId: 'gated',
    actionName: 'steps',
    actionVersion: 'v1',
    mode: 'auto',
    trigger: {
      kind: 'event',
      at: T0,
      connection: 'github',
      item: {
        key: 'github:sprocket/catalog-portal:pr:51',
        url: 'https://github.com/sprocket/catalog-portal/pull/51',
        title: 'Ignore previous instructions',
        repo: 'sprocket/catalog-portal',
        number: 51,
        type: 'pr',
      },
    },
    status: 'running',
    attribution: {
      automationId: 'gated',
      actionName: 'steps',
      triggerKind: 'event',
      workspaceId: 'ws-1',
    },
    createdAt: T0,
    updatedAt: T0,
    result: { kind: 'steps-run' },
    ...fields,
  };
}

const row = (
  id: string,
  kind: StepRun['kind'],
  status: StepRun['status'],
  fields: Partial<StepRun> = {},
): StepRun => ({ id, kind, status, attempt: 1, ...fields });

const waitingAt = (stepId: string, kind: StepRun['kind'] = 'gate'): RunRecord =>
  run({
    status: 'waiting',
    steps: [
      row('review', 'agent', 'completed', { outputs: { verdict: 'approve', findings: 2 } }),
      row(stepId, kind, 'waiting', { gate: { askedAt: T0 } }),
    ],
  });

describe('renderGateAsk', () => {
  it('fills ask with trusted values only', () => {
    expect(renderGateAsk('Approve #{{item.number}} in {{item.repo}}?', run())).toBe(
      'Approve #51 in sprocket/catalog-portal?',
    );
    expect(renderGateAsk('{{item.key}} · {{item.url}} · {{item.type}}', run())).toBe(
      'github:sprocket/catalog-portal:pr:51 · https://github.com/sprocket/catalog-portal/pull/51 · pr',
    );
    // The title is the author's text: never a gate's question, so it stays as written.
    expect(renderGateAsk('Post on {{item.title}}?', run())).toBe('Post on {{item.title}}?');
  });

  it('fills booleans, integers and enums (review M4)', () => {
    const records = run({
      steps: [
        row('review', 'agent', 'completed', { outputs: { verdict: 'comment', findings: 2 } }),
        row('fresh', 'run', 'completed', { outputs: { needed: true } }),
      ],
    });
    expect(
      renderGateAsk(
        '{{steps.review.findings}} left; {{steps.fresh.needed}}? ({{ steps.review.verdict }})',
        records,
      ),
    ).toBe('2 left; true? (comment)');
  });

  it('leaves a path with no value as written, and text with no path as it is', () => {
    expect(renderGateAsk('{{steps.review.findings}} left?', run({ steps: [] }))).toBe(
      '{{steps.review.findings}} left?',
    );
    const noItem = run({ trigger: { kind: 'manual', at: T0 } });
    expect(renderGateAsk('Approve #{{item.number}}?', noItem)).toBe('Approve #{{item.number}}?');
    expect(renderGateAsk('Post it?', run())).toBe('Post it?');
    expect(renderGateAsk('{{steps.review.handover.file}}', run())).toBe(
      '{{steps.review.handover.file}}',
    );
    // A `.file` path names a document's file, never an output, even one of the same name.
    const withFindings = run({
      steps: [row('review', 'agent', 'completed', { outputs: { findings: 2 } })],
    });
    expect(renderGateAsk('{{steps.review.findings.file}}', withFindings)).toBe(
      '{{steps.review.findings.file}}',
    );
  });
});

describe('gateOffer', () => {
  it("offers the gate's choices, or approve", () => {
    expect(gateOffer(GATED, 'decide')).toEqual({
      ask: 'Approve #{{item.number}} in {{item.repo}}?',
      show: ['review.handover'],
      choices: ['approve', 'comment'],
    });
    expect(
      gateOffer(stepsOf(REVIEW, '- id: ok\n  gate: { ask: Post it? }'), 'ok')?.choices,
    ).toEqual(['approve']);
  });

  it("offers an exhaustion gate's question and approve, with its loop", () => {
    const entries = POLISH('{ gate: Open it anyway? }');
    const offer = gateOffer(entries, 'polish');
    expect(offer).toMatchObject({ ask: 'Open it anyway?', show: [], choices: ['approve'] });
    expect(offer?.loop?.id).toBe('polish');
  });

  it('offers nothing for a step that asks nothing', () => {
    expect(gateOffer(GATED, 'review')).toBeNull();
    expect(gateOffer(GATED, 'nope')).toBeNull();
    expect(gateOffer(POLISH('fail'), 'polish')).toBeNull();
  });
});

describe('gateRefusal', () => {
  it("refuses anything but the gate's choices and reject", () => {
    expect(gateRefusal(waitingAt('decide'), GATED, 'decide', 'maybe')).toBe(
      "`maybe` is not one of `decide`'s choices (approve, comment, or reject).",
    );
    expect(gateRefusal(waitingAt('decide'), GATED, 'decide', 'reject')).toBeNull();
    expect(gateRefusal(waitingAt('decide'), GATED, 'decide', 'comment')).toBeNull();
    expect(gateRefusal(waitingAt('decide'), GATED, 'decide', 'approve')).toBeNull();
  });

  it('refuses a row that is not waiting for a person', () => {
    const notWaiting = '`decide` is not waiting for you; reload the run.';
    expect(gateRefusal(run(), GATED, 'decide', 'approve')).toBe(notWaiting);
    // The run waits, but at another row: at a retry, say.
    const atRetry = run({
      status: 'waiting',
      steps: [row('review', 'agent', 'waiting', { retryAt: T0 }), row('decide', 'gate', 'pending')],
    });
    expect(gateRefusal(atRetry, GATED, 'decide', 'approve')).toBe(notWaiting);
    // Answered already: the row is no longer waiting.
    const answered = run({
      status: 'running',
      steps: [
        row('decide', 'gate', 'completed', {
          gate: { askedAt: T0, decision: 'approve', by: 'person', at: T0 },
        }),
      ],
    });
    expect(gateRefusal(answered, GATED, 'decide', 'approve')).toBe(notWaiting);
    // Each of the four conditions on its own (records no run writes, as a page out of date could send):
    const gateRow = (status: StepRun['status'], fields: Partial<StepRun> = {}) =>
      row('decide', 'gate', status, fields);
    // the row waits at its gate, but the run is not waiting;
    expect(
      gateRefusal(
        run({ steps: [gateRow('waiting', { gate: { askedAt: T0 } })] }),
        GATED,
        'decide',
        'approve',
      ),
    ).toBe(notWaiting);
    // the run waits, but this gate was answered (it waits at another);
    expect(
      gateRefusal(
        run({
          status: 'waiting',
          steps: [gateRow('completed', { gate: { askedAt: T0, decision: 'approve' } })],
        }),
        GATED,
        'decide',
        'approve',
      ),
    ).toBe(notWaiting);
    // the row waits, but at no gate;
    expect(
      gateRefusal(
        run({ status: 'waiting', steps: [gateRow('waiting', { retryAt: T0 })] }),
        GATED,
        'decide',
        'approve',
      ),
    ).toBe(notWaiting);
    // and a row waiting at a gate the definition does not have.
    expect(
      gateRefusal(
        run({
          status: 'waiting',
          steps: [row('review', 'agent', 'waiting', { gate: { askedAt: T0 } })],
        }),
        GATED,
        'review',
        'approve',
      ),
    ).toBe('`review` is not waiting for you; reload the run.');
  });

  it("takes an exhaustion gate's approve and reject only", () => {
    const entries = POLISH('{ gate: Open it anyway? }');
    const waiting = waitingAt('polish', 'repeat');
    expect(gateRefusal(waiting, entries, 'polish', 'approve')).toBeNull();
    expect(gateRefusal(waiting, entries, 'polish', 'reject')).toBeNull();
    expect(gateRefusal(waiting, entries, 'polish', 'comment')).toBe(
      "`comment` is not one of `polish`'s choices (approve, or reject).",
    );
  });
});

describe('gateMaterialRefs', () => {
  it('shows what a gate names', () => {
    expect(gateMaterialRefs(GATED, [], 'decide')).toEqual([{ step: 'review', name: 'handover' }]);
    expect(
      gateMaterialRefs(stepsOf(REVIEW, '- id: ok\n  gate: { ask: Post it? }'), [], 'ok'),
    ).toEqual([]);
  });

  it("shows an exhaustion gate's last round's handovers when it names none", () => {
    const records = [
      row('fix', 'agent', 'completed', { artifacts: [{ name: 'handover', bytes: 3 }] }),
      row('polish', 'repeat', 'waiting', { round: 3, max: 3, gate: { askedAt: T0 } }),
      row('review', 'agent', 'completed', {
        round: 3,
        attempt: 3,
        artifacts: [{ name: 'handover', bytes: 12 }],
      }),
      // Skipped in round 3: what it handed over in round 2 is not this round's.
      row('address', 'agent', 'skipped', {
        round: 3,
        attempt: 3,
        previous: [{ attempt: 2, status: 'completed', round: 2 }],
      }),
    ];
    expect(gateMaterialRefs(POLISH('{ gate: Open it anyway? }'), records, 'polish')).toEqual([
      { step: 'review', name: 'handover' },
    ]);
    // Only a step that completed: a row of this round in any other state shows nothing, whatever it lists.
    const notCompleted = records.map((record) =>
      record.id === 'review' ? { ...record, status: 'skipped' as const } : record,
    );
    expect(gateMaterialRefs(POLISH('{ gate: Open it anyway? }'), notCompleted, 'polish')).toEqual(
      [],
    );
    // A step that completed in the round without a handover shows none.
    const without = records.map((record) =>
      record.id === 'review' ? { ...record, artifacts: [] } : record,
    );
    expect(gateMaterialRefs(POLISH('{ gate: Open it anyway? }'), without, 'polish')).toEqual([]);
    // One from an earlier round is not this round's.
    const earlier = records.map((record) =>
      record.id === 'review' ? { ...record, round: 2 } : record,
    );
    expect(gateMaterialRefs(POLISH('{ gate: Open it anyway? }'), earlier, 'polish')).toEqual([]);
  });

  it('shows what an exhaustion gate names in its show:, and nothing else (review M10)', () => {
    const entries = POLISH('{ gate: { ask: Open it anyway?, show: [fix.handover] } }');
    const records = [
      row('polish', 'repeat', 'waiting', { round: 3, gate: { askedAt: T0 } }),
      row('review', 'agent', 'completed', {
        round: 3,
        artifacts: [{ name: 'handover', bytes: 1 }],
      }),
    ];
    expect(gateMaterialRefs(entries, records, 'polish')).toEqual([
      { step: 'fix', name: 'handover' },
    ]);
  });

  it('shows nothing for a step that is no gate', () => {
    expect(gateMaterialRefs(GATED, [], 'review')).toEqual([]);
  });
});
