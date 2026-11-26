// @effect-diagnostics nodeBuiltinImport:off - The tests hash as the runner does.
import { createHash } from 'node:crypto';
import { OUTPUT_TAIL_MAX, readRunRecord } from '@consola/runner-protocol';
import type { RunRecord } from '@consola/runner-protocol';
import { describe, expect, it } from 'vite-plus/test';
import { endedRecordOf, frameBytesOf, runIdOf, tailWithin, withinFrame } from './runRecord.ts';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const bytes = (text: string) => new TextEncoder().encode(text).length;

const step = (id: string, fields: Partial<RunRecord['steps'][number]> = {}) => ({
  id,
  kind: 'agent' as const,
  status: 'pending' as const,
  attempt: 1,
  agent: null,
  model: null,
  startedAt: null,
  finishedAt: null,
  costUsd: null,
  error: null,
  skipped: null,
  outputs: null,
  artifacts: [],
  turn: null,
  command: null,
  previous: [],
  reminded: false,
  output: null,
  ...fields,
});

const RUN: RunRecord = {
  id: 'run-0123456789abcdef0123456789abcdef',
  factoryId: 'factory-sprocket',
  factoryVersion: 3,
  parent: null,
  automation: 'review-pr',
  status: 'needs-approval',
  waitingOn: null,
  trigger: 'event',
  triggerDetail: 'pull_request.opened',
  startedBy: null,
  item: {
    url: 'https://github.com/sprocket/catalog-portal/pull/42',
    title: 'Add a retry to the catalog sync',
    kind: 'pr',
    repo: 'sprocket/catalog-portal',
    number: 42,
    headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    baseRef: 'main',
  },
  runner: 'cloud',
  steps: [step('review'), step('post', { kind: 'run' })],
  request: null,
  summary: null,
  error: null,
  costUsd: null,
  createdAt: '2026-11-25T10:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  updatedAt: '2026-11-25T10:00:00.000Z',
};

describe('runIdOf', () => {
  it('is the same for the same delivery, factory and automation, and another for any other', () => {
    const id = runIdOf(sha256, 'd0c5-1', 'factory-sprocket', 'review-pr');
    expect(id).toMatch(/^run-[0-9a-f]{32}$/);
    expect(runIdOf(sha256, 'd0c5-1', 'factory-sprocket', 'review-pr')).toBe(id);
    expect(runIdOf(sha256, 'd0c5-2', 'factory-sprocket', 'review-pr')).not.toBe(id);
    expect(runIdOf(sha256, 'd0c5-1', 'factory-acme', 'review-pr')).not.toBe(id);
    expect(runIdOf(sha256, 'd0c5-1', 'factory-sprocket', 'triage')).not.toBe(id);
    // Parts never run into each other.
    expect(runIdOf(sha256, 'd0c5-1', 'factory-a', 'b-review')).not.toBe(
      runIdOf(sha256, 'd0c5-1', 'factory-a-b', 'review'),
    );
  });
});

describe('tailWithin', () => {
  it('keeps all of a text that fits, else its last whole lines that do', () => {
    expect(tailWithin('one\ntwo\n', 100)).toEqual({ text: 'one\ntwo\n', cut: false });
    expect(tailWithin('first line\nsecond\n', 9)).toEqual({ text: 'second\n', cut: true });
    expect(tailWithin('a'.repeat(20), 5)).toEqual({ text: 'aaaaa', cut: true });
    // A cut inside a character leaves no broken one behind.
    expect(tailWithin('ééééé', 5).text).toBe('éé');
  });
});

describe('withinFrame', () => {
  it('leaves a record that fits as it is', () => {
    expect(withinFrame(RUN)).toBe(RUN);
  });

  it('cuts every step’s output to what fits beside the rest, and the record still reads', () => {
    const tail = `${'x'.repeat(99)}\n`.repeat(160);
    const big: RunRecord = {
      ...RUN,
      steps: RUN.steps.map((one) => ({
        ...one,
        output: { stdout: tail, stderr: tail, truncated: false },
      })),
    };
    const max = frameBytesOf(RUN) + 20_000;
    const fitted = withinFrame(big, max);
    if (fitted === null) throw new Error('it did not fit');
    expect(frameBytesOf(fitted)).toBeLessThanOrEqual(max);
    for (const one of fitted.steps) {
      expect(one.output?.truncated).toBe(true);
      expect(bytes(one.output?.stdout ?? '')).toBeLessThanOrEqual(OUTPUT_TAIL_MAX);
      expect(one.output?.stdout.endsWith('x\n')).toBe(true);
    }
    expect(readRunRecord(JSON.parse(JSON.stringify(fitted))).ok).toBe(true);
  });

  it('is null for a record that does not fit even with no output, which the ring fails', () => {
    expect(withinFrame(RUN, frameBytesOf(RUN) - 1)).toBeNull();
  });
});

describe('endedRecordOf', () => {
  it('ends a record the ring does not walk: every step it had not reached not-run', () => {
    const failed = endedRecordOf(
      RUN,
      { status: 'failed', error: 'Version 3 of its factory is gone, so it cannot run.' },
      '2026-11-25T11:00:00.000Z',
    );
    expect(failed).toMatchObject({
      status: 'failed',
      error: 'Version 3 of its factory is gone, so it cannot run.',
      finishedAt: '2026-11-25T11:00:00.000Z',
      updatedAt: '2026-11-25T11:00:00.000Z',
    });
    expect(failed.steps.map((one) => one.status)).toEqual(['not-run', 'not-run']);
    const rejected = endedRecordOf(RUN, { status: 'rejected' }, '2026-11-25T11:00:00.000Z');
    expect(rejected.status).toBe('rejected');
    expect(rejected.error).toBeNull();
    expect(readRunRecord(JSON.parse(JSON.stringify(rejected))).ok).toBe(true);
  });
});
