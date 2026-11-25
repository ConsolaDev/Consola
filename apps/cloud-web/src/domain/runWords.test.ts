import { describe, expect, it } from 'vitest';
import type { RunStatus, RunSummary, StepSummary } from './runs';
import {
  agoInWords,
  childFactsWords,
  childStateWords,
  childrenTone,
  childrenWords,
  costInWords,
  durationInWords,
  itemLabel,
  lookOf,
  PHASE_HINTS,
  PHASE_LABELS,
  progressWords,
  questionWords,
  runnerWords,
  shareOf,
  statusWords,
  stepKindWords,
  stepLook,
  stepStatusWords,
  triggerWords,
  versionWords,
  workedFor,
} from './runWords';

/** A run as the cell answers one, with what a test changes. */
function aRun(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id: 'run-1',
    kind: 'automation',
    title: 'Review the pull request',
    status: 'running',
    phase: 'active',
    waitingOn: null,
    factory: { id: 'f-1', name: 'Reviews', version: 2 },
    teamId: 't-1',
    automation: 'review',
    parentId: null,
    trigger: 'manual',
    triggerDetail: null,
    startedBy: 'p-ada',
    item: null,
    runner: 'cloud',
    progress: { total: 4, done: 1, current: 'review' },
    children: null,
    summary: null,
    error: null,
    costUsd: null,
    createdAt: '2026-11-23T10:00:00.000Z',
    startedAt: '2026-11-23T10:00:05.000Z',
    finishedAt: null,
    updatedAt: '2026-11-23T10:01:00.000Z',
    ...overrides,
  };
}

const NOW = Date.parse('2026-11-23T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('PHASE_LABELS', () => {
  it('says each phase as the chips name it', () => {
    expect(PHASE_LABELS).toEqual({
      active: 'Running',
      completed: 'Complete',
      failed: 'Failed',
      'needs-you': 'Blocked',
      stopped: 'Cancelled',
    });
    expect(Object.keys(PHASE_HINTS).sort()).toEqual(Object.keys(PHASE_LABELS).sort());
  });
});

describe('statusWords', () => {
  it('says a status', () => {
    expect(statusWords(aRun({ status: 'needs-approval', phase: 'needs-you' }))).toBe(
      'Needs approval',
    );
    expect(statusWords(aRun({ status: 'expired', phase: 'failed' }))).toBe('Expired');
  });

  it('says what a waiting run waits on', () => {
    const waiting = { status: 'waiting' as const, phase: 'active' as const };
    expect(statusWords(aRun({ ...waiting, kind: 'request', waitingOn: 'run' }))).toBe(
      'Waiting on its automations',
    );
    expect(
      statusWords(aRun({ ...waiting, kind: 'request', waitingOn: 'person', phase: 'needs-you' })),
    ).toBe('Waiting for an answer');
  });

  it('says why a request that is at work waits on someone', () => {
    expect(
      statusWords(
        aRun({ kind: 'request', status: 'waiting', waitingOn: 'run', phase: 'needs-you' }),
      ),
    ).toBe('Waiting on its automations');
    expect(statusWords(aRun({ kind: 'request', status: 'running', phase: 'needs-you' }))).toBe(
      'An automation needs someone',
    );
  });

  it('still says a status a newer cell sends', () => {
    expect(statusWords(aRun({ status: 'paused-for-lunch' as RunStatus }))).toBe('Paused for lunch');
  });
});

describe('lookOf', () => {
  const look = (run: Partial<RunSummary>) => lookOf(aRun(run));

  it('draws each status', () => {
    expect(look({ status: 'queued', phase: 'active' })).toBe('queued');
    expect(look({ status: 'running', phase: 'active' })).toBe('running');
    expect(look({ status: 'waiting', waitingOn: 'run', phase: 'active' })).toBe('running');
    expect(look({ status: 'needs-approval', phase: 'needs-you' })).toBe('needs-you');
    expect(look({ status: 'waiting', waitingOn: 'person', phase: 'needs-you' })).toBe('question');
    expect(look({ status: 'completed', phase: 'completed' })).toBe('completed');
    expect(look({ status: 'expired', phase: 'failed' })).toBe('failed');
    expect(look({ status: 'rejected', phase: 'stopped' })).toBe('stopped');
  });

  it('draws a request that waits on someone through its automations as waiting on someone', () => {
    expect(look({ kind: 'request', status: 'running', phase: 'needs-you' })).toBe('needs-you');
    expect(look({ status: 'waiting', waitingOn: 'run', phase: 'needs-you' })).toBe('needs-you');
  });

  it('draws a status a newer cell sends by its phase', () => {
    expect(look({ status: 'thinking' as RunStatus, phase: 'active' })).toBe('running');
    expect(look({ status: 'thinking' as RunStatus, phase: 'odd' as RunSummary['phase'] })).toBe(
      'stopped',
    );
  });
});

describe('steps', () => {
  it('says and draws each step status, and one it does not know', () => {
    expect(stepStatusWords('not-run')).toBe('Not run');
    expect(stepStatusWords('paused' as StepSummary['status'])).toBe('Paused');
    expect(stepLook('reported')).toBe('completed');
    expect(stepLook('skipped')).toBe('stopped');
    expect(stepLook('pending')).toBe('queued');
    expect(stepLook('waiting')).toBe('running');
  });

  it('says what a step is', () => {
    expect(stepKindWords({ kind: 'agent', agent: 'reviewer' })).toBe('Agent reviewer');
    expect(stepKindWords({ kind: 'agent', agent: null })).toBe('Agent');
    expect(stepKindWords({ kind: 'run', agent: null })).toBe('Command');
  });
});

describe('triggerWords', () => {
  it('names each trigger', () => {
    expect(triggerWords('cron')).toBe('Schedule');
    expect(triggerWords('manual')).toBe('By a person');
  });
});

describe('itemLabel', () => {
  const item = {
    url: 'https://github.com/acme/app/pull/12',
    title: 'Fix login',
    kind: 'pr' as const,
    repo: 'acme/app',
    number: 12,
    headSha: null,
    baseRef: null,
  };

  it('is the repository’s name and the number', () => {
    expect(itemLabel(item)).toBe('app #12');
    expect(itemLabel({ ...item, repo: null })).toBe('#12');
  });

  it('is the title for an item with no number', () => {
    expect(itemLabel({ ...item, number: null, kind: null })).toBe('Fix login');
  });
});

describe('words for the facts', () => {
  it('says where it ran and which version', () => {
    expect(runnerWords('cloud')).toBe('Consola Cloud');
    expect(versionWords(3, 3)).toBe('v3');
    expect(versionWords(2, 5)).toBe('v2, v5 is the latest');
    expect(versionWords(2, null)).toBe('v2');
  });

  it('says a request’s automations, and tones its badge by the one most worth a look', () => {
    const children = { total: 3, active: 1, needsYou: 1, failed: 1 };
    expect(childrenWords(children)).toBe('3 automations, 1 blocked, 1 failed, 1 running');
    expect(childrenWords({ total: 1, active: 0, needsYou: 0, failed: 0 })).toBe('1 automation');
    expect(childrenTone(children)).toBe('needs-you');
    expect(childrenTone({ ...children, needsYou: 0 })).toBe('failed');
    expect(childrenTone({ total: 2, active: 1, needsYou: 0, failed: 0 })).toBe('running');
    expect(childrenTone({ total: 2, active: 0, needsYou: 0, failed: 0 })).toBe('quiet');
  });

  it('says where an automation run is in its steps', () => {
    expect(progressWords({ total: 4, done: 1, current: 'review' })).toBe('Step 2 of 4: review');
    expect(progressWords({ total: 4, done: 4, current: null })).toBe('4 of 4 steps');
  });

  it('says a cost', () => {
    expect(costInWords(null)).toBeNull();
    expect(costInWords(0)).toBe('$0.00');
    expect(costInWords(0.004)).toBe('<$0.01');
    expect(costInWords(1234.5)).toBe('$1,234.50');
  });

  it('measures a budget', () => {
    expect(shareOf(1, 4)).toBe(0.25);
    expect(shareOf(5, 4)).toBe(1);
    expect(shareOf(0, 0)).toBe(0);
    expect(shareOf(1, 0)).toBe(1);
  });
});

describe('times', () => {
  it('says a duration as the desktop does', () => {
    expect(durationInWords(400)).toBe('<1s');
    expect(durationInWords(42_000)).toBe('42s');
    expect(durationInWords(185_000)).toBe('3m 5s');
    expect(durationInWords(3_840_000)).toBe('1h 04m');
  });

  it('measures how long a run worked, to now while it works', () => {
    expect(workedFor({ startedAt: null, finishedAt: null }, NOW)).toBeNull();
    expect(workedFor({ startedAt: ago(90_000), finishedAt: null }, NOW)).toBe(90_000);
    expect(workedFor({ startedAt: ago(90_000), finishedAt: ago(30_000) }, NOW)).toBe(60_000);
  });

  it('says how long ago', () => {
    expect(agoInWords(ago(20_000), NOW)).toBe('just now');
    expect(agoInWords(ago(5 * 60_000), NOW)).toBe('5m ago');
    expect(agoInWords(ago(3 * 3_600_000), NOW)).toBe('3h ago');
    expect(agoInWords(ago(2 * 86_400_000), NOW)).toBe('2d ago');
    expect(agoInWords(ago(30 * 86_400_000), NOW)).not.toMatch(/ago/);
    expect(agoInWords('not a time', NOW)).toBe('');
  });

  it('says an open question by when it was asked and its deadline', () => {
    expect(questionWords({ at: ago(5 * 60_000), until: ago(-3_600_000) }, NOW)).toMatch(
      /^Asked 5m ago, open until \S/,
    );
  });
});

describe('an automation a request started', () => {
  it('says the step it is on, what it waits for, or how it ended', () => {
    expect(childStateWords(aRun({ progress: { total: 4, done: 1, current: 'report' } }))).toBe(
      'Step 2 of 4 · report',
    );
    expect(childStateWords(aRun({ status: 'queued', progress: null }))).toBe('Queued');
    expect(childStateWords(aRun({ status: 'needs-approval', phase: 'needs-you' }))).toBe(
      'Needs approval',
    );
    expect(
      childStateWords(
        aRun({ status: 'failed', phase: 'failed', error: '\nexit 1: tests failed\nmore' }),
      ),
    ).toBe('exit 1: tests failed');
    expect(
      childStateWords(aRun({ status: 'completed', phase: 'completed', summary: 'Opened #12.' })),
    ).toBe('Opened #12.');
    expect(childStateWords(aRun({ status: 'cancelled', phase: 'stopped' }))).toBe('Cancelled');
  });

  it('says when it started, how long it worked and what it cost', () => {
    expect(
      childFactsWords(
        aRun({ startedAt: ago(300_000), finishedAt: ago(240_000), costUsd: 0.12 }),
        NOW,
      ),
    ).toBe('5m ago · 1m 0s · $0.12');
    expect(childFactsWords(aRun({ startedAt: null, createdAt: ago(60_000) }), NOW)).toBe('1m ago');
  });
});
