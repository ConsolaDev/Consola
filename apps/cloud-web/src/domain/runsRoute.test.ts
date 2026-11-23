import { describe, expect, it } from 'vitest';
import { NO_FILTERS, togglePhase } from './runFilters';
import { hashOfRun, hashOfRunsList, RUNS_SECTION_ID, runsRouteOfHash } from './runsRoute';
import { sectionIdOfHash } from './sections';

describe('runsRouteOfHash', () => {
  it('is the list, unfiltered, at #/runs', () => {
    expect(runsRouteOfHash('#/runs')).toEqual({ kind: 'list', filters: NO_FILTERS });
    expect(runsRouteOfHash('#/runs/')).toEqual({ kind: 'list', filters: NO_FILTERS });
  });

  it('reads the list’s filters after ?', () => {
    expect(runsRouteOfHash('#/runs?phase=failed')).toEqual({
      kind: 'list',
      filters: { ...NO_FILTERS, phases: ['failed'] },
    });
  });

  it('is one run at #/runs/<id>', () => {
    expect(runsRouteOfHash('#/runs/run-42')).toEqual({ kind: 'run', runId: 'run-42' });
    expect(runsRouteOfHash('#/runs/run%2042/')).toEqual({ kind: 'run', runId: 'run 42' });
  });

  it('is the list for an id it cannot read', () => {
    expect(runsRouteOfHash('#/runs/%E0%A4%A')).toEqual({ kind: 'list', filters: NO_FILTERS });
    expect(runsRouteOfHash('#/runs/a/b')).toEqual({ kind: 'list', filters: NO_FILTERS });
  });
});

describe('hashOfRunsList and hashOfRun', () => {
  it('round-trips the list and a run', () => {
    const filters = togglePhase(NO_FILTERS, 'needs-you');
    expect(hashOfRunsList(NO_FILTERS)).toBe('#/runs');
    expect(hashOfRunsList(filters)).toBe('#/runs?phase=needs-you');
    expect(runsRouteOfHash(hashOfRunsList(filters))).toEqual({ kind: 'list', filters });
    expect(runsRouteOfHash(hashOfRun('a/b c'))).toEqual({ kind: 'run', runId: 'a/b c' });
  });

  it('stays in the Runs section, whatever follows', () => {
    expect(sectionIdOfHash(hashOfRun('run-1'))).toBe(RUNS_SECTION_ID);
    expect(sectionIdOfHash(hashOfRunsList(togglePhase(NO_FILTERS, 'failed')))).toBe(
      RUNS_SECTION_ID,
    );
  });
});
