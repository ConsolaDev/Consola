import { describe, expect, expectTypeOf, it } from 'vitest';
import type { components } from './cellApiContract';
import {
  BACKGROUND_TRIGGERS,
  isLive,
  LIST_POLL_LIVE_MS,
  LIST_POLL_QUIET_MS,
  listPollDelay,
  mergeRefresh,
  PHASES,
  progressOf,
  RUN_POLL_ACTIVE_MS,
  RUN_POLL_WAITING_MS,
  refreshLimit,
  runPollDelay,
  safeItemUrl,
  starterOf,
  stepHasEnded,
} from './runs';
import type { Phase, RUN_TRIGGERS, RunSummary, RunTrigger } from './runs';

type Schemas = components['schemas'];

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

const ada = {
  id: 'p-ada',
  name: 'Ada',
  email: 'ada@acme.test',
  image: null,
  role: 'owner' as const,
};

describe('the page’s copies of the contract', () => {
  it('names every phase the cell counts, and only those', () => {
    expectTypeOf<(typeof PHASES)[number]>().toEqualTypeOf<Phase>();
    expectTypeOf<keyof Schemas['PhaseCounts']>().toEqualTypeOf<Phase>();
    expect([...PHASES].sort()).toEqual(['active', 'completed', 'failed', 'needs-you', 'stopped']);
  });

  it('names every trigger, and background runs are the three no person pulls', () => {
    expectTypeOf<(typeof RUN_TRIGGERS)[number]>().toEqualTypeOf<RunTrigger>();
    expect(BACKGROUND_TRIGGERS).toEqual(['cron', 'event', 'poll']);
  });
});

describe('isLive', () => {
  it('is a run that works or waits on someone', () => {
    expect(PHASES.filter((phase) => isLive({ phase }))).toEqual(['active', 'needs-you']);
  });
});

describe('stepHasEnded', () => {
  it('reads the status as the cell counts progress, not the finish time', () => {
    const statuses: Schemas['StepStatus'][] = [
      'pending',
      'queued',
      'running',
      'waiting',
      'completed',
      'failed',
      'skipped',
      'reported',
      'not-run',
    ];
    expect(statuses.filter((status) => stepHasEnded({ status }))).toEqual([
      'completed',
      'failed',
      'skipped',
      'reported',
      'not-run',
    ]);
  });
});

describe('refreshLimit', () => {
  it('reads every row shown again, a page at least, up to the cell’s most', () => {
    expect(refreshLimit(0)).toBe(50);
    expect(refreshLimit(50)).toBe(50);
    expect(refreshLimit(73)).toBe(73);
    expect(refreshLimit(150)).toBe(100);
  });
});

describe('mergeRefresh', () => {
  const at = (minute: number) => `2026-11-23T10:${String(minute).padStart(2, '0')}:00.000Z`;
  const run = (id: string, minute: number, phase: Phase = 'active') =>
    aRun({ id, createdAt: at(minute), phase });

  it('takes the refresh whole when it reached every row shown', () => {
    const shown = { runs: [run('b', 2), run('a', 1)], nextCursor: null };
    const fresh = { runs: [run('c', 3), run('b', 2, 'completed'), run('a', 1)], nextCursor: null };
    expect(mergeRefresh(shown, fresh)).toEqual(fresh);
  });

  it('drops a run the refresh no longer lists within its reach', () => {
    const shown = { runs: [run('c', 3), run('b', 2), run('a', 1)], nextCursor: 'after-a' };
    const fresh = { runs: [run('c', 3), run('a', 1)], nextCursor: 'after-a' };
    expect(mergeRefresh(shown, fresh).runs.map((r) => r.id)).toEqual(['c', 'a']);
  });

  it('keeps rows new runs pushed past the refresh, and Load more goes on after them', () => {
    const shown = { runs: [run('c', 3), run('b', 2), run('a', 1)], nextCursor: 'after-a' };
    const fresh = { runs: [run('e', 5), run('d', 4), run('c', 3)], nextCursor: 'after-c' };
    expect(mergeRefresh(shown, fresh)).toEqual({
      runs: [run('e', 5), run('d', 4), run('c', 3), run('b', 2), run('a', 1)],
      nextCursor: 'after-a',
    });
  });

  it('orders runs made in the same instant by id, as the cell does', () => {
    const shown = { runs: [run('b', 1), run('a', 1)], nextCursor: 'after-a' };
    const fresh = { runs: [run('c', 1), run('b', 1)], nextCursor: 'after-b' };
    expect(mergeRefresh(shown, fresh).runs.map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('listPollDelay', () => {
  it('reads often while a run shown can change, and seldom once none can', () => {
    expect(listPollDelay([{ phase: 'completed' }, { phase: 'needs-you' }])).toBe(LIST_POLL_LIVE_MS);
    expect(listPollDelay([{ phase: 'completed' }, { phase: 'failed' }])).toBe(LIST_POLL_QUIET_MS);
    expect(listPollDelay([])).toBe(LIST_POLL_QUIET_MS);
  });
});

describe('runPollDelay', () => {
  it('reads a working run every few seconds', () => {
    expect(runPollDelay({ run: { phase: 'active' }, children: [] })).toBe(RUN_POLL_ACTIVE_MS);
  });

  it('reads a run that waits on someone more slowly', () => {
    expect(runPollDelay({ run: { phase: 'needs-you' }, children: [] })).toBe(RUN_POLL_WAITING_MS);
  });

  it('follows a request’s automations, which can still work after it', () => {
    expect(runPollDelay({ run: { phase: 'completed' }, children: [{ phase: 'active' }] })).toBe(
      RUN_POLL_ACTIVE_MS,
    );
  });

  it('stops once nothing on the page can change', () => {
    expect(
      runPollDelay({ run: { phase: 'failed' }, children: [{ phase: 'completed' }] }),
    ).toBeNull();
  });
});

describe('progressOf', () => {
  it('is an automation run’s steps ended', () => {
    expect(progressOf(aRun({ progress: { total: 4, done: 1, current: 'x' } }))).toBe(0.25);
  });

  it('is a request’s automations ended', () => {
    const children = { total: 4, active: 1, needsYou: 1, failed: 1 };
    expect(progressOf(aRun({ progress: null, children }))).toBe(0.5);
  });

  it('says nothing for a run with nothing to count', () => {
    expect(progressOf(aRun({ progress: { total: 0, done: 0, current: null } }))).toBeNull();
    expect(
      progressOf(
        aRun({ progress: null, children: { total: 0, active: 0, needsYou: 0, failed: 0 } }),
      ),
    ).toBeNull();
  });
});

describe('starterOf', () => {
  it('names a member', () => {
    expect(starterOf({ startedBy: 'p-ada' }, [ada])).toEqual({ kind: 'member', member: ada });
  });

  it('says someone left when the members list no longer holds them', () => {
    expect(starterOf({ startedBy: 'p-bob' }, [ada])).toEqual({ kind: 'left', personId: 'p-bob' });
  });

  it('names nobody before the members are known, and for a run no person started', () => {
    expect(starterOf({ startedBy: 'p-ada' }, null)).toEqual({ kind: 'unknown', personId: 'p-ada' });
    expect(starterOf({ startedBy: null }, [ada])).toEqual({ kind: 'none' });
  });
});

describe('safeItemUrl', () => {
  it('keeps an https address', () => {
    expect(safeItemUrl('https://github.com/acme/app/pull/12')).toBe(
      'https://github.com/acme/app/pull/12',
    );
  });

  it('refuses anything else, which would land in a link', () => {
    expect(safeItemUrl('javascript:alert(1)')).toBeNull();
    expect(safeItemUrl('http://github.com/acme/app/pull/12')).toBeNull();
    expect(safeItemUrl('not a url')).toBeNull();
  });
});
