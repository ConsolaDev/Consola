import { describe, expect, it } from 'vitest';
import type { WorkItemDetails } from '../../shared/workItemDetails';
import type { InboxItem } from '../../shared/workItems';
import { alertPanelWords, alertWords, pullRequestAlert } from './pullRequestAlert';

type Details = Pick<WorkItemDetails, 'state' | 'checks' | 'reviewDecision'>;
type Item = Pick<InboxItem, 'state' | 'ciStatus' | 'reviewDecision'>;

const checks = (...states: string[]): WorkItemDetails['checks'] =>
  states.map((state, index) => ({ name: `check-${index}`, state, url: '' }));

/** The stub's #51: open, one failing and one passing check, changes requested. */
const details51: Details = {
  state: 'open',
  checks: checks('FAILURE', 'SUCCESS'),
  reviewDecision: 'CHANGES_REQUESTED',
};
const green: Details = { state: 'open', checks: checks('SUCCESS'), reviewDecision: 'APPROVED' };
const listed = (more: Partial<Item>): Item => ({ state: 'open', reviewDecision: 'none', ...more });

describe('pullRequestAlert', () => {
  it('a failing check or a request for changes alerts', () => {
    const both = pullRequestAlert({ details: details51, detailsAt: 10, itemAt: 0 });
    expect(both).toEqual({ failingChecks: true, changesRequested: true });
    expect(alertWords(both!)).toBe('a check is failing and changes are requested');

    const failing = pullRequestAlert({
      details: { ...details51, reviewDecision: 'REVIEW_REQUIRED' },
      detailsAt: 10,
      itemAt: 0,
    });
    expect(failing).toEqual({ failingChecks: true, changesRequested: false });
    expect(alertWords(failing!)).toBe('a check is failing');

    const changes = pullRequestAlert({
      details: { ...details51, checks: checks('SUCCESS', 'IN_PROGRESS') },
      detailsAt: 10,
      itemAt: 0,
    });
    expect(changes).toEqual({ failingChecks: false, changesRequested: true });
    expect(alertWords(changes!)).toBe('changes are requested');

    // The Inbox's item, in its own words, says the same.
    expect(
      pullRequestAlert({
        item: listed({ ciStatus: 'failing', reviewDecision: 'changes-requested' }),
        itemAt: 10,
        detailsAt: 0,
      }),
    ).toEqual({ failingChecks: true, changesRequested: true });
  });

  it('the newer source decides', () => {
    const failingInInbox = listed({ ciStatus: 'failing', reviewDecision: 'review-required' });
    expect(
      pullRequestAlert({ details: green, detailsAt: 10, item: failingInInbox, itemAt: 20 }),
    ).toEqual({ failingChecks: true, changesRequested: false });
    expect(
      pullRequestAlert({ details: green, detailsAt: 20, item: failingInInbox, itemAt: 10 }),
    ).toBeNull();
  });

  it('read at the same moment, the cached details decide', () => {
    const failingInInbox = listed({ ciStatus: 'failing', reviewDecision: 'changes-requested' });
    expect(
      pullRequestAlert({ details: green, detailsAt: 10, item: failingInInbox, itemAt: 10 }),
    ).toBeNull();
    expect(
      pullRequestAlert({ details: details51, detailsAt: 10, item: listed({}), itemAt: 10 }),
    ).toEqual({ failingChecks: true, changesRequested: true });
  });

  it('only an open pull request alerts', () => {
    expect(
      pullRequestAlert({ details: { ...details51, state: 'merged' }, detailsAt: 10, itemAt: 0 }),
    ).toBeNull();
    expect(
      pullRequestAlert({
        item: listed({ state: 'closed', ciStatus: 'failing', reviewDecision: 'changes-requested' }),
        itemAt: 10,
        detailsAt: 0,
      }),
    ).toBeNull();
  });

  it('nothing known is no alert', () => {
    expect(pullRequestAlert({ detailsAt: 0, itemAt: 0 })).toBeNull();
    expect(pullRequestAlert({ details: green, detailsAt: 10, itemAt: 0 })).toBeNull();
    expect(
      pullRequestAlert({ item: listed({ ciStatus: 'pending' }), itemAt: 10, detailsAt: 0 }),
    ).toBeNull();
  });

  it('alertPanelWords says it after the toggle’s label', () => {
    expect(alertPanelWords({ failingChecks: true, changesRequested: false })).toBe(
      'where the pull request has a failing check',
    );
    expect(alertPanelWords({ failingChecks: false, changesRequested: true })).toBe(
      'where the pull request has changes requested',
    );
    expect(alertPanelWords({ failingChecks: true, changesRequested: true })).toBe(
      'where the pull request has a failing check and changes requested',
    );
  });
});
