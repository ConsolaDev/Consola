import { describe, expect, it } from 'vitest';
import type { GateView } from '../../../shared/automations';
import { answeredWords, gateChoiceLabel, gateHeading, newerRevisionLine } from './gateCardWords';

const NOW = new Date('2026-11-12T12:00:00.000Z');

const VIEW: GateView = {
  runId: 'r1',
  stepId: 'decide',
  ask: 'Post the review on #51 as an approval?',
  material: [],
  choices: ['approve', 'comment'],
};

describe("a gate's card", () => {
  it.each([
    ['approve', 'Approve'],
    ['comment', 'Comment'],
    ['request-changes', 'Request changes'],
  ])('labels %s', (choice, label) => {
    expect(gateChoiceLabel(choice)).toBe(label);
  });

  it('says when a newer revision is held', () => {
    expect(newerRevisionLine({ ...VIEW, newerRevision: 'pull-request' })).toBe(
      'This pull request has new commits since the review (held until this run ends)',
    );
    expect(newerRevisionLine({ ...VIEW, newerRevision: 'item' })).toBe(
      'This item has changed since this run read it',
    );
    expect(newerRevisionLine(VIEW)).toBeNull();
  });

  it('heads an exhaustion gate with its rounds', () => {
    expect(
      gateHeading({ ...VIEW, ask: 'Open it anyway?', loop: { id: 'polish', rounds: 3 } }),
    ).toBe('Open it anyway? (after 3 rounds)');
    expect(gateHeading(VIEW)).toBe('Post the review on #51 as an approval?');
  });

  it('says how it was answered, once it was', () => {
    expect(
      answeredWords(
        {
          ...VIEW,
          answered: { decision: 'comment', by: 'person', at: '2026-11-12T11:55:00.000Z' },
        },
        NOW,
      ),
    ).toBe('answered comment by you 5m ago');
    expect(answeredWords(VIEW, NOW)).toBeNull();
  });
});
