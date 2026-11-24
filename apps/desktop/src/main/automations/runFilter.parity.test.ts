import { describe, expect, it } from 'vitest';
import { filterRuns as engineFilterRuns, NO_RUN_FILTER } from '@consola/automation-engine';
import type { RunListEntry, RunListFilter } from '@consola/automation-engine';
import { filterRuns as rendererFilterRuns } from '../../renderer/components/Automations/presentation';

/**
 * Main searches the whole history with the engine's copy of the rule the
 * panel filters with. Two copies exist on purpose (the renderer may take only
 * the engine's types); this is what keeps them one rule.
 */

const NOW = new Date('2026-11-12T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function run(overrides: Partial<RunListEntry> = {}): RunListEntry {
  const createdAt = overrides.createdAt ?? ago(HOUR);
  return {
    id: 'r1',
    runner: 'local',
    source: 'personal',
    automationId: 'review-prs',
    actionName: 'prompt',
    actionVersion: 'v1',
    mode: 'auto',
    trigger: { kind: 'cron', at: createdAt },
    status: 'completed',
    attribution: { automationId: 'review-prs', actionName: 'prompt', triggerKind: 'cron' },
    createdAt,
    updatedAt: createdAt,
    kind: 'agent',
    ...overrides,
  };
}

const item = { key: 'k', url: 'u', title: 'Add Catalog Search' };
const RUNS: RunListEntry[] = [
  run({ id: 'old', createdAt: ago(31 * DAY) }),
  run({
    id: 'long',
    createdAt: ago(40 * DAY),
    updatedAt: ago(29 * DAY),
    finishedAt: ago(29 * DAY),
  }),
  run({ id: 'ended', createdAt: ago(40 * DAY), updatedAt: ago(DAY), finishedAt: ago(31 * DAY) }),
  run({ id: 'a', createdAt: ago(2 * DAY) }),
  run({ id: 'b', createdAt: ago(HOUR), kind: 'tool', summary: 'Removed 3 sessions' }),
  run({ id: 'tied', createdAt: ago(HOUR), kind: 'request' }),
  run({ id: 'waiting', status: 'needs-approval', createdAt: ago(45 * DAY) }),
  run({ id: 'parked', status: 'waiting', createdAt: ago(45 * DAY) }),
  run({ id: 'queued', status: 'queued', createdAt: ago(46 * DAY) }),
  run({ id: 'running', status: 'running', createdAt: ago(47 * DAY), automationId: 'digest' }),
  run({
    id: 'f',
    status: 'failed',
    createdAt: ago(3 * HOUR),
    kind: 'tool',
    automationId: 'digest',
  }),
  run({ id: 'rf', status: 'failed', createdAt: ago(5 * HOUR), automationId: 'review-prs-nightly' }),
  run({ id: 'titled', createdAt: ago(6 * HOUR), trigger: { kind: 'event', at: '', item } }),
  run({ id: 'bad-date', createdAt: 'not a date' }),
];

const FILTERS: RunListFilter[] = [
  NO_RUN_FILTER,
  { ...NO_RUN_FILTER, query: 'catalog search' },
  { ...NO_RUN_FILTER, query: '  REMOVED ' },
  { ...NO_RUN_FILTER, query: 'digest' },
  { ...NO_RUN_FILTER, kind: 'agent' },
  { ...NO_RUN_FILTER, kind: 'tool' },
  { ...NO_RUN_FILTER, kind: 'failed' },
  { ...NO_RUN_FILTER, automation: 'review-prs' },
  { ...NO_RUN_FILTER, automation: 'digest', kind: 'failed' },
  { query: 'review', kind: 'agent', automation: 'review-prs' },
  { ...NO_RUN_FILTER, query: 'no such text' },
];

describe('the engine and the renderer filter runs alike', () => {
  for (const [index, filter] of FILTERS.entries()) {
    it(`returns the same ids in the same order for filter ${index}: ${JSON.stringify(filter)}`, () => {
      const engine = engineFilterRuns(RUNS, filter, NOW).map((entry) => entry.id);
      const renderer = rendererFilterRuns(RUNS, filter, NOW).map((entry) => entry.id);
      expect(engine).toEqual(renderer);
    });
  }

  it('both keep a run parked at a gate or a retry however old, as history keeps it', () => {
    expect(engineFilterRuns(RUNS, NO_RUN_FILTER, NOW).map((run) => run.id)).toContain('parked');
    expect(rendererFilterRuns(RUNS, NO_RUN_FILTER, NOW).map((run) => run.id)).toContain('parked');
  });

  it('agrees on an empty list', () => {
    expect(engineFilterRuns([], NO_RUN_FILTER, NOW)).toEqual(
      rendererFilterRuns([], NO_RUN_FILTER, NOW),
    );
  });
});
