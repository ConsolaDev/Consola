import { describe, expect, it } from 'vitest';
import { NO_FILTERS, togglePhase } from './runFilters';
import {
  hashOfRun,
  hashOfRunsList,
  placeOfQuery,
  placeOfTrace,
  queryOfPlace,
  RUN_START,
  RUNS_SECTION_ID,
  runsRouteOfHash,
  traceOfPlace,
} from './runsRoute';
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
    expect(runsRouteOfHash('#/runs/run-42')).toEqual({
      kind: 'run',
      runId: 'run-42',
      place: RUN_START,
    });
    expect(runsRouteOfHash('#/runs/run%2042/')).toEqual({
      kind: 'run',
      runId: 'run 42',
      place: RUN_START,
    });
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
    expect(runsRouteOfHash(hashOfRun('a/b c'))).toEqual({
      kind: 'run',
      runId: 'a/b c',
      place: RUN_START,
    });
  });

  it('stays in the Runs section, whatever follows', () => {
    expect(sectionIdOfHash(hashOfRun('run-1'))).toBe(RUNS_SECTION_ID);
    expect(sectionIdOfHash(hashOfRunsList(togglePhase(NO_FILTERS, 'failed')))).toBe(
      RUNS_SECTION_ID,
    );
  });
});

describe('a place on a run’s page', () => {
  it('reads the view, the step and the run after ?', () => {
    expect(runsRouteOfHash('#/runs/run-1?view=file&step=build')).toEqual({
      kind: 'run',
      runId: 'run-1',
      place: { view: 'file', step: 'build', run: null },
    });
    expect(placeOfQuery('?view=automations&run=child-2')).toEqual({
      view: 'automations',
      step: null,
      run: 'child-2',
    });
    expect(placeOfQuery('?step=test')).toEqual({ view: 'main', step: 'test', run: null });
  });

  it('reads a view it does not know as the first, and drops an id no run could have', () => {
    expect(placeOfQuery('view=graph&step=&run=%20')).toEqual(RUN_START);
    expect(placeOfQuery(`step=${'x'.repeat(201)}`)).toEqual(RUN_START);
    expect(placeOfQuery('step=a%0Ab')).toEqual(RUN_START);
  });

  it('writes the first view with nothing chosen as nothing, and round-trips the rest', () => {
    expect(queryOfPlace(RUN_START)).toBe('');
    expect(hashOfRun('run-1')).toBe('#/runs/run-1');
    const place = { view: 'file' as const, step: 'review', run: null };
    expect(hashOfRun('run-1', place)).toBe('#/runs/run-1?view=file&step=review');
    expect(runsRouteOfHash(hashOfRun('run-1', place))).toEqual({
      kind: 'run',
      runId: 'run-1',
      place,
    });
    const automations = { view: 'automations' as const, step: null, run: 'child-2' };
    expect(hashOfRun('req-1', automations)).toBe('#/runs/req-1?view=automations&run=child-2');
  });

  it('maps an automation run’s place to its trace and back', () => {
    expect(traceOfPlace({ view: 'file', step: 'build', run: null })).toEqual({
      view: 'file',
      step: 'build',
    });
    expect(traceOfPlace({ view: 'automations', step: null, run: 'x' })).toEqual({
      view: 'steps',
      step: null,
    });
    expect(placeOfTrace({ view: 'steps', step: 'test' })).toEqual({
      view: 'main',
      step: 'test',
      run: null,
    });
  });
});
