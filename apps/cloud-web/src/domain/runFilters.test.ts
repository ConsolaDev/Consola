import { describe, expect, it } from 'vitest';
import {
  automationsOffered,
  factoriesByTeam,
  filtersOfQuery,
  hasFilters,
  isBackground,
  NO_FILTERS,
  queryOfFilters,
  SEARCH_MAX,
  toggleBackground,
  toggleMine,
  togglePhase,
  toggleTrigger,
  withAutomation,
  withFactory,
  withSearch,
  withTeam,
} from './runFilters';
import type { RunFacets } from './runs';

describe('filtersOfQuery and queryOfFilters', () => {
  it('names no filters with an empty query', () => {
    expect(filtersOfQuery('')).toEqual(NO_FILTERS);
    expect(queryOfFilters(NO_FILTERS)).toBe('');
    expect(hasFilters(NO_FILTERS)).toBe(false);
  });

  it('round-trips every filter in one order, whatever order the address had', () => {
    const query = 'q=deploy+bot&phase=needs-you&phase=active&mine=1&automation=review&factory=f-1';
    const filters = filtersOfQuery(query);
    expect(filters).toEqual({
      phases: ['active', 'needs-you'],
      factoryId: 'f-1',
      teamId: null,
      automation: 'review',
      triggers: [],
      mine: true,
      q: 'deploy bot',
    });
    expect(queryOfFilters(filters)).toBe(
      'factory=f-1&automation=review&mine=1&phase=active&phase=needs-you&q=deploy+bot',
    );
    expect(filtersOfQuery(queryOfFilters(filters))).toEqual(filters);
  });

  it('reads a leading ?', () => {
    expect(filtersOfQuery('?phase=failed').phases).toEqual(['failed']);
  });

  it('writes the three background triggers as background=1, and reads it back', () => {
    const background = toggleBackground(NO_FILTERS);
    expect(queryOfFilters(background)).toBe('background=1');
    expect(filtersOfQuery('background=1').triggers).toEqual(['cron', 'event', 'poll']);
    expect(queryOfFilters(filtersOfQuery('trigger=poll&trigger=cron'))).toBe(
      'trigger=cron&trigger=poll',
    );
  });

  it('drops what this build does not know, and repeats nothing', () => {
    const filters = filtersOfQuery('phase=paused&phase=failed&phase=failed&trigger=webhook');
    expect(filters.phases).toEqual(['failed']);
    expect(filters.triggers).toEqual([]);
  });

  it('keeps a factory over a team, which it belongs to', () => {
    const filters = filtersOfQuery('team=t-1&factory=f-1');
    expect(filters).toMatchObject({ factoryId: 'f-1', teamId: null });
    expect(filtersOfQuery('team=t-1')).toMatchObject({ factoryId: null, teamId: 't-1' });
  });

  it('settles My runs beside background triggers for My runs', () => {
    expect(filtersOfQuery('mine=1&background=1').triggers).toEqual([]);
    expect(filtersOfQuery('mine=1&trigger=manual').triggers).toEqual(['manual']);
  });

  it('ignores blank values and cuts a search to what the API takes', () => {
    expect(filtersOfQuery('factory=&team=%20&automation=')).toEqual(NO_FILTERS);
    expect(filtersOfQuery(`q=${'x'.repeat(SEARCH_MAX + 5)}`).q).toHaveLength(SEARCH_MAX);
  });

  it('writes no blank search', () => {
    expect(queryOfFilters(withSearch(NO_FILTERS, '   '))).toBe('');
  });
});

describe('the chips', () => {
  it('turns a phase on and off, keeping the chips’ order', () => {
    const one = togglePhase(NO_FILTERS, 'stopped');
    const two = togglePhase(one, 'active');
    expect(two.phases).toEqual(['active', 'stopped']);
    expect(togglePhase(two, 'active').phases).toEqual(['stopped']);
  });

  it('keeps My runs and Background runs apart', () => {
    const background = toggleBackground(NO_FILTERS);
    expect(isBackground(background)).toBe(true);
    const mine = toggleMine(background);
    expect(mine).toMatchObject({ mine: true, triggers: [] });
    const back = toggleBackground(mine);
    expect(back).toMatchObject({ mine: false, triggers: ['cron', 'event', 'poll'] });
    expect(toggleBackground(back).triggers).toEqual([]);
    expect(toggleMine(mine).mine).toBe(false);
  });

  it('keeps a person’s trigger under My runs, and turns My runs off for a background one', () => {
    const mine = toggleMine(NO_FILTERS);
    expect(toggleTrigger(mine, 'manual')).toMatchObject({ mine: true, triggers: ['manual'] });
    expect(toggleTrigger(mine, 'cron')).toMatchObject({ mine: false, triggers: ['cron'] });
    expect(toggleTrigger(toggleTrigger(mine, 'cron'), 'cron').triggers).toEqual([]);
  });

  it('is not Background runs for only some of its triggers', () => {
    expect(isBackground(toggleTrigger(NO_FILTERS, 'cron'))).toBe(false);
  });
});

describe('the factory, team and automation', () => {
  const picked = withAutomation(NO_FILTERS, { factoryId: 'f-1', name: 'review' });

  it('brings an automation’s factory with it', () => {
    expect(picked).toMatchObject({ factoryId: 'f-1', automation: 'review', teamId: null });
  });

  it('keeps the automation when its own factory is picked again, and drops it for another', () => {
    expect(withFactory(picked, 'f-1').automation).toBe('review');
    expect(withFactory(picked, 'f-2')).toMatchObject({ factoryId: 'f-2', automation: null });
    expect(withFactory(picked, null)).toMatchObject({ factoryId: null, automation: null });
  });

  it('takes a team in place of a factory', () => {
    expect(withTeam(picked, 't-1')).toMatchObject({
      teamId: 't-1',
      factoryId: null,
      automation: null,
    });
    expect(withFactory(withTeam(NO_FILTERS, 't-1'), 'f-1')).toMatchObject({
      teamId: null,
      factoryId: 'f-1',
    });
  });

  it('takes the automation off alone', () => {
    expect(withAutomation(picked, null)).toMatchObject({ factoryId: 'f-1', automation: null });
  });
});

const facets: RunFacets = {
  factories: [
    { id: 'f-2', name: 'Triage', teamId: 't-1', latestVersion: 1 },
    { id: 'f-1', name: 'Reviews', teamId: 't-1', latestVersion: 3 },
    { id: 'f-3', name: 'Billing', teamId: 't-2', latestVersion: 1 },
    { id: 'f-4', name: 'Orphan', teamId: 't-9', latestVersion: 1 },
  ],
  teams: [
    { id: 't-2', name: 'Payments' },
    { id: 't-1', name: 'Core' },
  ],
  automations: [
    { factoryId: 'f-1', name: 'review' },
    { factoryId: 'f-2', name: 'label' },
  ],
};

describe('factoriesByTeam', () => {
  it('groups the factories under their teams, both by name, and the rest at the end', () => {
    expect(
      factoriesByTeam(facets).map((group) => [
        group.team?.name ?? null,
        group.factories.map((factory) => factory.name),
      ]),
    ).toEqual([
      ['Core', ['Reviews', 'Triage']],
      ['Payments', ['Billing']],
      [null, ['Orphan']],
    ]);
  });
});

describe('automationsOffered', () => {
  it('is every automation, or the picked factory’s', () => {
    expect(automationsOffered(facets, { factoryId: null })).toHaveLength(2);
    expect(automationsOffered(facets, { factoryId: 'f-2' })).toEqual([
      { factoryId: 'f-2', name: 'label' },
    ]);
  });
});
