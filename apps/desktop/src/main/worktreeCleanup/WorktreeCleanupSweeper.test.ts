import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FIRST_SWEEP_GRACE_MS,
  LOCAL_SWEEP_MS,
  PULL_REQUEST_SWEEP_MS,
  WorktreeCleanupSweeper,
} from './WorktreeCleanupSweeper';

let reporters: Array<() => void>;
let ruleOn: boolean;
let sweeps: Array<{ refreshPullRequests: boolean }>;

function sweeper() {
  return new WorktreeCleanupSweeper({
    sweep: async (options) => {
      sweeps.push(options);
    },
    anyRuleOn: () => ruleOn,
    onWindowReport: (listener) => {
      reporters.push(listener);
      return () => {
        reporters = reporters.filter((candidate) => candidate !== listener);
      };
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  reporters = [];
  ruleOn = true;
  sweeps = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe('WorktreeCleanupSweeper', () => {
  it('waits for a window to report before the first sweep', () => {
    const subject = sweeper();
    subject.start();
    expect(sweeps).toEqual([]);
    for (const report of [...reporters]) report();
    expect(sweeps).toEqual([{ refreshPullRequests: true }]);
    // Once: a second report is not a second first sweep.
    for (const report of [...reporters]) report();
    expect(sweeps).toHaveLength(1);
    subject.stop();
  });

  it('sweeps anyway after the grace period when no window ever reports', () => {
    const subject = sweeper();
    subject.start();
    vi.advanceTimersByTime(FIRST_SWEEP_GRACE_MS);
    expect(sweeps).toHaveLength(1);
    subject.stop();
  });

  it('runs local rules every five minutes and asks about pull requests every thirty', () => {
    const subject = sweeper();
    subject.start();
    vi.advanceTimersByTime(FIRST_SWEEP_GRACE_MS);
    sweeps = [];
    vi.advanceTimersByTime(PULL_REQUEST_SWEEP_MS);
    expect(sweeps.filter((sweep) => !sweep.refreshPullRequests)).toHaveLength(
      PULL_REQUEST_SWEEP_MS / LOCAL_SWEEP_MS,
    );
    expect(sweeps.filter((sweep) => sweep.refreshPullRequests)).toHaveLength(1);
    subject.stop();
  });

  it('does nothing at all while every rule is off', () => {
    ruleOn = false;
    const subject = sweeper();
    subject.start();
    for (const report of [...reporters]) report();
    vi.advanceTimersByTime(PULL_REQUEST_SWEEP_MS * 2);
    subject.kick();
    vi.runOnlyPendingTimers();
    expect(sweeps).toEqual([]);
    subject.stop();
  });

  it('coalesces kicks, and never kicks before the first sweep', () => {
    const subject = sweeper();
    subject.start();
    subject.kick();
    vi.advanceTimersByTime(0);
    expect(sweeps).toEqual([]);
    for (const report of [...reporters]) report();
    sweeps = [];
    subject.kick(1000);
    subject.kick(1000);
    vi.advanceTimersByTime(1000);
    expect(sweeps).toHaveLength(1);
    subject.stop();
  });
});
