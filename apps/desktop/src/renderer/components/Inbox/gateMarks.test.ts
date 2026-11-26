import { describe, expect, it } from 'vitest';
import type { RunListEntry } from '../../../shared/automations';
import { gateMarksByItem } from './gateMarks';

const PR = (n: number) => `https://github.com/sprocket/catalog-portal/pull/${n}`;

function entry(id: string, url: string, overrides: Partial<RunListEntry> = {}): RunListEntry {
  return {
    id,
    runner: 'local',
    source: 'personal',
    automationId: 'review-assigned-prs-gated',
    actionName: 'steps',
    actionVersion: 'v1',
    mode: 'auto',
    trigger: {
      kind: 'event',
      at: '2026-11-22T10:00:00.000Z',
      item: {
        key: `github:sprocket/catalog-portal:pr:${url.split('/').pop()}`,
        url,
        title: 'Fix the cart total',
      },
    },
    status: 'running',
    attribution: {
      automationId: 'review-assigned-prs-gated',
      actionName: 'steps',
      triggerKind: 'event',
    },
    createdAt: '2026-11-22T10:00:00.000Z',
    updatedAt: '2026-11-22T10:00:00.000Z',
    kind: 'agent',
    ...overrides,
  };
}

const gateRun = (id: string, url: string, overrides: Partial<RunListEntry> = {}) =>
  entry(id, url, {
    status: 'waiting',
    step: { id: 'decide', status: 'waiting', index: 3, count: 5, kind: 'gate', gate: true },
    ...overrides,
  });
const runningRun = (id: string, url: string, overrides: Partial<RunListEntry> = {}) =>
  entry(id, url, {
    step: { id: 'review', status: 'running', index: 2, count: 5, kind: 'agent' },
    ...overrides,
  });

describe('gateMarksByItem', () => {
  it('marks an item whose newest run waits at a gate', () => {
    const marks = gateMarksByItem([gateRun('r1', PR(51)), runningRun('r2', PR(52))]);
    expect(marks.get(PR(51))).toEqual({
      runId: 'r1',
      automation: 'review-assigned-prs-gated',
      step: 'decide',
    });
    expect(marks.has(PR(52))).toBe(false);
  });

  it('leaves a run waiting out a retry, or one that ended, unmarked', () => {
    const marks = gateMarksByItem([
      entry('r1', PR(51), {
        status: 'waiting',
        step: {
          id: 'review',
          status: 'waiting',
          index: 2,
          count: 5,
          kind: 'agent',
          retryAt: '2026-11-22T10:05:00.000Z',
        },
      }),
      entry('r2', PR(52), {
        status: 'rejected',
        step: { id: 'decide', status: 'completed', index: 3, count: 5, kind: 'gate', gate: true },
      }),
    ]);
    expect(marks.size).toBe(0);
  });

  it('keeps the parked run marked while a newer one waits in line behind it', () => {
    const marks = gateMarksByItem([
      runningRun('r2', PR(51), { status: 'queued', createdAt: '2026-11-22T11:00:00.000Z' }),
      gateRun('r1', PR(51)),
    ]);
    expect(marks.get(PR(51))?.runId).toBe('r1');
  });

  it('names the newest of two runs waiting at gates on one item', () => {
    const marks = gateMarksByItem([
      gateRun('old', PR(51)),
      gateRun('new', PR(51), {
        automationId: 'triage',
        createdAt: '2026-11-22T11:00:00.000Z',
        step: { id: 'ask', status: 'waiting', index: 1, count: 2, kind: 'gate', gate: true },
      }),
    ]);
    expect(marks.get(PR(51))).toEqual({ runId: 'new', automation: 'triage', step: 'ask' });
  });

  it('marks nothing for a run with no item', () => {
    const run = gateRun('r1', PR(51));
    expect(
      gateMarksByItem([{ ...run, trigger: { kind: 'manual', at: run.createdAt, by: 'person' } }])
        .size,
    ).toBe(0);
  });
});
