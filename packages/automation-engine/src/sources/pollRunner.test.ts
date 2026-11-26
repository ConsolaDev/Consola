import { describe, expect, it } from 'vitest';
import {
  afterFailure,
  afterSuccess,
  checkSpec,
  dueNow,
  latestResult,
  MAX_BACKOFF_MS,
  MAX_CONCURRENT_CHECKS,
  nextCheckAt,
  waitAfter,
} from './pollRunner';
import type { CheckState } from './pollRunner';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ENDED = '2026-11-16T08:00:00.000Z';
const LATER = '2026-11-16T09:30:00.000Z';
const fresh = (): CheckState => ({ failures: 0 });

describe('the check lane', () => {
  it('holds two checks across workspaces, and waits an hour at most unless every is longer', () => {
    expect(MAX_CONCURRENT_CHECKS).toBe(2);
    expect(MAX_BACKOFF_MS).toBe(HOUR);
  });
});

describe('nextCheckAt', () => {
  it('due now when it never ran', () => {
    expect(nextCheckAt(fresh(), 30 * MINUTE)).toBe('now');
    // Allow, or a Check now waiting for a slot, makes it due again at once, whatever it found last.
    const checked = afterSuccess(fresh(), ENDED);
    expect(nextCheckAt(dueNow(checked), 30 * MINUTE)).toBe('now');
    expect(nextCheckAt(dueNow(afterFailure(checked, ENDED, 'exit 1')), 30 * MINUTE)).toBe('now');
  });

  it('due every after the last end', () => {
    expect(nextCheckAt(afterSuccess(fresh(), ENDED), 30 * MINUTE)).toBe(
      Date.parse(ENDED) + 30 * MINUTE,
    );
    expect(nextCheckAt(afterFailure(fresh(), ENDED, 'exit 1'), 30 * MINUTE)).toBe(
      Date.parse(ENDED) + HOUR,
    );
  });
});

describe('waitAfter', () => {
  it('the wait doubles after failures and stops at the larger of every and an hour', () => {
    expect(waitAfter(0, 10 * MINUTE)).toBe(10 * MINUTE);
    expect([1, 2, 3, 4].map((failures) => waitAfter(failures, 10 * MINUTE))).toEqual(
      [20, 40, 60, 60].map((minutes) => minutes * MINUTE),
    );
    expect([0, 1, 2].map((failures) => waitAfter(failures, 2 * HOUR))).toEqual([
      2 * HOUR,
      2 * HOUR,
      2 * HOUR,
    ]);
    // However long the run of failures.
    expect(waitAfter(5000, 10 * MINUTE)).toBe(HOUR);
  });

  it('a success resets it', () => {
    let state = fresh();
    for (let failure = 0; failure < 3; failure++) {
      state = afterFailure(state, ENDED, 'exit 1: boom');
    }
    expect(state).toMatchObject({
      failures: 3,
      lastEndedAt: ENDED,
      outcome: { at: ENDED, error: 'exit 1: boom' },
    });
    expect(nextCheckAt(state, 10 * MINUTE)).toBe(Date.parse(ENDED) + HOUR);
    const succeeded = afterSuccess(state, LATER);
    expect(succeeded).toMatchObject({ failures: 0, lastEndedAt: LATER });
    expect(nextCheckAt(succeeded, 10 * MINUTE)).toBe(Date.parse(LATER) + 10 * MINUTE);
  });
});

describe('the state', () => {
  it('is new each time, and keeps the check running and what the last success found', () => {
    const running = { version: 'v1', acceptedVersion: 'v1', startedAt: ENDED };
    const result = { at: ENDED, version: 'v1', items: [] };
    const state: CheckState = { failures: 0, running, result };
    const failedOnce = afterFailure(state, LATER, 'exit 1');
    expect(failedOnce).not.toBe(state);
    expect(state.failures).toBe(0);
    expect(failedOnce).toMatchObject({ running, result });
    expect(afterSuccess(failedOnce, LATER)).toMatchObject({ running, result });
    expect(dueNow(failedOnce)).toMatchObject({
      running,
      result,
      failures: 1,
      outcome: { error: 'exit 1' },
    });
  });
});

describe('latestResult', () => {
  it('is the last success taken at this version, and none for another', () => {
    const items = [{ key: 'T-7', title: 'Ticket 7', url: '', object: { id: 'T-7' } }];
    const state: CheckState = { failures: 0, result: { at: ENDED, version: 'v1', items } };
    expect(latestResult(state, 'v1')).toBe(items);
    // Taken by the version before an edit: another command may have printed it.
    expect(latestResult(state, 'v2')).toBeUndefined();
    expect(latestResult({ failures: 0 }, 'v1')).toBeUndefined();
    expect(latestResult(undefined, 'v1')).toBeUndefined();
  });
});

describe('checkSpec', () => {
  it("gives a check its secrets as their own variables, Consola's still last and hooks off", () => {
    const input = {
      trigger: {
        kind: 'poll' as const,
        run: 'tracker list',
        everyMs: 30 * MINUTE,
        key: '.id',
        timeoutMs: 60_000,
        secrets: ['TRACKER_TOKEN'],
      },
      automation: 'watch-tickets',
      cwd: '/data/ws-1',
      logs: { stdout: '/data/out.log', stderr: '/data/err.log' },
      base: { env: { PATH: '/bin', GH_TOKEN: 'gho_stub' }, secrets: ['gho_stub'] },
    };
    const spec = checkSpec({ ...input, secretValues: { TRACKER_TOKEN: 'v' } });
    expect(spec.env.TRACKER_TOKEN).toBe('v');
    expect(spec.env.CONSOLA_AUTOMATION).toBe('watch-tickets');
    expect(spec.env.GIT_CONFIG_KEY_0).toBe('core.hooksPath');
    expect(checkSpec(input)).toEqual({ ...spec, env: { ...spec.env, TRACKER_TOKEN: undefined } });
    expect('TRACKER_TOKEN' in checkSpec(input).env).toBe(false);
  });

  it("runs the command in the workspace's folder, as the person, with only CONSOLA_AUTOMATION added and hooks off", () => {
    const spec = checkSpec({
      trigger: {
        kind: 'poll',
        run: './list-prs',
        everyMs: 30 * MINUTE,
        item: { connection: 'github', path: '.url' },
        timeoutMs: 60_000,
      },
      automation: 'checker',
      cwd: '/data/ws-1',
      logs: {
        stdout: '/data/ws-1/checks/checker/stdout.log',
        stderr: '/data/ws-1/checks/checker/stderr.log',
      },
      base: { env: { PATH: '/bin', GH_TOKEN: 'gho_stub' }, secrets: ['gho_stub'] },
    });
    expect(spec).toEqual({
      command: './list-prs',
      cwd: '/data/ws-1',
      env: {
        PATH: '/bin',
        GH_TOKEN: 'gho_stub',
        CONSOLA_AUTOMATION: 'checker',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.hooksPath',
        GIT_CONFIG_VALUE_0: '/dev/null',
      },
      timeoutMs: 60_000,
      stdoutPath: '/data/ws-1/checks/checker/stdout.log',
      stderrPath: '/data/ws-1/checks/checker/stderr.log',
      secrets: ['gho_stub'],
    });
  });
});
